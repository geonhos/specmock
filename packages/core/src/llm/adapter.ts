export interface ExtractRequest {
  /** 지시문 + 청크 본문이 합쳐진 완성 프롬프트. */
  prompt: string;
  /** 출력이 따라야 하는 JSON Schema. */
  schema: Record<string, unknown>;
  /** 취소. abort되면 진행 중인 호출을 끝내고 AbortError로 거부한다. */
  signal?: AbortSignal;
}

export interface LlmAdapter {
  readonly name: "claude-code" | "session" | "api";
  /** 스키마를 만족하는 JSON 값을 돌려준다. 검증은 호출자(merge)가 다시 한다. */
  extract(req: ExtractRequest): Promise<unknown>;
}

export type AdapterName = LlmAdapter["name"];
