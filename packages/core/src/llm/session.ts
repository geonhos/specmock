import type { CompleteRequest, LlmAdapter } from "./adapter.js";

/**
 * Claude Code 스킬 모드. 코어는 LLM을 호출하지 않는다. Claude(세션 자신)가 analyze-request.json을 읽고
 * chunks/NNN.md마다 extracted/NNN.json을 쓴 뒤 `specmock analyze <system> --merge`를 실행한다.
 * extract()가 불리면 그 절차를 설명하는 오류를 낸다.
 */
export class SessionAdapter implements LlmAdapter {
  readonly name = "session" as const;
  async complete(_req: CompleteRequest): Promise<unknown> {
    throw new Error("세션 모드에서는 코어가 LLM을 호출하지 않습니다. analyze-request.json의 chunks를 읽어 extracted/NNN.json을 쓴 뒤 `specmock analyze <system> --merge`를 실행하세요.");
  }
}
