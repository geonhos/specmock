import type { FlowInput, FlowRun, FlowRunOutcome, FlowStep, FlowTargetName, StepResult, StepState } from "@specmock/ui-server/api-types";

/** 단계 상태 8가지(설계 §4). 색과 글자를 함께 쓴다(`.st-<state>` + 이 글자). */
export const STATE_LABEL: Record<StepState, string> = {
  pending: "실행 전", success: "성공", diff: "차이 있음", failed: "실패",
  "skipped-safety": "안전장치로 건너뜀", "stopped-empty": "입력이 비어 멈춤", cleaned: "정리됨", leftover: "남은 자원",
};
/** 상태 표지의 기호(시안 D). 색을 못 알아봐도 기호와 글자로 읽힌다. */
export const STATE_SYMBOL: Record<StepState, string> = {
  pending: "○", success: "✓", diff: "≠", failed: "✕", "skipped-safety": "⊘", "stopped-empty": "✎", cleaned: "↺", leftover: "◆",
};
/** 마지막 실행 결과 글자. 실행을 취소하면 cancelled. */
export const OUTCOME_LABEL: Record<FlowRunOutcome, string> = {
  success: STATE_LABEL.success, diff: STATE_LABEL.diff, failed: STATE_LABEL.failed, stopped: "멈춤", cancelled: "취소됨",
};
export const BASIS_LABEL = { rule: "규칙", claude: "Claude Code", user: "사용자" } as const;

export type Runs = { mock: FlowRun | null; real: FlowRun | null };
export const resultOf = (run: FlowRun | null, stepId: string): StepResult | undefined => run?.steps.find((s) => s.stepId === stepId);

/** 대상별 상태와 "입력 필요" 여부. empty는 서버가 준 `<stepId>:<slot>` 목록. */
export function stepView(step: FlowStep, runs: Runs, empty: readonly string[]): Record<FlowTargetName, StepState> & { needsInput: boolean } {
  return {
    mock: resultOf(runs.mock, step.id)?.state ?? "pending",
    real: resultOf(runs.real, step.id)?.state ?? "pending",
    needsInput: empty.some((e) => e.startsWith(`${step.id}:`)),
  };
}

/** 두 응답 본문에서 값이 다른 필드의 점 경로(배열은 [i]). 정렬해서 돌려준다. */
export function flowDiff(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    if (obj(x) && obj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p);
  };
  walk(a, b, "");
  return out.sort();
}

/** 순서도의 연결선 글자. 실행 전에는 필드 이름, 실행 뒤에는 `필드 = 값`. */
export function edgeLabel(input: FlowInput, result: StepResult | undefined): string {
  const name = input.source.kind === "step" ? input.source.field : input.slot.replace(/^(path|body)\./, "");
  const v = result?.values[input.slot];
  return v === undefined ? name : `${name} = ${typeof v === "string" ? v : JSON.stringify(v)}`;
}
