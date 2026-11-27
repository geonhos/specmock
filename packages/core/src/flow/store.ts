import type { Workspace } from "../workspace.js";
import { FlowsFileSchema, type Flow, type FlowBasis, type FlowSource, type FlowsFile } from "./types.js";

export const FLOWS_FILE = "flows.json";

export async function readFlows(ws: Workspace, system: string): Promise<FlowsFile | null> {
  return (await ws.exists(system, FLOWS_FILE)) ? ws.read(system, FLOWS_FILE, FlowsFileSchema) : null;
}

export async function writeFlows(ws: Workspace, system: string, file: FlowsFile): Promise<string> {
  return ws.write(system, FLOWS_FILE, FlowsFileSchema, file);
}

/**
 * 입력 하나를 바꾼 새 파일. 단계 출처는 같은 흐름의 앞 단계만 허용한다. `createdBy`는 그대로 둔다.
 * 이 흐름이 만든 상위 자원을 그 생성 단계에 연결하면(`repo <- create_repo.name`), 같은 `createdBy`의 같은 자리 중
 * 아직 비어 있는 다른 단계에도 같은 연결을 넣는다("한 번만 연결", C6).
 */
export function setInput(file: FlowsFile, flowId: string, stepId: string, slot: string, source: FlowSource, basis: FlowBasis): FlowsFile {
  const flow = file.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`알 수 없는 흐름: ${flowId}`);
  const at = flow.steps.findIndex((s) => s.id === stepId);
  if (at < 0) throw new Error(`알 수 없는 단계: ${stepId} (흐름 ${flowId})`);
  const target = flow.steps[at]!.inputs.find((i) => i.slot === slot);
  if (!target) throw new Error(`알 수 없는 입력 자리: ${slot} (단계 ${stepId})`);
  if (source.kind === "step" && !flow.steps.slice(0, at).some((s) => s.id === source.step)) throw new Error(`출처 단계 ${source.step}: 같은 흐름의 앞 단계만 고를 수 있습니다.`);
  const spread = source.kind === "step" && target.createdBy !== undefined && source.step === target.createdBy;
  return {
    ...file,
    flows: file.flows.map((f) => f.id !== flowId ? f : {
      ...f, steps: f.steps.map((s) => ({ ...s, inputs: s.inputs.map((i) => {
        if (i.slot !== slot) return i;
        if (s.id === stepId) return { ...i, source, basis };
        if (spread && i.createdBy === target.createdBy && i.source.kind === "empty") return { ...i, source, basis };
        return i;
      }) })),
    }),
  };
}

/** 빈 자리(`<단계 id>:<자리>`). target.json `params`는 이 흐름의 어느 단계도 만들지 않는 `path.<이름>`(createdBy 없음)만 채우므로 그것만 뺀다. */
export function emptySlots(flow: Flow, params: Record<string, string>): string[] {
  return flow.steps.flatMap((s) => s.inputs
    .filter((i) => i.source.kind === "empty" && !(i.slot.startsWith("path.") && !i.createdBy && Object.hasOwn(params, i.slot.slice(5))))
    .map((i) => `${s.id}:${i.slot}`));
}

export function missingFeatures(flow: Flow, featureIds: ReadonlySet<string>): string[] {
  return [...new Set(flow.steps.map((s) => s.featureId).filter((id) => !featureIds.has(id)))];
}
