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
export interface FlowDetail { flow: Flow; empty: string[]; missingFeatures: string[]; runs: { mock: FlowRun | null; real: FlowRun | null } }

/** target.json의 params 원문(`${ENV}` 치환 없음). 빈 칸 세기에만 쓴다. 파일이 없거나 형식이 틀리면 빈 값. */
async function rawParams(ws: Workspace, system: string): Promise<Record<string, string>> {
  if (!(await ws.exists(system, TARGET_FILE))) return {};
  try { return (await ws.read(system, TARGET_FILE, TargetSchema)).params ?? {}; } catch { return {}; }
}
async function selectedIds(ws: Workspace, system: string): Promise<Set<string>> {
  if (!(await ws.exists(system, "mockspec.json"))) return new Set();
  return new Set((await ws.read(system, "mockspec.json", MockSpecSchema)).features.map((f) => f.id));
}

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
  return { flow, empty: emptySlots(flow, await rawParams(ws, system)), missingFeatures: missingFeatures(flow, await selectedIds(ws, system)), runs: { mock, real } };
}
