import { z } from "zod";

/** 흐름·단계 id. 파일 경로(`flow-runs/<flowId>/`)에 쓰므로 문자·숫자·`-`·`_`만. */
export const FLOW_ID = /^[A-Za-z0-9_-]+$/;
/** 입력 자리: `path.<경로 변수>` 또는 `body.<최상위 필드>`. */
export const FLOW_SLOT = /^(path|body)\.[^.\s]+$/;

export const FlowRole = z.enum(["prep", "main", "cleanup"]);
export type FlowRole = z.infer<typeof FlowRole>;
/** 근거: 규칙이 채움 | Claude Code(MCP)가 채움 | 사용자가 화면에서 채움. */
export const FlowBasis = z.enum(["rule", "claude", "user"]);
export type FlowBasis = z.infer<typeof FlowBasis>;

/** 출처: 앞 단계 응답 | 사용자 값 | 고정 값(스펙 예시) | 비어 있음. `field`는 응답 본문의 점 경로(`owner.login`). */
export const FlowSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), step: z.string().regex(FLOW_ID), field: z.string().min(1) }),
  z.object({ kind: z.literal("user"), value: z.json() }),
  z.object({ kind: z.literal("fixed"), value: z.json() }),
  z.object({ kind: z.literal("empty") }),
]);
export type FlowSource = z.infer<typeof FlowSourceSchema>;

export const FlowInputSchema = z.object({
  slot: z.string().regex(FLOW_SLOT),
  source: FlowSourceSchema,
  basis: FlowBasis,
  /** 경로 변수가 가리키는 자원을 이 흐름에서 만드는 단계 id. 있으면 target.params가 채우지 않는다(C6). */
  createdBy: z.string().regex(FLOW_ID).optional(),
});
export type FlowInput = z.infer<typeof FlowInputSchema>;

export const FlowStepSchema = z.object({
  id: z.string().regex(FLOW_ID),
  featureId: z.string().min(1),
  role: FlowRole,
  inputs: z.array(FlowInputSchema),
  /** 이 단계가 만드는 자원(단수형, 예: "issue"). 정리와 DELETE 범위 제한이 쓴다. */
  creates: z.string().min(1).optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowSchema = z.object({
  id: z.string().regex(FLOW_ID),
  name: z.string().min(1),
  resource: z.string().min(1),
  steps: z.array(FlowStepSchema).min(1),
});
export type Flow = z.infer<typeof FlowSchema>;

/** `.specmock/<system>/flows.json`. */
export const FlowsFileSchema = z.object({
  system: z.string().min(1),
  /** 추론 시점의 selection.catalogHash. */
  catalogHash: z.string(),
  inferredAt: z.string(),
  flows: z.array(FlowSchema),
  /** 사람이 읽는 추론 메모(흐름을 못 만든 이유, 삭제 API 없음 등). */
  notes: z.array(z.string()),
});
export type FlowsFile = z.infer<typeof FlowsFileSchema>;
