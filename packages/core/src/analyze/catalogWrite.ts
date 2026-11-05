import { CatalogDiffSchema, CatalogSchema, type Catalog, type CatalogDiff } from "../types.js";
import type { Workspace } from "../workspace.js";
import { diffCatalogs } from "./diff.js";

/**
 * 이전 catalog.json이 있으면 id 기준으로 비교한 결과를 catalog-diff.json에 남기고 덮어쓴다.
 * analyze(OpenAPI 경로)와 merge(문서 추출 경로)가 둘 다 이 함수로 카탈로그를 쓴다.
 */
export async function writeCatalogWithDiff(ws: Workspace, system: string, next: Catalog): Promise<CatalogDiff> {
  const prev = (await ws.exists(system, "catalog.json")) ? await ws.read(system, "catalog.json", CatalogSchema) : null;
  const diff = diffCatalogs(prev, next);
  await ws.write(system, "catalog.json", CatalogSchema, next);
  await ws.write(system, "catalog-diff.json", CatalogDiffSchema, diff);
  return diff;
}
