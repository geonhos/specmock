import type { Catalog, Feature, HttpMethod } from "../types.js";

const METHOD_ORDER: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface OrderedFeature {
  index: number; // 1부터
  feature: Feature;
}

export function orderFeatures(catalog: Pick<Catalog, "features">): OrderedFeature[] {
  const sorted = [...catalog.features].sort((a, b) =>
    a.group.localeCompare(b.group) ||
    a.path.localeCompare(b.path) ||
    METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  return sorted.map((feature, i) => ({ index: i + 1, feature }));
}
