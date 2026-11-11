/** LLM 호출 1회의 사용량. 어댑터가 채우고, 단계(stage · detail)는 호출자가 붙인다. 프롬프트 · 응답 본문은 담지 않는다. */
export interface LlmUsage {
  /** 호출 시작 시각(ISO). */
  at: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** `costBasis`가 "list"면 API 정가 환산. 구독이면 실제 청구가 아니다. */
  costUsd: number | null;
  costBasis: string | null;
  billing: "api-key" | "subscription";
  /** 어댑터가 잰 벽시계(spawn → 종료). */
  durationMs: number;
  apiDurationMs: number | null;
  ok: boolean;
  /** 실패 메시지(비밀 마스킹 거침). */
  error?: string;
}

export interface CompleteRequest {
  /** 완성 프롬프트(지시문 + 본문). */
  prompt: string;
  /** 출력이 따라야 하는 JSON Schema. */
  schema: Record<string, unknown>;
  /** 취소. abort되면 진행 중인 호출을 끝내고 AbortError로 거부한다. */
  signal?: AbortSignal;
  /** 이 호출의 시간 제한. 없으면 어댑터 기본값(claude-code 180_000). 추출은 기본값, 생성은 600_000. */
  timeoutMs?: number;
  /** 호출이 끝날 때(성공 · 실패 모두) 사용량을 받는다. 선택. 던져도 호출 결과에는 영향이 없다(경고만). 사용량을 모르는 어댑터는 부르지 않는다. */
  onUsage?: (usage: LlmUsage) => void;
}

/** @deprecated CompleteRequest를 쓴다. 2단계 이름 호환용. */
export type ExtractRequest = CompleteRequest;

export interface LlmAdapter {
  readonly name: "claude-code" | "session" | "api";
  /** 스키마를 만족하는 JSON 값을 돌려준다. 검증은 호출자가 다시 한다. */
  complete(req: CompleteRequest): Promise<unknown>;
}

export type AdapterName = LlmAdapter["name"];
