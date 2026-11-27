import { defaultMockDir, generate } from "../generate/index.js";
import { readLock } from "../generate/lock.js";
import { runFlow, type FlowTarget } from "../flow/run.js";
import type { FlowRun, FlowTargetName } from "../flow/runTypes.js";
import { missingFeatures, readFlows, writeFlowRun } from "../flow/store.js";
import { readTarget, DEFAULT_TIMEOUT_MS } from "../record/target.js";
import { MockSpecSchema } from "../types.js";
import { startMock } from "../verify/server.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

export interface LaunchedMock { baseUrl: string; stop: () => Promise<void> }
export type LaunchMock = (ws: Workspace, system: string, opts: { mockDir: string; signal?: AbortSignal; onEvent?: OnEvent }) => Promise<LaunchedMock>;

export interface RunFlowTargetsOptions {
  targets: FlowTargetName[];
  cleanup: boolean;
  /** 서버가 요청 시점에 읽은 안전장치 값. real에만 적용된다. */
  safety: boolean;
  env: Record<string, string | undefined>;
  mockDir?: string;
  signal?: AbortSignal;
  onEvent?: OnEvent;
  /** 테스트용. 기본은 TS mock 생성 → 기동. */
  launchMock?: LaunchMock;
}

/** 기본 mock 기동: TS mock을 (LLM 없이) 생성하고 띄운다. 생성기 동작은 바꾸지 않는다. */
export const launchTsMock: LaunchMock = async (ws, system, { mockDir, signal, onEvent }) => {
  await generate(ws, system, { outDir: mockDir, language: "ts", signal });
  const lock = await readLock(mockDir);
  if (!lock) throw new Error(`${mockDir}: specmock.lock.json이 없습니다.`);
  const server = await startMock(mockDir, lock, { signal, onLog: (m) => onEvent?.({ stage: "flow", message: m }) });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: server.stop };
};

function failedRun(flowId: string, target: FlowTargetName, safety: boolean, cleanup: boolean, error: string, outcome: FlowRun["outcome"] = "failed"): FlowRun {
  const at = new Date().toISOString();
  return { flowId, target, startedAt: at, finishedAt: at, safety, cleanup, suffix: "", outcome, error, steps: [], leftovers: [] };
}

/** 흐름을 고른 대상에 차례로 실행하고 대상별 결과를 flow-runs/에 쓴다. 한 대상의 실패가 다른 대상을 막지 않는다. */
export async function runFlowTargets(ws: Workspace, system: string, flowId: string, opts: RunFlowTargetsOptions): Promise<{ runs: FlowRun[]; notRun: FlowTargetName[] }> {
  const file = await readFlows(ws, system);
  const flow = file?.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`알 수 없는 흐름: ${flowId}`);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const missing = missingFeatures(flow, new Set(spec.features.map((f) => f.id)));
  if (missing.length > 0) throw new Error(`기능 없음: ${missing.join(", ")} (기능 선택이 바뀌었습니다. 흐름을 다시 추론하세요)`);
  const runs: FlowRun[] = [];
  const notRun: FlowTargetName[] = [];
  for (const name of opts.targets) {
    // 취소된 뒤에는 남은 대상을 시작하지 않고 그 대상의 지난 실행 기록(파일)을 그대로 둔다.
    if (opts.signal?.aborted) { notRun.push(name); continue; }
    opts.onEvent?.({ stage: "flow", message: `${flow.name}: ${name} 실행` });
    let run: FlowRun;
    if (name === "mock") {
      let mock: LaunchedMock | null = null;
      try {
        mock = await (opts.launchMock ?? launchTsMock)(ws, system, { mockDir: opts.mockDir ?? defaultMockDir(system), signal: opts.signal, onEvent: opts.onEvent });
        const params = await readTarget(ws, system, opts.env).then((t) => t.params, () => ({}));
        const target: FlowTarget = { name, baseUrl: mock.baseUrl, headers: {}, params, timeoutMs: DEFAULT_TIMEOUT_MS, secrets: [] };
        run = await runFlow(flow, spec, target, { safety: opts.safety, cleanup: opts.cleanup, signal: opts.signal });
      } catch (e) {
        run = opts.signal?.aborted ? failedRun(flowId, name, opts.safety, opts.cleanup, "취소되었습니다. mock을 띄우는 중이었습니다.", "cancelled")
          : failedRun(flowId, name, opts.safety, opts.cleanup, `mock을 띄우지 못했습니다. mock을 먼저 만드세요: ${(e as Error).message}`);
      } finally { await mock?.stop(); }
    } else {
      try {
        const t = await readTarget(ws, system, opts.env);
        run = await runFlow(flow, spec, { name, baseUrl: t.baseUrl, headers: t.headers, params: t.params, timeoutMs: t.timeoutMs, secrets: t.secrets }, { safety: opts.safety, cleanup: opts.cleanup, signal: opts.signal });
      } catch (e) {
        run = failedRun(flowId, name, opts.safety, opts.cleanup, opts.signal?.aborted ? "취소되었습니다." : (e as Error).message, opts.signal?.aborted ? "cancelled" : "failed");
      }
    }
    await writeFlowRun(ws, system, run);
    runs.push(run);
  }
  return { runs, notRun };
}
