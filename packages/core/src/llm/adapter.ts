export interface CompleteRequest {
  /** 완성 프롬프트(지시문 + 본문). */
  prompt: string;
  /** 출력이 따라야 하는 JSON Schema. */
  schema: Record<string, unknown>;
  /** 취소. abort되면 진행 중인 호출을 끝내고 AbortError로 거부한다. */
  signal?: AbortSignal;
  /** 이 호출의 시간 제한. 없으면 어댑터 기본값(claude-code 180_000). 추출은 기본값, 생성은 600_000. */
  timeoutMs?: number;
}

/** @deprecated CompleteRequest를 쓴다. 2단계 이름 호환용. */
export type ExtractRequest = CompleteRequest;

export interface LlmAdapter {
  readonly name: "claude-code" | "session" | "api";
  /** 스키마를 만족하는 JSON 값을 돌려준다. 검증은 호출자가 다시 한다. */
  complete(req: CompleteRequest): Promise<unknown>;
}

export type AdapterName = LlmAdapter["name"];
