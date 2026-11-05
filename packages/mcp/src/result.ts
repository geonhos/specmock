import path from "node:path";
import type { OnEvent, ServiceEvent } from "@specmock/core";

const TOOL_FOR: Record<string, string> = {
  ingest: "ingest_spec", analyze: "analyze_spec", select: "select_features", generate: "generate_mock", verify: "verify_mock",
};

/** core/서비스 오류 문구의 CLI 안내(`specmock analyze x`, `--dir 로`)를 도구 안내로 바꾼다. */
export function rewriteHints(message: string): string {
  const overwrite = message.includes("specmock이 만든 디렉터리가 아닙니다")
    ? " `force: true`로 다시 하기 전에 사용자에게 경로와 덮어쓸 내용을 확인받으세요."
    : "";
  return message
    .replace(/`?specmock (ingest|analyze|select|generate|verify)(?: (?:<[^>\s]+>|[A-Za-z0-9_-]+))?`?/g, (_, cmd: string) => `\`${TOOL_FOR[cmd]}\``)
    .replace(/--dir 로/g, "dir 인자로")
    .replace(/--force/g, "force: true")
    .replace(/<(?:표현식|exprs)>/g, "exprs") + overwrite;
}

type Text = { type: "text"; text: string };

/** 정상 응답: 요약(또는 표) + 구조화 결과. 텍스트에도 JSON을 실어 어떤 클라이언트든 결과를 읽게 한다. */
export function ok<T extends Record<string, unknown>>(summary: string, data: T): { content: Text[]; structuredContent: T } {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}

/** 도구 핸들러가 받는 컨텍스트 중 진행 알림에 필요한 부분만. */
export interface ProgressCtx {
  mcpReq: { _meta?: { progressToken?: string | number }; notify: (n: { method: string; params?: Record<string, unknown> }) => Promise<void> };
}

/**
 * 서비스 이벤트를 stderr 로그로 남기고, 클라이언트가 progressToken을 줬으면 MCP progress notification으로도 보낸다.
 * progress는 호출 안에서 단조 증가해야 하므로 알림마다 1씩 올린다(이벤트의 done/total은 메시지에 이미 있다).
 */
function makeProgress(ctx: ProgressCtx, log: OnEvent): { onEvent: OnEvent; send?: (message: string) => void } {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return { onEvent: log };
  let n = 0;
  const send = (message: string) => {
    n += 1;
    ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: n, message } }).catch(() => {});
  };
  return { onEvent: (e: ServiceEvent) => { log(e); send(`[${e.stage}] ${e.message}`); }, send };
}

export function progressEmitter(ctx: ProgressCtx, log: OnEvent): OnEvent {
  return makeProgress(ctx, log).onEvent;
}

/** progressEmitter에 더해, heartbeatMs 주기로 fn이 끝날 때까지 "진행 중" 알림을 보낸다(이벤트가 없는 긴 작업용). */
export async function withProgress<R>(ctx: ProgressCtx, log: OnEvent, fn: (onEvent: OnEvent) => Promise<R>, heartbeatMs: number, label: string): Promise<R> {
  const { onEvent, send } = makeProgress(ctx, log);
  const timer = send ? setInterval(() => send(`[${label}] 진행 중…`), heartbeatMs) : undefined;
  try {
    return await fn(onEvent);
  } finally {
    if (timer) clearInterval(timer);
  }
}

export function toolError(e: unknown): { content: Text[]; isError: true } {
  return { content: [{ type: "text", text: rewriteHints(e instanceof Error ? e.message : String(e)) }], isError: true };
}

/** 핸들러 예외를 도구 오류 응답으로 바꾼다. 서버는 죽지 않고 다음 호출을 받는다. */
export function guard<A, C, R>(fn: (args: A, ctx: C) => Promise<R>): (args: A, ctx: C) => Promise<R | ReturnType<typeof toolError>> {
  return async (args: A, ctx: C) => {
    try { return await fn(args, ctx); } catch (e) { return toolError(e); }
  };
}

/** 응답의 파일 경로는 항상 절대경로. 서비스가 시스템 디렉터리 기준 상대경로를 주면 `systemDir`을 붙인다. */
export function absPath(systemDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(systemDir, p);
}
