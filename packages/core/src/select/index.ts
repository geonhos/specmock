import { CatalogSchema, MockSpecSchema, SelectionSchema, type Contract, type MockFeature, type MockSpec } from "../types.js";
import { hashJson } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { buildContracts } from "./contracts.js";
import { resolveSelection } from "./expression.js";
import { buildFixtures } from "./fixtures.js";

export interface SelectOptions {
  add?: boolean;
  remove?: boolean;
  language?: MockSpec["language"];
}

export interface SelectResult {
  selected: string[];
  resolved: string[];
  selectionFile: string;
  mockspecFile: string;
  catalogChanged: boolean;
}

export async function select(ws: Workspace, system: string, exprs: string[], opts: SelectOptions = {}): Promise<SelectResult> {
  const catalog = await ws.read(system, "catalog.json", CatalogSchema);
  const catalogHash = hashJson(catalog.features);

  let selected = [...exprs];
  let catalogChanged = false;
  if ((opts.add || opts.remove) && (await ws.exists(system, "selection.json"))) {
    const prev = await ws.read(system, "selection.json", SelectionSchema);
    catalogChanged = prev.catalogHash !== catalogHash;
    selected = opts.add ? [...prev.selected, ...exprs] : [...prev.selected, ...exprs.map((e) => `-${e}`)];
  }

  const resolved = await resolveSelection(catalog, selected);
  if (resolved.length === 0) throw new Error("선택 결과가 비어 있습니다. 표현식을 확인하세요.");

  const byId = new Map(catalog.features.map((f) => [f.id, f]));
  const features: MockFeature[] = [];
  const contracts: Contract[] = [];
  const assumptions: string[] = [];
  for (const id of resolved) {
    const feature = byId.get(id)!;
    const built = buildFixtures(feature);
    assumptions.push(...built.assumptions);
    features.push({ ...feature, fixtures: built.fixtures });
    contracts.push(...buildContracts(feature, built.fixtures));
  }
  const chosen = new Set(resolved);
  const notMocked = catalog.features.filter((f) => !chosen.has(f.id)).map((f) => ({ id: f.id, method: f.method, path: f.path }));

  const selectionFile = await ws.write(system, "selection.json", SelectionSchema, {
    system, catalogHash, selected, resolved, updatedAt: new Date().toISOString(),
  });
  const mockspecFile = await ws.write(system, "mockspec.json", MockSpecSchema, {
    system, baseUrl: "/", language: opts.language ?? "ts", features, notMocked, contracts, assumptions,
  });
  return { selected, resolved, selectionFile, mockspecFile, catalogChanged };
}
