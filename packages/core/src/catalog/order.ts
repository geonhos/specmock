import { HttpMethod } from "../types.js";
import type { Catalog, Feature } from "../types.js";

const METHOD_ORDER: readonly HttpMethod[] = HttpMethod.options;

// 선택 번호는 이 순서에 의존하므로 로케일/ICU 버전과 무관하게 항상 같아야 한다. localeCompare 대신 코드포인트 비교.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface OrderedFeature {
  index: number; // 1부터
  feature: Feature;
}

export function orderFeatures(catalog: Pick<Catalog, "features">): OrderedFeature[] {
  const sorted = [...catalog.features].sort((a, b) =>
    cmp(a.group, b.group) ||
    cmp(a.path, b.path) ||
    METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  return sorted.map((feature, i) => ({ index: i + 1, feature }));
}
