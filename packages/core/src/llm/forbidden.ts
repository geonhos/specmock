import { LlmForbiddenError } from "../generate/errors.js";
import type { LlmAdapter } from "./adapter.js";

/** 호출되면 던지는 어댑터. LLM을 부르면 안 되는 경로(record apply)가 기본 ClaudeCodeAdapter로 떨어지지 않게 한다. */
export function forbiddenLlmAdapter(): LlmAdapter {
  return {
    name: "claude-code",
    complete(): Promise<unknown> { return Promise.reject(new LlmForbiddenError()); },
  };
}
