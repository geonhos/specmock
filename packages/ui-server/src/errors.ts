import { LockBusyError } from "@specmock/core";

/** 요청 본문이 형식에 맞지 않을 때. `invalid`(400)로 매핑한다. */
export class InvalidRequest extends Error {
  constructor(message: string) { super(message); this.name = "InvalidRequest"; }
}

/** 요청한 대상이 없을 때. `not-found`(404)로 매핑한다. */
export class NotFound extends Error {
  constructor(message: string) { super(message); this.name = "NotFound"; }
}

const ERRNO_MESSAGE: Record<string, string> = {
  ENOENT: "파일을 찾을 수 없어요",
  EISDIR: "파일이 아니라 디렉터리예요",
  ENOTDIR: "경로가 올바르지 않아요",
  EACCES: "파일을 읽을 권한이 없어요",
};

/** 등록 입력(파일 경로·URL) 때문에 난 오류를 화면용 400으로 바꾼다. 그 밖의 오류는 그대로 돌려준다. */
export function ingestInputError(e: unknown): unknown {
  const err = e as NodeJS.ErrnoException;
  const label = err?.code ? ERRNO_MESSAGE[err.code] : undefined;
  if (label) return new InvalidRequest(`${label}: ${err.path ?? ""}`.trimEnd());
  if (e instanceof Error && /요청 실패: /.test(e.message)) return new InvalidRequest(e.message);
  return e;
}

export type ErrorCode = "invalid" | "not-found" | "busy" | "overwrite-required" | "language-change-required" | "cancelled" | "not-cancellable" | "forbidden" | "failed" | "shutting-down";
export interface ApiErrorBody { ok: false; error: { code: ErrorCode; message: string; hint?: string } }

const STEP: Record<string, string> = { ingest: "① 등록", analyze: "② 분석", select: "③ 기능 선택", generate: "④ 생성", verify: "⑤ 검증" };

/** CLI 안내 문장(“먼저 `specmock analyze x`를 실행하세요”, “--dir 로”)을 화면 동작 안내로 바꾼다. 2A MCP 층 rewriteHints와 같은 방식. */
export function toUiHint(sentence: string): string {
  const m = /`?specmock (ingest|analyze|select|generate|verify)\b/.exec(sentence);
  if (!m) return sentence;
  const step = STEP[m[1]!]!;
  return /--dir 로/.test(sentence)
    ? `먼저 ${step}을 진행하거나 출력 디렉터리를 지정해 주세요.`
    : `먼저 ${step}을 진행해 주세요.`;
}

const HINT_SENTENCE = /\s*먼저 `?specmock [^.]*\.\s*$/;

export function errorBody(code: ErrorCode, message: string, hint?: string): ApiErrorBody {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

export type ApiErrorStatus = 400 | 403 | 404 | 405 | 409 | 499 | 500 | 503;

export function toApiError(e: unknown): { status: ApiErrorStatus; body: ApiErrorBody } {
  if (e instanceof LockBusyError) return { status: 409, body: errorBody("busy", e.message, "다른 곳(CLI/대화)에서 작업 중이에요. 끝난 뒤 다시 시도해 주세요.") };
  if (e instanceof NotFound) return { status: 404, body: errorBody("not-found", e.message) };
  if (e instanceof InvalidRequest) return { status: 400, body: errorBody("invalid", e.message) };
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === "AbortError") return { status: 499, body: errorBody("cancelled", "작업을 취소했어요.") };
  const hintMatch = HINT_SENTENCE.exec(err.message);
  const message = hintMatch ? err.message.slice(0, hintMatch.index) : err.message;
  const hint = hintMatch ? toUiHint(hintMatch[0].trim()) : undefined;
  if (err.message.includes("specmock이 만든 디렉터리가 아닙니다")) {
    return { status: 409, body: errorBody("overwrite-required", message.replace(/\s*덮어쓰려면 --force\s*$/, ""), "경로와 덮어쓸 내용을 확인한 뒤 덮어쓰기를 선택해 주세요.") };
  }
  if (/파일이 없습니다|이\(가\) 없습니다/.test(err.message)) return { status: 404, body: errorBody("not-found", message, hint) };
  if (/올바르지 않습니다|알 수 없는 기능 id|선택 결과가 비어|함께 쓸 수 없습니다/.test(err.message)) {
    return { status: 400, body: errorBody("invalid", message, hint) };
  }
  return { status: 500, body: errorBody("failed", message, hint) };
}
