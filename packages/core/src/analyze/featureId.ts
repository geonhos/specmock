import type { HttpMethod } from "../types.js";

const PARAM = /^\{.+\}$/;

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export function staticSegments(path: string): string[] {
  return segments(path).filter((s) => !PARAM.test(s));
}

export function deriveFeatureId(input: { method: HttpMethod; path: string; operationId?: string }): string {
  if (input.operationId && input.operationId.trim().length > 0) {
    return input.operationId.trim().replace(/[^A-Za-z0-9_.-]/g, "_");
  }
  const segs = segments(input.path);
  const statics = staticSegments(input.path);
  const resource = statics.length > 0 ? statics[statics.length - 1] : "root";
  const endsWithParam = segs.length > 0 && PARAM.test(segs[segs.length - 1]);
  const action = (() => {
    switch (input.method) {
      case "GET": return endsWithParam ? "get" : "list";
      case "POST": return "create";
      case "PUT":
      case "PATCH": return "update";
      case "DELETE": return "delete";
      default: return input.method.toLowerCase();
    }
  })();
  return `${resource}.${action}`;
}

export function deriveGroup(input: { path: string; tags?: string[] }): string {
  if (input.tags && input.tags.length > 0 && input.tags[0].trim()) return input.tags[0].trim();
  const statics = staticSegments(input.path);
  return statics.length > 0 ? statics[0] : "root";
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
