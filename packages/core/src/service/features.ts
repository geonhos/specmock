import { formatCatalog } from "../catalog/format.js";
import { orderFeatures } from "../catalog/order.js";
import { CatalogSchema, type Feature } from "../types.js";
import type { Workspace } from "../workspace.js";

export interface FeatureRow {
  /** `specmock list`/선택 표현식과 같은 1부터의 전체 번호. */
  index: number;
  id: string; group: string; method: Feature["method"]; path: string;
  provenance: Feature["provenance"]; confidence: number; hasExample: boolean;
  /** Feature.notes. 표의 ⚠ 열과 같은 내용. */
  warnings: string[];
}
export interface ListFeaturesResult { system: string; total: number; group: string | null; table: string; rows: FeatureRow[] }

export async function findFeature(ws: Workspace, system: string, id: string): Promise<Feature> {
  const catalog = await ws.read(system, "catalog.json", CatalogSchema);
  const f = catalog.features.find((x) => x.id === id);
  if (!f) throw new Error(`알 수 없는 기능 id: ${id}`);
  return f;
}

export async function listFeatures(ws: Workspace, system: string, opts: { group?: string } = {}): Promise<ListFeaturesResult> {
  const catalog = await ws.read(system, "catalog.json", CatalogSchema);
  if (opts.group !== undefined && !catalog.features.some((f) => f.group === opts.group)) {
    throw new Error(`알 수 없는 그룹: ${opts.group} (${[...new Set(catalog.features.map((f) => f.group))].join(", ")})`);
  }
  const rows = orderFeatures(catalog)
    .filter((o) => opts.group === undefined || o.feature.group === opts.group)
    .map(({ index, feature: f }) => ({
      index, id: f.id, group: f.group, method: f.method, path: f.path,
      provenance: f.provenance, confidence: f.confidence, hasExample: f.hasExample, warnings: f.notes,
    }));
  return { system, total: catalog.features.length, group: opts.group ?? null, table: formatCatalog(catalog, { group: opts.group }), rows };
}
