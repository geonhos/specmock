import type { Catalog, CatalogDiff } from "../types.js";
import { hashJson } from "../util/hash.js";

/** confidence만 달라진 기능은 "바뀐 기능"으로 세지 않는다. 근거 대조 결과가 실행마다 미세하게 흔들려도 diff가 조용하도록. */
function fingerprint(f: Catalog["features"][number]): string {
  return hashJson({ ...f, confidence: undefined });
}

/** 이전 카탈로그와 id 기준으로 비교한다. 이전이 없으면 모두 "새 기능"이다. */
export function diffCatalogs(prev: Catalog | null, next: Catalog): CatalogDiff {
  if (!prev) return { previousAt: null, added: next.features.map((f) => f.id).sort(), removed: [], changed: [] };
  const a = new Map(prev.features.map((f) => [f.id, fingerprint(f)]));
  const b = new Map(next.features.map((f) => [f.id, fingerprint(f)]));
  return {
    previousAt: prev.generatedAt,
    added: [...b.keys()].filter((id) => !a.has(id)).sort(),
    removed: [...a.keys()].filter((id) => !b.has(id)).sort(),
    changed: [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id)).sort(),
  };
}
