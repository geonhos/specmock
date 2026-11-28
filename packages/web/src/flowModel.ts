import type { FlowInput, FlowRun, FlowRunOutcome, FlowStep, FlowTargetName, StepResult, StepState } from "@specmock/ui-server/api-types";

/** The eight step states (design §4). Colour and text go together (`.st-<state>` + this label). */
export const STATE_LABEL: Record<StepState, string> = {
  pending: "실행 전", success: "성공", diff: "차이 있음", failed: "실패",
  "skipped-safety": "안전장치로 건너뜀", "stopped-empty": "입력이 비어 멈춤", cleaned: "정리됨", leftover: "남은 자원",
};
/** Symbol per state (look D), so a state reads without colour: symbol plus label. */
export const STATE_SYMBOL: Record<StepState, string> = {
  pending: "○", success: "✓", diff: "≠", failed: "✕", "skipped-safety": "⊘", "stopped-empty": "✎", cleaned: "↺", leftover: "◆",
};
/** Label of the last run's outcome; a cancelled run is `cancelled`. */
export const OUTCOME_LABEL: Record<FlowRunOutcome, string> = {
  success: STATE_LABEL.success, diff: STATE_LABEL.diff, failed: STATE_LABEL.failed, stopped: "멈춤", cancelled: "취소됨",
};
/** Pill state used for the last run's outcome; a cancelled run reads as not finished. */
export const OUTCOME_STATE: Record<FlowRunOutcome, StepState> = { success: "success", diff: "diff", failed: "failed", stopped: "stopped-empty", cancelled: "pending" };
export const BASIS_LABEL = { rule: "규칙", claude: "Claude Code", user: "사용자" } as const;

export type Runs = { mock: FlowRun | null; real: FlowRun | null };
export const resultOf = (run: FlowRun | null, stepId: string): StepResult | undefined => run?.steps.find((s) => s.stepId === stepId);

/** State per target and whether the step needs input. `empty` is the server's `<stepId>:<slot>` list. */
export function stepView(step: FlowStep, runs: Runs, empty: readonly string[]): Record<FlowTargetName, StepState> & { needsInput: boolean } {
  return {
    mock: resultOf(runs.mock, step.id)?.state ?? "pending",
    real: resultOf(runs.real, step.id)?.state ?? "pending",
    needsInput: empty.some((e) => e.startsWith(`${step.id}:`)),
  };
}

/** Dotted paths (`[i]` for arrays) of fields whose values differ between two response bodies, sorted. */
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

/** Text on a chart edge: the field name before a run, `field = value` after it. */
export function edgeLabel(input: FlowInput, result: StepResult | undefined): string {
  const name = input.source.kind === "step" ? input.source.field : input.slot.replace(/^(path|body)\./, "");
  const v = result?.values[input.slot];
  return v === undefined ? name : `${name} = ${typeof v === "string" ? v : JSON.stringify(v)}`;
}
