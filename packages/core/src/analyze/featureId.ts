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
 * `siblingMethods`는 같은 경로 모양에 있는 메서드들. PUT/PATCH가 있으면 끝이 변수인 POST도 `update`가 아니라 `create`로 남긴다
 * (`update`는 PUT/PATCH가 차지한다). 생략하면 형제가 없는 것으로 본다.
 */
export function deriveFeatureId(input: { method: HttpMethod; path: string; operationId?: string; siblingMethods?: ReadonlySet<HttpMethod> }): string {
  if (input.operationId && input.operationId.trim().length > 0) {
    const id = sanitize(input.operationId.trim());
    if (hasAlnum(id)) return id;
  }
  const segs = segments(input.path);
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
