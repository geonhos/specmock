import path from "node:path";

const TOOL_FOR: Record<string, string> = {
  ingest: "ingest_spec", analyze: "analyze_spec", select: "select_features", generate: "generate_mock", verify: "verify_mock",
};

/** core/서비스 오류 문구의 CLI 안내(`specmock analyze x`, `--dir 로`)를 도구 안내로 바꾼다. */
export function rewriteHints(message: string): string {
  return message
    .replace(/`?specmock (ingest|analyze|select|generate|verify) [^\s`]+`?/g, (_, cmd: string) => `\`${TOOL_FOR[cmd]}\``)
    .replace(/--dir 로/g, "dir 인자로");
}

type Text = { type: "text"; text: string };

/** 정상 응답: 요약(또는 표) + 구조화 결과. 텍스트에도 JSON을 실어 어떤 클라이언트든 결과를 읽게 한다. */
export function ok<T extends Record<string, unknown>>(summary: string, data: T): { content: Text[]; structuredContent: T } {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}

export function toolError(e: unknown): { content: Text[]; isError: true } {
  return { content: [{ type: "text", text: rewriteHints(e instanceof Error ? e.message : String(e)) }], isError: true };
}

/** 핸들러 예외를 도구 오류 응답으로 바꾼다. 서버는 죽지 않고 다음 호출을 받는다. */
export function guard<A, R>(fn: (args: A) => Promise<R>): (args: A) => Promise<R | ReturnType<typeof toolError>> {
  return async (args: A) => {
    try { return await fn(args); } catch (e) { return toolError(e); }
  };
}

/** 응답의 파일 경로는 항상 절대경로. 서비스가 시스템 디렉터리 기준 상대경로를 주면 `systemDir`을 붙인다. */
export function absPath(systemDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(systemDir, p);
}
