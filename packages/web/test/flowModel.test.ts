import { expect, it } from "vitest";
import { edgeLabel, flowDiff, OUTCOME_LABEL, STATE_LABEL, STATE_SYMBOL, stepView } from "../src/flowModel";
import type { FlowRun, FlowStep, StepResult } from "@specmock/ui-server/api-types";

const res = (stepId: string, state: StepResult["state"], body: unknown = null, values: Record<string, unknown> = {}): StepResult => ({
  stepId, featureId: "f", role: "main", state, reason: state === "success" ? null : "이유", missing: [], request: null,
  response: body === null ? null : { status: 200, kind: "json", body: body as never }, schemaErrors: [], values: values as never, durationMs: 1 });
const run = (target: "mock" | "real", steps: StepResult[]): FlowRun => ({ flowId: "issues", target, startedAt: "a", finishedAt: "b", safety: true, cleanup: true, suffix: "", outcome: "success", error: null, steps, leftovers: [] });

it("eight states have Korean labels (spec §4)", () => {
  expect(Object.values(STATE_LABEL)).toEqual(["실행 전", "성공", "차이 있음", "실패", "안전장치로 건너뜀", "입력이 비어 멈춤", "정리됨", "남은 자원"]);
});

it("stepView: pending before a run, per-target state after, '입력 필요' when a slot is empty", () => {
  const step: FlowStep = { id: "get_issue", featureId: "issues_get", role: "main", inputs: [] };
  expect(stepView(step, { mock: null, real: null }, [])).toEqual({ mock: "pending", real: "pending", needsInput: false });
  expect(stepView(step, { mock: run("mock", [res("get_issue", "success")]), real: run("real", [res("get_issue", "skipped-safety")]) }, ["get_issue:path.owner"]))
    .toEqual({ mock: "success", real: "skipped-safety", needsInput: true });
});

it("flowDiff lists dotted paths whose values differ, and fields present on one side only", () => {
  expect(flowDiff({ id: 1, title: "a", owner: { login: "x" }, extra: 1 }, { id: 2, title: "a", owner: { login: "y" } })).toEqual(["extra", "id", "owner.login"]);
  expect(flowDiff([1, 2], [1, 3])).toEqual(["[1]"]);
  expect(flowDiff(null, null)).toEqual([]);
});

it("edgeLabel: the field name before a run, `field = value` after", () => {
  const input = { slot: "path.issue_number", source: { kind: "step" as const, step: "create_issue", field: "number" }, basis: "rule" as const };
  expect(edgeLabel(input, undefined)).toBe("number");
  expect(edgeLabel(input, res("get_issue", "success", null, { "path.issue_number": 1 }))).toBe("number = 1");
});

it("every state has a symbol (look D pills)", () => {
  expect(Object.values(STATE_SYMBOL)).toEqual(["○", "✓", "≠", "✕", "⊘", "✎", "↺", "◆"]);
});

it("every run outcome has a label, cancelled included", () => {
  // FlowRunOutcome, core/src/flow/runTypes.ts; the Record<FlowRunOutcome, string> type also enforces it
  expect(Object.keys(OUTCOME_LABEL).sort()).toEqual(["cancelled", "diff", "failed", "stopped", "success"]);
  expect(OUTCOME_LABEL.cancelled).toBe("취소됨");
});
