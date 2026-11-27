import { inferFlows, mergeFlows } from "../flow/infer.js";
import { readFlows, writeFlows } from "../flow/store.js";
import type { FlowsFile } from "../flow/types.js";
import { MockSpecSchema, SelectionSchema } from "../types.js";
import type { Workspace } from "../workspace.js";

/** mockspec.json(고른 기능만)에서 흐름을 추론해 flows.json에 쓴다. 근거가 claude·user인 입력은 보존한다. */
export async function inferFlowsForSystem(ws: Workspace, system: string): Promise<FlowsFile> {
  if (!(await ws.exists(system, "selection.json")) || !(await ws.exists(system, "mockspec.json"))) {
    throw new Error(`${system}: 먼저 기능을 고르세요 (선택한 기능이 없어 흐름을 추론할 수 없습니다).`);
  }
  const selection = await ws.read(system, "selection.json", SelectionSchema);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const { flows, notes } = inferFlows(spec.features);
  const file: FlowsFile = {
    system, catalogHash: selection.catalogHash, inferredAt: new Date().toISOString(),
    flows: mergeFlows(await readFlows(ws, system), flows),
    notes: flows.length === 0 && notes.length === 0 ? ["고른 기능에서 자원 경로를 찾지 못했습니다."] : notes,
  };
  await writeFlows(ws, system, file);
  return file;
}
