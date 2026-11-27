import { z } from "zod";
import { FLOW_ID, FlowRole } from "./types.js";

export const FlowTargetName = z.enum(["mock", "real"]);
export type FlowTargetName = z.infer<typeof FlowTargetName>;

/** 단계 상태 8가지(설계 §4). pending=실행 전. */
export const StepState = z.enum(["pending", "success", "diff", "failed", "skipped-safety", "stopped-empty", "cleaned", "leftover"]);
export type StepState = z.infer<typeof StepState>;

export const StepResultSchema = z.object({
  stepId: z.string(),
  featureId: z.string(),
  role: FlowRole,
  state: StepState,
  reason: z.string().nullable(),
  /** stopped-empty일 때 비어 있던 자리. */
  missing: z.array(z.string()),
  request: z.object({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), body: z.json().nullable() }).nullable(),
  response: z.object({ status: z.number().int().nullable(), kind: z.string().nullable(), body: z.json().nullable() }).nullable(),
  schemaErrors: z.array(z.string()),
  /** 이번 실행에서 각 자리에 들어간 값(마스킹 후). 화면의 연결선 값. */
  values: z.record(z.string(), z.json()),
  durationMs: z.number().nonnegative(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const LeftoverSchema = z.object({ resource: z.string(), stepId: z.string(), url: z.string(), id: z.string().nullable(), reason: z.string() });
export type Leftover = z.infer<typeof LeftoverSchema>;

export const FlowRunOutcome = z.enum(["success", "diff", "failed", "stopped"]);
export type FlowRunOutcome = z.infer<typeof FlowRunOutcome>;

/** `.specmock/<system>/flow-runs/<flowId>/<target>.json`. 대상별 마지막 실행 하나. */
export const FlowRunSchema = z.object({
  flowId: z.string().regex(FLOW_ID),
  target: FlowTargetName,
  startedAt: z.string(),
  finishedAt: z.string(),
  safety: z.boolean(),
  cleanup: z.boolean(),
  suffix: z.string(),
  outcome: FlowRunOutcome,
  /** 실행 전체를 막은 오류(mock 기동 실패, target.json 오류). */
  error: z.string().nullable(),
  steps: z.array(StepResultSchema),
  leftovers: z.array(LeftoverSchema),
});
export type FlowRun = z.infer<typeof FlowRunSchema>;
