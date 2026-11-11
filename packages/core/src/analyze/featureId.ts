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

export function deriveFeatureId(input: { method: HttpMethod; path: string; operationId?: string }): string {
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
      case "POST": return endsWithParam ? "update" : "create";
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
