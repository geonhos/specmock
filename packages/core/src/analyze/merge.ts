import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Ajv } from "ajv";
import { z } from "zod";
import {
  AnalyzeRequestSchema,
  ExtractedEndpointSchema,
  SourceSchema,
  type Catalog,
  type CatalogDiff,
  type ExtractedEndpoint,
  type Feature,
  type HttpMethod,
  type JsonSchema,
} from "../types.js";
import { makeAjv } from "../util/ajv.js";
import type { Workspace } from "../workspace.js";
import { writeCatalogWithDiff } from "./catalogWrite.js";
import { deriveFeatureId, deriveGroup, FeatureIdRegistry, methodsByShape, pathShape } from "./featureId.js";
import { inferSchema } from "./inferSchema.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { EXTRACTED_DIR, extractedFileName, pruneExtracted } from "./prepare.js";

/* ---------- 근거 대조 ---------- */

/** 인용과 원문을 같은 꼴로 만든다: 소문자, 마크다운 기호(백틱·강조·인용·헤딩·표) 제거, 공백 하나로. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[`*_>#|]/g, "").replace(/\s+/g, " ").trim();
}

/** 8자 미만 인용은 우연히 맞을 수 있어 세지 않는다(프롬프트 규칙 6과 같은 기준). */
const MIN_QUOTE_CHARS = 8;

export function verifyEvidence(quotes: string[], chunkText: string): { found: number; total: number } {
  const hay = normalize(chunkText);
  let found = 0;
  for (const q of quotes) {
    const needle = normalize(q);
    if (needle.length >= MIN_QUOTE_CHARS && hay.includes(needle)) found += 1;
  }
  return { found, total: quotes.length };
}

/* ---------- 신뢰도 보정 (설계 3.2 표) ---------- */

export interface ConfidenceSignals {
  evidenceFound: number;
  evidenceTotal: number;
  hasExample: boolean;
  inferred: boolean;
}

/**
 * 근거 없음 ×0.7, 근거 전부 불일치 ×0.3, 2xx 예시 있음 +0.1(최대 1), method/path 추론은 0.5 상한.
 * 소수 둘째 자리로 반올림한다.
 */
export function adjustConfidence(raw: number, s: ConfidenceSignals): number {
  let c = raw;
  if (s.evidenceTotal === 0) c *= 0.7;
  else if (s.evidenceFound === 0) c *= 0.3;
  if (s.hasExample) c = Math.min(1, c + 0.1);
  if (s.inferred) c = Math.min(c, 0.5);
  return Math.round(c * 100) / 100;
}

/* ---------- 깊이 제한 ---------- */

/** 저장하는 샘플·raw 값의 최대 중첩 깊이. 이보다 깊은 부분은 문자열 표식으로 바꿔 hashJson·JSON.stringify가 스택을 넘지 않게 한다. */
export const MAX_VALUE_DEPTH = 64;
export const DEPTH_MARKER = "[specmock: 깊이 초과로 생략]";

export function clampDepth(value: unknown, max = MAX_VALUE_DEPTH, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= max) return DEPTH_MARKER;
  if (Array.isArray(value)) return value.map((v) => clampDepth(v, max, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clampDepth(v, max, depth + 1)]));
}

/* ---------- 스키마 정리 ---------- */

/**
 * LLM이 준 스키마가 ajv로 컴파일되지 않으면 null로 바꾸고 notes에 남긴다. 컴파일되면 원본 그대로 돌려준다.
 * 컴파일은 복사본으로 하고 루트 `$id`·`$schema`는 뗀다. `$id`가 ajv 메타스키마 등과 겹치면 "already exists"로 실패하고,
 * 모르는 `$schema`는 "no schema with key or ref"로 실패하는데, 둘 다 스키마 본문의 문제가 아니다.
 */
function sanitizeSchema(ajv: Ajv, schema: JsonSchema | null, notes: string[], where: string): JsonSchema | null {
  if (!schema) return null;
  const { $id: _id, $schema: _meta, ...body } = schema;
  try {
    ajv.compile(body);
    return schema;
  } catch (e) {
    notes.push(`${where} 스키마 무시: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

/* ---------- path 정규화 ---------- */

/** 경로 변수 이름: 전부 대문자(`CUSTOMER_ID`)면 소문자로 내린다. `petId` 같은 camelCase와 이미 소문자인 이름은 그대로 둔다. */
export function normalizeVarName(name: string): string {
  return name === name.toUpperCase() && /[A-Z]/.test(name) ? name.toLowerCase() : name;
}

function pathVars(p: string): string[] {
  return [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * 문서에서 흔한 표기를 OpenAPI식 경로로 맞춘다: 스킴·호스트 제거, 쿼리·프래그먼트 제거, 세그먼트 단위 `:id`·`<id>` → `{id}`, `{{ID}}` → `{id}`, 전부 대문자인 변수 이름(`{CUSTOMER_ID}`)은 소문자로(camelCase `{petId}`는 유지), 끝 슬래시 제거.
 * `/resources:batchGet` 같은 세그먼트 안의 콜론은 건드리지 않는다.
 * 결과는 항상 "/"로 시작한다. 그렇지 않거나 공백이 섞여 있으면 null(호출자가 거부한다).
 */
export function normalizePath(p: string): string | null {
  let s = p.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/:(\w+)(?=\/|$)/g, "/{$1}").replace(/\/<(\w+)>(?=\/|$)/g, "/{$1}");
  s = s.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, "{$1}");
  s = s.replace(/\{([^{}]+)\}/g, (_m, name: string) => `{${normalizeVarName(name)}}`);
  if (!s.startsWith("/")) return null;
  if (/\s/.test(s)) return null;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

/* ---------- 병합 ---------- */

interface BucketItem {
  ep: ExtractedEndpoint;
  chunk: number;
  evidenceFound: number;
  evidenceTotal: number;
}

interface Bucket {
  method: HttpMethod;
  /** 대표 경로: 메서드가 명시된 항목 우선, 그다음 신뢰도 높은 것, 동률이면 먼저 나온 것. */
  path: string;
  items: BucketItem[];
}

/** 레코드에 own property로 넣는다. 이름이 "__proto__"여도 프로토타입을 바꾸지 않는다. */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** 같은 이름이 이미 있으면 먼저 온(신뢰도 높은) 항목을 지킨다. */
function mergeParams(ajv: Ajv, target: Feature["request"]["params"], list: ExtractedEndpoint["pathParams"], notes: string[], where: string): void {
  for (const p of list) {
    if (Object.hasOwn(target, p.name)) continue;
    setOwn(target, p.name, { schema: sanitizeSchema(ajv, p.schema, notes, `${where}.${p.name}`), required: p.required });
  }
}

/**
 * 같은 기능(bucket)의 body 스키마를 합친다. 최상위가 object이고 properties가 있는 body끼리는 속성 이름의 합집합,
 * required도 합집합(합친 속성에 있는 이름만). 같은 이름의 속성은 먼저 온(신뢰도 높은) 쪽을 지킨다.
 * object가 아닌 body는 합치지 않고, 첫 body가 object가 아니면 첫 것만 쓴다.
 */
function unionBodies(bodies: JsonSchema[]): JsonSchema | null {
  if (bodies.length === 0) return null;
  const isObj = (b: JsonSchema): boolean => b.type === "object" && typeof b.properties === "object" && b.properties !== null && !Array.isArray(b.properties);
  const [first, ...rest] = bodies;
  if (!isObj(first)) return first;
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const b of [first, ...rest]) {
    if (!isObj(b)) continue;
    for (const [k, v] of Object.entries(b.properties as Record<string, unknown>)) if (!Object.hasOwn(properties, k)) setOwn(properties, k, v);
    if (Array.isArray(b.required)) for (const r of b.required) if (typeof r === "string") required.add(r);
  }
  const names = [...required].filter((r) => Object.hasOwn(properties, r));
  const { required: _r, ...base } = first;
  return { ...base, properties, ...(names.length > 0 ? { required: names } : {}) };
}

function toFeature(ajv: Ajv, bucket: Bucket, registry: FeatureIdRegistry, groupOf: (g: string) => string, siblings: ReadonlyMap<string, ReadonlySet<HttpMethod>>): Feature {
  const notes: string[] = [];
  const items = [...bucket.items].sort((a, b) => b.ep.confidence - a.ep.confidence);
  const primary = items[0].ep;
  const methodInferred = items.some((i) => i.ep.inferred.method);
  const pathInferred = items.some((i) => i.ep.inferred.path);
  if (methodInferred) notes.push("method 추론됨");
  if (pathInferred) notes.push("path 추론됨");

  const request: Feature["request"] = { params: {}, query: {}, headers: {}, body: null };
  const responses: Feature["responses"] = {};
  const evidence: Feature["evidence"] = [];
  let evidenceFound = 0;
  let evidenceTotal = 0;
  let hasExample = false;

  const bodies: JsonSchema[] = [];
  const repVars = pathVars(bucket.path);
  for (const { ep, chunk, evidenceFound: f, evidenceTotal: t } of items) {
    // 변수 이름이 다른 경로(`{CUSTOMER_ID}`)에서 온 항목은 대표 경로의 변수 이름(위치 기준)으로 맞춘다.
    const own = pathVars(ep.path);
    const pathParams = ep.pathParams.map((pp) => {
      const i = own.findIndex((v) => v === pp.name || v === normalizeVarName(pp.name));
      return i >= 0 && i < repVars.length ? { ...pp, name: repVars[i] } : pp;
    });
    mergeParams(ajv, request.params, pathParams, notes, "pathParams");
    mergeParams(ajv, request.query, ep.queryParams, notes, "queryParams");
    mergeParams(ajv, request.headers, ep.headers, notes, "headers");
    if (ep.requestBody) {
      const body = sanitizeSchema(ajv, ep.requestBody, notes, "requestBody");
      if (body) bodies.push(body);
    }
    for (const r of ep.responses) {
      const key = String(r.status);
      if (!Object.hasOwn(responses, key)) setOwn(responses, key, { schema: null, examples: [] });
      const slot = responses[key];
      if (!slot.schema) slot.schema = sanitizeSchema(ajv, r.schema, notes, `responses.${key}`);
      if (r.example !== undefined && r.example !== null) {
        slot.examples.push({ source: "doc-sample", body: r.example });
        if (r.status >= 200 && r.status < 300) hasExample = true;
      }
    }
    for (const q of ep.evidence) evidence.push({ chunk, quote: q });
    evidenceFound += f;
    evidenceTotal += t;
  }

  request.body = unionBodies(bodies);
  if (request.body && bodies.length > 1) request.body = sanitizeSchema(ajv, request.body, notes, "requestBody");

  // 스키마 없이 샘플만 있으면 샘플에서 유추한다(설계 5.3).
  for (const [key, slot] of Object.entries(responses)) {
    if (!slot.schema && slot.examples.length > 0) {
      slot.schema = inferSchema(slot.examples[0].body);
      notes.push(`${key} 응답 스키마는 샘플에서 유추`);
    }
  }
  // 경로 템플릿의 변수인데 pathParams에 없으면 문자열 필수로 채운다.
  for (const m of bucket.path.matchAll(/\{([^}]+)\}/g)) {
    if (!Object.hasOwn(request.params, m[1])) setOwn(request.params, m[1], { schema: { type: "string" }, required: true });
  }

  const missed = evidenceTotal - evidenceFound;
  if (evidenceTotal === 0) notes.push("근거 인용 없음");
  else if (evidenceFound === 0) notes.push(`근거 불일치: 인용 ${evidenceTotal}건 중 ${missed}건을 원문에서 찾지 못함`);
  else if (missed > 0) notes.push(`근거 일부 불일치: 인용 ${evidenceTotal}건 중 ${missed}건을 원문에서 찾지 못함`);

  const anyInferred = methodInferred || pathInferred;
  const confidence = adjustConfidence(Math.max(...items.map((i) => i.ep.confidence)), {
    evidenceFound,
    evidenceTotal,
    hasExample,
    inferred: anyInferred,
  });

  const tags = primary.group ? [groupOf(primary.group)] : undefined;
  return {
    id: registry.claim(deriveFeatureId({ method: bucket.method, path: bucket.path, siblingMethods: siblings.get(pathShape(bucket.path)) })),
    group: groupOf(deriveGroup({ path: bucket.path, tags })),
    title: primary.title || `${bucket.method} ${bucket.path}`,
    summary: items.map((i) => i.ep.summary).find((s) => s) ?? "",
    method: bucket.method,
    path: bucket.path,
    request,
    responses,
    auth: items.map((i) => i.ep.auth).find((a) => a !== "unknown") ?? "unknown",
    provenance: anyInferred ? "inferred" : "doc-extracted",
    confidence,
    hasExample,
    evidence,
    notes,
  };
}

/** extracted/NNN.json의 바깥 모양만 본다. 항목은 하나씩 따로 검증해 하나가 깨져도 나머지를 살린다. */
const ExtractionEnvelopeSchema = z.object({ endpoints: z.array(z.unknown()) });

/** JSON 파싱 실패 시 rejected.raw에 남길 원문 길이. */
const RAW_TEXT_PREVIEW = 500;

/** 파싱된 항목에서 저장될 자유 값(샘플·요청 예시)의 깊이를 제한한다. */
function clampEndpoint(ep: ExtractedEndpoint): ExtractedEndpoint {
  return {
    ...ep,
    requestExample: clampDepth(ep.requestExample),
    responses: ep.responses.map((r) => ({ ...r, example: clampDepth(r.example) })),
  };
}

export interface MergeResult {
  catalogFile: string;
  features: number;
  rejected: number;
  /** extracted 파일이 없는 청크 번호. */
  missingChunks: number[];
  /** JSON이 아니거나 `{ endpoints: [...] }` 모양이 아닌 청크 번호. 개별 항목 불일치는 rejected에만 남는다. */
  invalidChunks: number[];
  diff: CatalogDiff;
}

/**
 * `extracted/NNN.json`(LLM 출력)을 검증·정규화·근거 대조·신뢰도 보정해 method+path 기준으로 합치고,
 * OpenAPI 입력에서 결정적으로 뽑은 기능과 함께 catalog.json을 쓴다. 같은 method+path면 OpenAPI가 이긴다.
 * 파일이 없거나 깨진 청크, 변환에 실패한 기능은 멈추지 않고 rejected에 기록한다.
 */
export async function merge(ws: Workspace, system: string): Promise<MergeResult> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  await pruneExtracted(ws, system, request.chunks.length);
  // 호출마다 새 Ajv. 컴파일 실패가 남긴 상태가 다음 스키마나 다음 merge에 번지지 않게 한다.
  const ajv = makeAjv({ allErrors: false, logger: false });

  // 1) OpenAPI 입력은 결정적으로 먼저. id 레지스트리를 공유해 문서 추출 id가 충돌하지 않게 한다.
  const registry = new FeatureIdRegistry();
  const features: Feature[] = [];
  for (const input of source.inputs) {
    if (input.kind === "openapi") features.push(...analyzeOpenApiDocument(JSON.parse(input.content), registry));
  }
  // 문서 쪽 path와 같은 규칙으로 정규화해 비교한다(`/pets/` vs `/pets`).
  const shapeOf = (p: string): string => pathShape(normalizePath(p) ?? p);
  const known = new Set(features.map((f) => `${f.method} ${shapeOf(f.path)}`));

  // 2) extracted/NNN.json 읽기 → 항목별 스키마 검증 → path 정규화 → 근거 대조 → 버킷
  const rejected: Catalog["rejected"] = [];
  const reject = (raw: unknown, reason: string, chunk: number): void => {
    rejected.push({ raw: clampDepth(raw), reason, chunk });
  };
  const buckets = new Map<string, Bucket>();
  const missingChunks: number[] = [];
  const invalidChunks: number[] = [];
  for (const chunk of request.chunks) {
    const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
    let text: string;
    try {
      text = await readFile(ws.file(system, rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missingChunks.push(chunk.index);
      reject(null, `청크 ${chunk.index} 미추출 (${rel} 없음)`, chunk.index);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      invalidChunks.push(chunk.index);
      reject(text.slice(0, RAW_TEXT_PREVIEW), `청크 ${chunk.index} JSON 파싱 실패: ${(e as Error).message}`, chunk.index);
      continue;
    }
    const envelope = ExtractionEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      invalidChunks.push(chunk.index);
      reject(raw, `청크 ${chunk.index} 스키마 불일치: endpoints 배열이 없음`, chunk.index);
      continue;
    }
    const chunkText = await readFile(ws.file(system, chunk.file), "utf8");
    for (const item of envelope.data.endpoints) {
      const parsed = ExtractedEndpointSchema.safeParse(item);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join(".") || "(root)";
        reject(item, `항목 스키마 불일치: ${where} ${issue?.message ?? ""}`.trimEnd(), chunk.index);
        continue;
      }
      const ep = clampEndpoint(parsed.data);
      const p = normalizePath(ep.path);
      if (!p) {
        reject(item, `path 형식 불일치: '${ep.path}'`, chunk.index);
        continue;
      }
      const key = `${ep.method} ${pathShape(p)}`;
      if (known.has(key)) continue; // OpenAPI가 우선
      const ev = verifyEvidence(ep.evidence, chunkText);
      const b = buckets.get(key) ?? { method: ep.method, path: p, items: [] };
      const better = (a: ExtractedEndpoint, base: ExtractedEndpoint): boolean =>
        a.inferred.method !== base.inferred.method ? !a.inferred.method : a.confidence > base.confidence;
      if (b.items.length > 0 && better(ep, b.items.find((i) => i.ep.path === b.path)!.ep)) b.path = p;
      b.items.push({ ep: { ...ep, path: p }, chunk: chunk.index, evidenceFound: ev.found, evidenceTotal: ev.total });
      buckets.set(key, b);
    }
  }

  // group은 대소문자를 무시하고 묶어 대표 철자 하나로 통일한다. OpenAPI 태그 철자가 있으면 그것이 대표
  // (스펙 원문이라 문서 추출보다 권위가 높고, 문서를 추가해도 OpenAPI 기능의 group이 바뀌지 않는다).
  // 없으면 가장 많이 나온 철자, 동률이면 먼저 나온 것. 경로에서 파생한 group도 같은 규칙으로 묶는다.
  const spellings = new Map<string, Map<string, number>>();
  const specSpellings = new Map<string, Map<string, number>>();
  const countSpelling = (raw: string, into: Map<string, Map<string, number>> = spellings): void => {
    const g = raw.trim();
    if (!g) return;
    const m = into.get(g.toLowerCase()) ?? new Map<string, number>();
    m.set(g, (m.get(g) ?? 0) + 1);
    into.set(g.toLowerCase(), m);
  };
  for (const f of features) {
    countSpelling(f.group);
    countSpelling(f.group, specSpellings);
  }
  for (const key of [...buckets.keys()]) {
    const bucket = buckets.get(key)!;
    for (const { ep } of bucket.items) countSpelling(ep.group);
    if (!bucket.items.some((i) => i.ep.group.trim())) countSpelling(deriveGroup({ path: bucket.path }));
  }
  const canonical = new Map<string, string>();
  for (const [lower, all] of spellings) {
    const m = specSpellings.get(lower) ?? all;
    let best = "";
    let bestN = 0;
    for (const [g, n] of m) if (n > bestN) [best, bestN] = [g, n];
    canonical.set(lower, best);
  }
  const groupOf = (g: string): string => canonical.get(g.trim().toLowerCase()) ?? g;
  for (const f of features) f.group = groupOf(f.group);
  const siblings = methodsByShape(
    [...features, ...buckets.values()].map((e) => ({ method: e.method, path: normalizePath(e.path) ?? e.path })),
  );

  // 3) 버킷 → Feature. 키 순서를 고정해 id 접미사(…2, …3)가 실행마다 같게 한다. 하나가 실패해도 나머지는 계속.
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!;
    try {
      features.push(toFeature(ajv, bucket, registry, groupOf, siblings));
    } catch (e) {
      const chunk = bucket.items[0].chunk;
      reject(bucket.items.map((i) => i.ep), `기능 변환 실패 (${key}): ${(e as Error).message}`, chunk);
    }
  }

  const catalog: Catalog = { system, generatedAt: new Date().toISOString(), features, rejected };
  const diff = await writeCatalogWithDiff(ws, system, catalog);
  return {
    catalogFile: ws.file(system, "catalog.json"),
    features: features.length,
    rejected: rejected.length,
    missingChunks,
    invalidChunks,
    diff,
  };
}
