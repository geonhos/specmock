import type { HttpMethod } from "../types.js";

const PARAM = /\{[^}]+\}/;
const VERSION_PREFIX = /^(v\d+(\.\d+)*|api)$/i;

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[-.]+/, "").replace(/_{2,}/g, "_");
}

function hasAlnum(s: string): boolean {
  return /[A-Za-z0-9]/.test(s);
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

// A segment starting with a template (`{id}`, `{id}.json`) is a parameter.
// A segment with a literal prefix before a template (`posts.{format}`) is a
// resource whose name is that prefix.
function isParamSegment(s: string): boolean {
  return PARAM.test(s) && s.startsWith("{");
}

function segmentName(s: string): string {
  const i = s.indexOf("{");
  return i < 0 ? s : s.slice(0, i).replace(/[.\-_]+$/, "");
}

export function staticSegments(path: string): string[] {
  return segments(path)
    .filter((s) => !isParamSegment(s))
    .map(segmentName)
    .filter((s) => s.length > 0);
}

/** 경로 변수 이름을 지운 꼴(`/v1/customers/{}`). 병합 bucket 키와 같은 경로 판정에 쓴다. */
export function pathShape(p: string): string {
  return p.replace(/\{[^}]*\}/g, "{}");
}

/** 모양(pathShape)별로 쓰인 메서드 집합. POST의 id 동작(create/update)을 정할 때 쓴다. */
export function methodsByShape(entries: Iterable<{ method: HttpMethod; path: string }>): Map<string, Set<HttpMethod>> {
  const out = new Map<string, Set<HttpMethod>>();
  for (const { method, path } of entries) {
    const key = pathShape(path);
    const set = out.get(key) ?? new Set<HttpMethod>();
    set.add(method);
    out.set(key, set);
  }
  return out;
}

/**
 * 하위 동작 규칙(카탈로그의 경로 모양 집합 `shapes`가 있을 때만):
 * - POST `/<r>/{v}/<x>`: 부모 모양 `/<r>/{}`가 있고 자기 모양에 GET이 없으면 `<r>.<x>`(`payment_intents.cancel`). GET이 있으면 하위 컬렉션이라 현행(`sources.create`).
 * - GET `/<r>/<x>`(앞이 정적): 부모 경로 `/<r>`가 있고 `<r>`가 리소스라는 근거(단건 모양 `/<r>/{}`)가 있으면 `<r>.<x>`(`customers.search`).
 *   `/api`·`/v1`처럼 단건 경로가 없는 접두이거나 부모가 없으면 현행(`users.list`, `inventory.list`).
 */
function subActionId(method: HttpMethod, segs: string[], shapes: ReadonlyMap<string, ReadonlySet<HttpMethod>>, path: string): string | null {
  if (segs.length < 2) return null;
  const last = segs[segs.length - 1];
  const prev = segs[segs.length - 2];
  if (isParamSegment(last) || PARAM.test(last)) return null;
  const x = sanitize(segmentName(last));
  if (!x) return null;
  const parent = pathShape("/" + segs.slice(0, -1).join("/"));
  if (!shapes.has(parent)) return null;
  if (method === "POST" && isParamSegment(prev)) {
    if (shapes.get(pathShape(path))?.has("GET")) return null;
    const r = staticSegments("/" + segs.slice(0, -2).join("/")).at(-1);
    return r ? `${sanitize(r) || "root"}.${x}` : null;
  }
  if (method === "GET" && !isParamSegment(prev)) {
    const r = segmentName(prev);
    if (!shapes.has(pathShape("/" + segs.slice(0, -1).join("/") + "/{}"))) return null;
    return r ? `${sanitize(r) || "root"}.${x}` : null;
  }
  return null;
}

/**
 * `siblingMethods`는 같은 경로 모양에 있는 메서드들. PUT/PATCH가 있으면 끝이 변수인 POST도 `update`가 아니라 `create`로 남긴다
 * (`update`는 PUT/PATCH가 차지한다). 생략하면 형제가 없는 것으로 본다.
 */
export function deriveFeatureId(input: {
  method: HttpMethod;
  path: string;
  operationId?: string;
  siblingMethods?: ReadonlySet<HttpMethod>;
  shapes?: ReadonlyMap<string, ReadonlySet<HttpMethod>>;
}): string {
  if (input.operationId && input.operationId.trim().length > 0) {
    const id = sanitize(input.operationId.trim());
    if (hasAlnum(id)) return id;
  }
  const segs = segments(input.path);
  const sub = input.shapes ? subActionId(input.method, segs, input.shapes, input.path) : null;
  if (sub) return sub;
  const statics = staticSegments(input.path);
  const resource = statics.length > 0 ? statics[statics.length - 1] : "root";
  const endsWithParam = segs.length > 0 && isParamSegment(segs[segs.length - 1]);
  const action = (() => {
    switch (input.method) {
      case "GET": return endsWithParam ? "get" : "list";
      case "POST": return endsWithParam && !input.siblingMethods?.has("PUT") && !input.siblingMethods?.has("PATCH") ? "update" : "create";
      case "PUT":
      case "PATCH": return "update";
      case "DELETE": return "delete";
      default: return input.method.toLowerCase();
    }
  })();
  return `${sanitize(resource) || "root"}.${action}`;
}

export function deriveGroup(input: { path: string; tags?: string[] }): string {
  const tag = input.tags?.find((t) => t.trim());
  if (tag) return tag.trim();
  const statics = staticSegments(input.path);
  let i = 0;
  while (i < statics.length - 1 && VERSION_PREFIX.test(statics[i])) i += 1;
  return statics.length > 0 ? statics[i] : "root";
}

export class FeatureIdRegistry {
  private readonly taken = new Set<string>();

  claim(candidate: string): string {
    if (!this.taken.has(candidate)) {
      this.taken.add(candidate);
      return candidate;
    }
    let n = 2;
    while (this.taken.has(`${candidate}${n}`)) n += 1;
    const id = `${candidate}${n}`;
    this.taken.add(id);
    return id;
  }
}
