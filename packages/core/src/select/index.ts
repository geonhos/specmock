import { readRecorded } from "../record/recorded.js";
import { CatalogSchema, MockSpecSchema, SelectionSchema, SourceSchema, type Contract, type MockFeature, type MockSpec, type Recorded } from "../types.js";
import { hashJson } from "../util/hash.js";
import { featureInputHash } from "../util/specHash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import { orderFeatures } from "../catalog/order.js";
import { buildContracts } from "./contracts.js";
import { resolveSelection } from "./expression.js";
import { buildFixtures } from "./fixtures.js";

export interface SelectOptions {
  add?: boolean;
  remove?: boolean;
  /** true면 exprs를 표현식이 아닌 기능 id 그대로 취급한다(id가 all·숫자 등과 겹쳐도 안전). add/remove는 무시. */
  literalIds?: boolean;
}

export interface SelectResult {
  selected: string[];
  resolved: string[];
  selectionFile: string;
  mockspecFile: string;
  catalogChanged: boolean;
  /** catalogChanged이고 이전 선택에 catalogIds가 있을 때만. 이전 선택 시점 대비 변화. */
  catalogDiff?: { added: string[]; removed: string[]; removedSelected: string[] };
}

export async function select(ws: Workspace, system: string, exprs: string[], opts: SelectOptions = {}): Promise<SelectResult> {
  return withSystemLock(ws, system, () => selectUnlocked(ws, system, exprs, opts));
}

async function selectUnlocked(ws: Workspace, system: string, exprs: string[], opts: SelectOptions): Promise<SelectResult> {
  if (opts.add && opts.remove) throw new Error("--add와 --remove는 함께 쓸 수 없습니다.");
  const catalog = await ws.read(system, "catalog.json", CatalogSchema);
  const catalogHash = hashJson(catalog.features);

  const prev = (await ws.exists(system, "selection.json")) ? await ws.read(system, "selection.json", SelectionSchema) : null;
  const catalogChanged = prev !== null && prev.catalogHash !== catalogHash;
  const currentIds = catalog.features.map((f) => f.id);
  let catalogDiff: SelectResult["catalogDiff"];
  if (catalogChanged && prev?.catalogIds) {
    const cur = new Set(currentIds);
    const old = new Set(prev.catalogIds);
    catalogDiff = {
      added: currentIds.filter((id) => !old.has(id)),
      removed: prev.catalogIds.filter((id) => !cur.has(id)),
      removedSelected: prev.resolved.filter((id) => !cur.has(id)),
    };
  }
  let selected = [...exprs];
  if (opts.literalIds) {
    // 표현식 해석 없이 id 존재만 확인한다.
  } else if (opts.remove) {
    if (!prev) throw new Error(`제거할 기존 선택이 없습니다. 먼저 specmock select ${system} <표현식>을 실행하세요.`);
    const negated = exprs
      .flatMap((e) => e.split(",").map((s) => s.trim()).filter(Boolean))
      .map((s) => (s.startsWith("-") ? s : `-${s}`));
    selected = [...prev.selected, ...negated];
  } else if (opts.add && prev) {
    selected = [...prev.selected, ...exprs];
  }

  let resolved: string[];
  if (opts.literalIds) {
    const known = new Set(currentIds);
    const unknown = selected.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`알 수 없는 기능 id: ${unknown.join(", ")}`);
    const want = new Set(selected);
    resolved = orderFeatures(catalog).map((o) => o.feature.id).filter((id) => want.has(id));
  } else {
    resolved = await resolveSelection(catalog, selected);
  }
  if (resolved.length === 0) throw new Error("선택 결과가 비어 있습니다. 표현식을 확인하세요.");

  const byId = new Map(catalog.features.map((f) => [f.id, f]));
  const features: MockFeature[] = [];
  const contracts: Contract[] = [];
  const assumptions: string[] = [];
  const recordings: Recorded[] = [];
  for (const id of resolved) {
    const feature = byId.get(id)!;
    let rec: Recorded | null = null;
    try { rec = await readRecorded(ws, system, id); } catch { assumptions.push(`${id}: 녹화 파일을 읽지 못해 사용하지 않음`); }
    if (rec && rec.featureId !== id) {
      assumptions.push(`${id}: 녹화 파일의 featureId가 파일 이름과 다릅니다. 사용하지 않음`);
      rec = null;
    }
    if (rec) recordings.push(rec);
    const built = buildFixtures(feature, rec);
    assumptions.push(...built.assumptions);
    features.push({ ...feature, fixtures: built.fixtures });
    contracts.push(...buildContracts(feature, built.fixtures));
  }
  // 수확 단계의 메모(수확 실패·미설치·수동 탐색 필요 등)는 coverage에서 보이도록 assumptions 앞에 둔다.
  if (await ws.exists(system, "source.json")) {
    const source = await ws.read(system, "source.json", SourceSchema);
    const notes = source.inputs.flatMap((i) => i.harvested?.notes ?? []).map((n) => `입력: ${n}`);
    assumptions.unshift(...notes);
  }
  const chosen = new Set(resolved);
  const notMocked = catalog.features.filter((f) => !chosen.has(f.id)).map((f) => ({ id: f.id, method: f.method, path: f.path }));
  const fresh: MockSpec = { system, baseUrl: "/", features, notMocked, contracts, assumptions: [] };
  for (const r of recordings) {
    if (r.mockspecHash !== featureInputHash(fresh, r.featureId)) {
      assumptions.push(`${r.featureId}: 녹화가 지금 mockspec과 다른 시점에 만들어졌습니다(낡은 녹화). 다시 녹화하려면 record --refresh`);
    }
  }

  const selectionFile = await ws.write(system, "selection.json", SelectionSchema, {
    system, catalogHash, selected, resolved, catalogIds: currentIds, literal: opts.literalIds === true, updatedAt: new Date().toISOString(),
  });
  const mockspecFile = await ws.write(system, "mockspec.json", MockSpecSchema, {
    system, baseUrl: "/", features, notMocked, contracts, assumptions,
  });
  return { selected, resolved, selectionFile, mockspecFile, catalogChanged, ...(catalogDiff ? { catalogDiff } : {}) };
}
