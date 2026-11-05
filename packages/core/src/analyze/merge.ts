import { readFile } from "node:fs/promises";
import path from "node:path";
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
import { deriveFeatureId, deriveGroup, FeatureIdRegistry } from "./featureId.js";
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

/* ---------- 스키마 정리 ---------- */

const ajv = makeAjv({ allErrors: false, logger: false });

/** LLM이 준 스키마가 ajv로 컴파일되지 않으면 null로 바꾸고 notes에 남긴다. 컴파일되면 그대로. */
function sanitizeSchema(schema: JsonSchema | null, notes: string[], where: string): JsonSchema | null {
  if (!schema) return null;
  try {
    ajv.compile(schema);
    return schema;
  } catch (e) {
    notes.push(`${where} 스키마 무시: ${(e as Error).message.split("\n")[0]}`);
    return null;
  } finally {
    // $id가 있는 스키마를 두 번 컴파일하면 "already exists"로 던지므로 캐시에서 뺀다.
    try {
      ajv.removeSchema(schema);
    } catch {
      /* 등록된 적 없으면 무시 */
    }
  }
}

/* ---------- path 정규화 ---------- */

/**
 * 문서에서 흔한 표기를 OpenAPI식 경로로 맞춘다: 스킴·호스트 제거, 쿼리·프래그먼트 제거, `:id`·`<id>` → `{id}`, 끝 슬래시 제거.
 * 결과는 항상 "/"로 시작한다. 그렇지 않거나 공백이 섞여 있으면 null(호출자가 거부한다).
 */
export function normalizePath(p: string): string | null {
  let s = p.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/:(\w+)/g, "{$1}").replace(/<(\w+)>/g, "{$1}");
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
  path: string;
  items: BucketItem[];
}

/** 같은 이름이 이미 있으면 먼저 온(신뢰도 높은) 항목을 지킨다. */
function mergeParams(target: Feature["request"]["params"], list: ExtractedEndpoint["pathParams"], notes: string[], where: string): void {
  for (const p of list) {
    if (p.name in target) continue;
    target[p.name] = { schema: sanitizeSchema(p.schema, notes, `${where}.${p.name}`), required: p.required };
  }
}

function toFeature(bucket: Bucket, registry: FeatureIdRegistry): Feature {
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

  for (const { ep, chunk, evidenceFound: f, evidenceTotal: t } of items) {
    mergeParams(request.params, ep.pathParams, notes, "pathParams");
    mergeParams(request.query, ep.queryParams, notes, "queryParams");
    mergeParams(request.headers, ep.headers, notes, "headers");
    if (!request.body && ep.requestBody) request.body = sanitizeSchema(ep.requestBody, notes, "requestBody");
    for (const r of ep.responses) {
      const key = String(r.status);
      const slot = (responses[key] ??= { schema: null, examples: [] });
      if (!slot.schema) slot.schema = sanitizeSchema(r.schema, notes, `responses.${key}`);
      if (r.example !== undefined && r.example !== null) {
        slot.examples.push({ source: "doc-sample", body: r.example });
        if (r.status >= 200 && r.status < 300) hasExample = true;
      }
    }
    for (const q of ep.evidence) evidence.push({ chunk, quote: q });
    evidenceFound += f;
    evidenceTotal += t;
  }

  // 스키마 없이 샘플만 있으면 샘플에서 유추한다(설계 5.3).
  for (const [key, slot] of Object.entries(responses)) {
    if (!slot.schema && slot.examples.length > 0) {
      slot.schema = inferSchema(slot.examples[0].body);
      notes.push(`${key} 응답 스키마는 샘플에서 유추`);
    }
  }
  // 경로 템플릿의 변수인데 pathParams에 없으면 문자열 필수로 채운다.
  for (const m of bucket.path.matchAll(/\{([^}]+)\}/g)) request.params[m[1]] ??= { schema: { type: "string" }, required: true };

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

  const tags = primary.group ? [primary.group] : undefined;
  return {
    id: registry.claim(deriveFeatureId({ method: bucket.method, path: bucket.path })),
    group: deriveGroup({ path: bucket.path, tags }),
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
 * 파일이 없거나 깨진 청크는 멈추지 않고 rejected에 기록한다.
 */
export async function merge(ws: Workspace, system: string): Promise<MergeResult> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  await pruneExtracted(ws, system, request.chunks.length);

  // 1) OpenAPI 입력은 결정적으로 먼저. id 레지스트리를 공유해 문서 추출 id가 충돌하지 않게 한다.
  const registry = new FeatureIdRegistry();
  const features: Feature[] = [];
  for (const input of source.inputs) {
    if (input.kind === "openapi") features.push(...analyzeOpenApiDocument(JSON.parse(input.content), registry));
  }
  const known = new Set(features.map((f) => `${f.method} ${f.path}`));

  // 2) extracted/NNN.json 읽기 → 항목별 스키마 검증 → path 정규화 → 근거 대조 → 버킷
  const rejected: Catalog["rejected"] = [];
  const buckets = new Map<string, Bucket>();
  const missingChunks: number[] = [];
  const invalidChunks: number[] = [];
  for (const chunk of request.chunks) {
    const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(ws.file(system, rel), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        missingChunks.push(chunk.index);
        rejected.push({ raw: null, reason: `청크 ${chunk.index} 미추출 (${rel} 없음)`, chunk: chunk.index });
      } else {
        invalidChunks.push(chunk.index);
        rejected.push({ raw: null, reason: `청크 ${chunk.index} JSON 파싱 실패: ${(e as Error).message}`, chunk: chunk.index });
      }
      continue;
    }
    const envelope = ExtractionEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      invalidChunks.push(chunk.index);
      rejected.push({ raw, reason: `청크 ${chunk.index} 스키마 불일치: endpoints 배열이 없음`, chunk: chunk.index });
      continue;
    }
    const chunkText = await readFile(ws.file(system, chunk.file), "utf8");
    for (const item of envelope.data.endpoints) {
      const parsed = ExtractedEndpointSchema.safeParse(item);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join(".") || "(root)";
        rejected.push({ raw: item, reason: `항목 스키마 불일치: ${where} ${issue?.message ?? ""}`.trimEnd(), chunk: chunk.index });
        continue;
      }
      const ep = parsed.data;
      const p = normalizePath(ep.path);
      if (!p) {
        rejected.push({ raw: item, reason: `path 형식 불일치: '${ep.path}'`, chunk: chunk.index });
        continue;
      }
      const key = `${ep.method} ${p}`;
      if (known.has(key)) continue; // OpenAPI가 우선
      const ev = verifyEvidence(ep.evidence, chunkText);
      const b = buckets.get(key) ?? { method: ep.method, path: p, items: [] };
      b.items.push({ ep: { ...ep, path: p }, chunk: chunk.index, evidenceFound: ev.found, evidenceTotal: ev.total });
      buckets.set(key, b);
    }
  }

  // 3) 버킷 → Feature. 키 순서를 고정해 id 접미사(…2, …3)가 실행마다 같게 한다.
  for (const key of [...buckets.keys()].sort()) features.push(toFeature(buckets.get(key)!, registry));

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
