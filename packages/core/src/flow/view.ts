import { TARGET_FILE, TargetSchema } from "../record/target.js";
import { MockSpecSchema } from "../types.js";
import type { Workspace } from "../workspace.js";
import type { FlowRun, FlowRunOutcome } from "./runTypes.js";
import { emptySlots, missingFeatures, readFlowRun, readFlows } from "./store.js";
import type { Flow } from "./types.js";

export interface FlowSummary {
  id: string; name: string; resource: string; steps: number;
  /** 빈 입력 수(target.json params가 채우는 경로 변수 제외). */
  empty: number;
  /** 선택에서 빠진 기능 id. 하나라도 있으면 실행을 막고 "기능 없음"을 보인다. */
  missingFeatures: string[];
  last: { mock: FlowRunOutcome | null; real: FlowRunOutcome | null };
}
export interface FlowList { inferredAt: string | null; notes: string[]; flows: FlowSummary[] }
/** HTTP method and path template of a step's feature, for the step header. */
export interface FlowFeatureRef { method: string; path: string }
export interface FlowDetail {
  flow: Flow; empty: string[]; missingFeatures: string[];
  /** By feature id; a step whose feature is not in the selection has no entry. */
  features: Record<string, FlowFeatureRef>;
  runs: { mock: FlowRun | null; real: FlowRun | null };
}

/** target.json의 params 원문(`${ENV}` 치환 없음). 빈 칸 세기에만 쓴다. 파일이 없거나 형식이 틀리면 빈 값. */
async function rawParams(ws: Workspace, system: string): Promise<Record<string, string>> {
  if (!(await ws.exists(system, TARGET_FILE))) return {};
  try { return (await ws.read(system, TARGET_FILE, TargetSchema)).params ?? {}; } catch { return {}; }
}
async function selectedFeatures(ws: Workspace, system: string): Promise<Map<string, FlowFeatureRef>> {
  if (!(await ws.exists(system, "mockspec.json"))) return new Map();
  return new Map((await ws.read(system, "mockspec.json", MockSpecSchema)).features.map((f) => [f.id, { method: f.method, path: f.path }]));
}
const selectedIds = async (ws: Workspace, system: string): Promise<Set<string>> => new Set((await selectedFeatures(ws, system)).keys());

export async function flowSummaries(ws: Workspace, system: string): Promise<FlowList> {
  const file = await readFlows(ws, system);
  if (!file) return { inferredAt: null, notes: [], flows: [] };
  const params = await rawParams(ws, system);
  const ids = await selectedIds(ws, system);
  const flows: FlowSummary[] = [];
  for (const f of file.flows) {
    const [mock, real] = await Promise.all([readFlowRun(ws, system, f.id, "mock"), readFlowRun(ws, system, f.id, "real")]);
    flows.push({ id: f.id, name: f.name, resource: f.resource, steps: f.steps.length, empty: emptySlots(f, params).length,
      missingFeatures: missingFeatures(f, ids), last: { mock: mock?.outcome ?? null, real: real?.outcome ?? null } });
  }
  return { inferredAt: file.inferredAt, notes: file.notes, flows };
}

export async function flowDetail(ws: Workspace, system: string, flowId: string): Promise<FlowDetail> {
  const flow = (await readFlows(ws, system))?.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`알 수 없는 흐름: ${flowId}`);
  const [mock, real] = await Promise.all([readFlowRun(ws, system, flowId, "mock"), readFlowRun(ws, system, flowId, "real")]);
  const selected = await selectedFeatures(ws, system);
  const features: Record<string, FlowFeatureRef> = {};
  for (const st of flow.steps) { const ref = selected.get(st.featureId); if (ref) features[st.featureId] = ref; }
  return { flow, empty: emptySlots(flow, await rawParams(ws, system)), missingFeatures: missingFeatures(flow, new Set(selected.keys())), features, runs: { mock, real } };
}
