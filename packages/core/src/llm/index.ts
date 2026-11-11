import type { AdapterName, LlmAdapter } from "./adapter.js";
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from "./claudeCode.js";
import { SessionAdapter } from "./session.js";

export type { AdapterName, CompleteRequest, ExtractRequest, LlmAdapter, LlmUsage } from "./adapter.js";
export { ClaudeCodeAdapter, type ClaudeCodeOptions } from "./claudeCode.js";
export { SessionAdapter } from "./session.js";

export const ADAPTER_NAMES: AdapterName[] = ["session", "claude-code"];

export function createAdapter(name: AdapterName, opts: { claude?: ClaudeCodeOptions } = {}): LlmAdapter {
  switch (name) {
    case "claude-code": return new ClaudeCodeAdapter(opts.claude);
    case "session": return new SessionAdapter("analyze-request.json의 chunks를 읽어 extracted/NNN.json을 쓴 뒤 `specmock analyze <system> --merge`를 실행하세요.");
    case "api": throw new Error("API 키 어댑터는 3단계에서 제공합니다.");
    default: throw new Error(`알 수 없는 LLM 어댑터: ${String(name)} (가능: ${ADAPTER_NAMES.join(", ")})`);
  }
}
