import { requiredBodyFields } from "../select/requiredBody.js";
import type { Feature, JsonSchema } from "../types.js";
import { FLOW_SLOT, type Flow, type FlowInput, type FlowStep, type FlowsFile } from "./types.js";

export interface ResourcePath { resource: string; kind: "list" | "item"; params: string[]; prefix: string }
const isParam = (s: string) => /^\{[^}]+\}$/.test(s);
/** 흐름 id로 쓰지 않는 이름(ui-server 경로 `/flows/infer`와 겹침). */
const RESERVED_IDS = new Set(["infer"]);

/** R1. 끝의 `{변수}`를 떼고 남은 마지막 고정 구간이 자원이다. 변수만 있는 경로는 null. */
export function parseResourcePath(p: string): ResourcePath | null {
  const segs = p.split("/").filter(Boolean);
  let i = segs.length - 1;
  const params: string[] = [];
  while (i >= 0 && isParam(segs[i]!)) { params.unshift(segs[i]!.slice(1, -1)); i--; }
  if (i < 0) return null;
  const prefix = "/" + segs.slice(0, i + 1).map((s) => (isParam(s) ? "{}" : s)).join("/");
  return { resource: segs[i]!, kind: params.length > 0 ? "item" : "list", params, prefix };
}

/** 단순 단수형: `ies` → `y`, 끝 `s` 제거. 영어 불규칙형은 다루지 않는다. */
export function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
const SCALAR = new Set(["string", "integer", "number", "boolean"]);
function isScalar(s: unknown): boolean {
  const t = (s as { type?: unknown } | null)?.type;
  return (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && SCALAR.has(x));
}
function successSchema(f: Feature): JsonSchema | null {
  const code = Object.keys(f.responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
  return code ? f.responses[code]!.schema : null;
}

/** 최상위 속성. `allOf` 구성원의 properties를 재귀로 합친다(GitHub issue 응답이 allOf, 측정 task 1). 앞선 이름이 이긴다. */
export function responseProperties(schema: JsonSchema | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (x: unknown, depth: number) => {
    if (!x || typeof x !== "object" || depth > 8) return; // 순환 표식·깊은 중첩 방어
    const o = x as { properties?: Record<string, unknown>; allOf?: unknown[] };
    for (const [k, v] of Object.entries(o.properties ?? {})) if (!(k in out)) out[k] = v;
    for (const m of o.allOf ?? []) walk(m, depth + 1);
  };
  walk(schema, 0);
  return out;
}

/** R4·R5. 맞는 최상위 스칼라 응답 필드(allOf 포함)가 정확히 하나일 때만 그 이름. */
export function linkField(param: string, singularName: string, create: Feature): string | null {
  const p = norm(param), r = norm(singularName);
  if (p === r) return null;
  const target = p === "id" || p === `${r}id` ? "id" : p.startsWith(r) ? p.slice(r.length) : p;
  if (target === "") return null;
  const props = responseProperties(successSchema(create));
  const hits = Object.entries(props).filter(([k, s]) => isScalar(s) && norm(k) === target).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}

interface Group {
  key: string; resource: string; s: string;
  listPrefix?: string; itemPath?: string; itemParams: string[];
  create?: Feature; get?: Feature; updates: Feature[]; del?: Feature;
  parent?: Group;
}

function buildGroups(features: Feature[]): Group[] {
  const byKey = new Map<string, Group>();
  const group = (key: string, resource: string) => {
    let g = byKey.get(key);
    if (!g) { g = { key, resource, s: singular(resource), itemParams: [], updates: [] }; byKey.set(key, g); }
    return g;
  };
  for (const f of features) {
    const rp = parseResourcePath(f.path);
    if (!rp) continue;
    const g = group(rp.prefix, rp.resource);
    if (rp.kind === "list") { g.listPrefix = rp.prefix; if (f.method === "POST") g.create ??= f; }
    else {
      g.itemPath = rp.prefix + "/{}".repeat(rp.params.length); g.itemParams = rp.params;
      if (f.method === "GET") g.get ??= f;
      else if (f.method === "PATCH" || f.method === "PUT") g.updates.push(f);
      else if (f.method === "DELETE") g.del ??= f;
    }
  }
  // R1 보조: 개별 경로만 있는 묶음은 같은 자원 이름의 "생성만 있는 목록 묶음"이 정확히 하나일 때 합친다.
  for (const g of [...byKey.values()]) {
    if (g.listPrefix || !g.itemPath) continue;
    const peers = [...byKey.values()].filter((o) => o !== g && o.resource === g.resource && o.create && !o.itemPath);
    if (peers.length !== 1) continue;
    const o = peers[0]!;
    Object.assign(o, { itemPath: g.itemPath, itemParams: g.itemParams, get: g.get, updates: g.updates, del: g.del });
    byKey.delete(g.key);
  }
  const groups = [...byKey.values()];
  for (const g of groups) { // R2: 가장 가까운 부모
    const own = g.listPrefix ?? g.key;
    g.parent = groups.filter((p) => p !== g && p.itemPath && own.startsWith(p.itemPath + "/")).sort((a, b) => b.itemPath!.length - a.itemPath!.length)[0];
  }
  const depth = (g: Group): number => (g.parent ? 1 + depth(g.parent) : 0);
  return groups.sort((a, b) => depth(a) - depth(b));
}

/**
 * 경로 변수 → 그 변수가 가리키는 자원(바로 앞 고정 구간)의 단수형.
 * 고정 구간 뒤에 변수가 여럿 이어지면 마지막 것만 그 자원이고, 앞의 것은 범위 변수라 주인이 없다
 * (`/repos/{owner}/{repo}`: repo → repo, owner → 없음 → target.params가 채운다).
 */
function paramOwners(p: string): Map<string, string> {
  const out = new Map<string, string>();
  let owner: string | null = null;
  let last: string | null = null;
  for (const seg of [...p.split("/").filter(Boolean), "/"]) { // "/"는 끝 표시
    if (isParam(seg)) { last = seg.slice(1, -1); continue; }
    if (owner && last) out.set(last, singular(owner));
    owner = seg; last = null;
  }
  return out;
}

function stepInputs(f: Feature, creators: Map<string, { stepId: string; feature: Feature }>): FlowInput[] {
  const owners = paramOwners(f.path);
  const inputs: FlowInput[] = [];
  for (const m of f.path.matchAll(/\{([^}]+)\}/g)) {
    const param = m[1]!;
    const s = owners.get(param);
    const c = s ? creators.get(s) : undefined;
    const field = c && s ? linkField(param, s, c.feature) : null;
    inputs.push({
      slot: `path.${param}`,
      source: field && c ? { kind: "step", step: c.stepId, field } : { kind: "empty" },
      basis: "rule",
      ...(c ? { createdBy: c.stepId } : {}), // 이 흐름이 만드는 자원: target.params가 채우지 않는다(C6)
    });
  }
  for (const b of requiredBodyFields(f)) {
    const slot = `body.${b.name}`;
    if (!FLOW_SLOT.test(slot)) continue;
    inputs.push({ slot, source: b.example === undefined ? { kind: "empty" } : { kind: "fixed", value: b.example as never }, basis: "rule" });
  }
  return inputs;
}

export interface InferResult { flows: Flow[]; notes: string[] }

/** 고른 기능에서 흐름을 추론한다(설계 §2 규칙 1~6). 순수 함수. */
export function inferFlows(features: Feature[]): InferResult {
  const groups = buildGroups(features);
  const notes: string[] = [];
  const flows: Flow[] = [];
  const usedIds = new Set<string>(RESERVED_IDS);
  for (const g of groups) {
    if (!g.create) { notes.push(`${g.resource}: 생성 기능(목록 경로의 POST)이 선택에 없어 흐름을 만들지 않았습니다.`); continue; }
    const chain: Group[] = [];
    for (let p = g.parent; p; p = p.parent) chain.unshift(p);
    const steps: FlowStep[] = [];
    const creators = new Map<string, { stepId: string; feature: Feature }>();
    const ids = new Set<string>();
    const add = (base: string, feature: Feature, role: FlowStep["role"], creates?: string) => {
      let id = base; for (let n = 2; ids.has(id); n++) id = `${base}_${n}`;
      ids.add(id);
      steps.push({ id, featureId: feature.id, role, inputs: stepInputs(feature, creators), ...(creates ? { creates } : {}) });
      if (creates) creators.set(creates, { stepId: id, feature });
    };
    for (const p of chain) if (p.create) add(`create_${p.s}`, p.create, "prep", p.s);
    add(`create_${g.s}`, g.create, "main", g.s);
    if (g.get) add(`get_${g.s}`, g.get, "main");
    const updates = [...g.updates].sort((a, b) => (a.method === b.method ? 0 : a.method === "PATCH" ? -1 : 1));
    for (const u of updates) add(`update_${g.s}`, u, "main");
    const parentDel = [...chain].reverse().find((p) => p.del && p.create); // 지우면 자식도 사라지는 가장 가까운 상위
    if (g.del) add(`delete_${g.s}`, g.del, "cleanup");
    else if (parentDel) notes.push(`${g.s}: 삭제 기능이 없어 상위 자원 ${parentDel.s}을(를) 지울 때 함께 지워진다고 봅니다. 상위 삭제가 실패하거나 정리를 끄면 "남은 자원"으로 알립니다.`);
    else notes.push(`${g.s}: 삭제 기능이 없어 실행 뒤 "남은 자원"으로 알립니다.`);
    for (const p of [...chain].reverse()) if (p.del && p.create) add(`delete_${p.s}`, p.del, "cleanup");
    let id = g.resource.replace(/[^A-Za-z0-9_-]/g, "_");
    for (let n = 2; usedIds.has(id); n++) id = `${g.resource}_${n}`;
    usedIds.add(id);
    flows.push({ id, name: `${g.s} 다루기`, resource: g.s, steps });
  }
  return { flows, notes };
}

/** R 재추론: 이전 파일의 근거 claude·user 입력은 (흐름 id, 단계 id, 자리)가 같으면 출처와 근거를 그대로 둔다. `createdBy`는 새 추론 값을 쓴다. */
export function mergeFlows(prev: FlowsFile | null, next: Flow[]): Flow[] {
  if (!prev) return next;
  const kept = new Map<string, FlowInput>();
  for (const f of prev.flows) for (const s of f.steps) for (const i of s.inputs) if (i.basis !== "rule") kept.set(`${f.id}\u0000${s.id}\u0000${i.slot}`, i);
  return next.map((f) => ({ ...f, steps: f.steps.map((s) => ({ ...s, inputs: s.inputs.map((i) => {
    const k = kept.get(`${f.id}\u0000${s.id}\u0000${i.slot}`);
    return k ? { ...i, source: k.source, basis: k.basis } : i;
  }) })) }));
}
