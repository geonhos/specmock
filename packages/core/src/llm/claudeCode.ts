import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { killGroup, spawnGroup } from "../util/procGroup.js";
import { maskSecrets } from "../ingest/mask.js";
import type { CompleteRequest, LlmAdapter, LlmUsage } from "./adapter.js";

export interface ClaudeCodeOptions {
  command?: string;        // 기본 "claude"
  model?: string;          // 기본: CLI 기본 모델
  timeoutMs?: number;      // 기본 180_000
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;            // 기본: 호출마다 만드는 빈 임시 디렉터리
}

interface ModelUsageEntry { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costBasis?: string }
interface ResultEnvelope {
  is_error?: boolean; subtype?: string; result?: unknown; structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  total_cost_usd?: number; duration_api_ms?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
}

/**
 * 로컬 Claude Code 구독으로 추출한다. `claude --print --output-format json --json-schema <schema> --tools ""`를
 * 자식 프로세스로 띄우고 프롬프트를 stdin으로 준다. 도구를 비워 파일 접근 없이 텍스트만 보게 하고,
 * `--no-session-persistence`로 청크마다 ~/.claude/projects 아래 대화 기록이 쌓이지 않게 한다.
 *
 * `extraArgs`는 옵션(`--flag`)만 넣는다. `--tools`는 가변 인자라 그 뒤에 위치 인자를 두면 삼켜진다.
 * 자식은 빈 임시 디렉터리에서 실행한다. 사용자·프로젝트의 Claude Code 설정(.claude/settings*.json, agent 지정 등)과 CLAUDE.md를 자식 프로세스가 상속하지 않게 하기 위해서다.
 * 부모 환경에 ANTHROPIC_API_KEY가 있으면 claude가 구독 대신 API 키로 과금한다(일부러 제거하지 않는다).
 */
export class ClaudeCodeAdapter implements LlmAdapter {
  readonly name = "claude-code" as const;
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async complete(req: CompleteRequest): Promise<unknown> {
    if (!req.onUsage) return this.run(req, { out: "" });
    const start = new Date();
    const t0 = performance.now();
    const raw = { out: "" };
    let value: unknown;
    try {
      value = await this.run(req, raw);
    } catch (e) {
      this.report(req, start, t0, raw.out, false, e);
      throw e;
    }
    this.report(req, start, t0, raw.out, true);
    return value;
  }

  /** 사용량 레코드를 만들어 콜백에 넘긴다. 콜백 예외는 경고로만 바꾼다. */
  private report(req: CompleteRequest, start: Date, t0: number, out: string, ok: boolean, err?: unknown): void {
    const env = tryParse(out);
    const u = env?.usage;
    const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const models = Object.entries(env?.modelUsage ?? {});
    const weight = (m: ModelUsageEntry) => (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
    const top = models.sort((a, b) => weight(b[1]) - weight(a[1]))[0];
    const usage: LlmUsage = {
      at: start.toISOString(),
      model: top?.[0] ?? this.opts.model ?? null,
      inputTokens: n(u?.input_tokens),
      outputTokens: n(u?.output_tokens),
      cacheReadTokens: n(u?.cache_read_input_tokens),
      cacheCreationTokens: n(u?.cache_creation_input_tokens),
      costUsd: n(env?.total_cost_usd),
      costBasis: top?.[1].costBasis ?? null,
      billing: detectsApiBilling({ ...process.env, ...this.opts.env }) ? "api-key" : "subscription",
      durationMs: Math.round(performance.now() - t0),
      apiDurationMs: n(env?.duration_api_ms),
      ok,
      ...(ok ? {} : { error: logLine(err instanceof ClaudeCallError ? err.logMessage : err instanceof Error ? err.message : String(err)) }),
    };
    try { req.onUsage!(usage); } catch (e) { process.stderr.write(`경고: LLM 사용량 기록 콜백이 실패했습니다: ${(e as Error).message}\n`); }
  }

  private async run(req: CompleteRequest, raw: { out: string }): Promise<unknown> {
    req.signal?.throwIfAborted();
    const args = ["--print", "--output-format", "json", "--json-schema", JSON.stringify(req.schema), "--no-session-persistence"];
    if (this.opts.model) args.push("--model", this.opts.model);
    args.push("--tools", "");   // 마지막 고정 플래그. 뒤에는 extraArgs 옵션만 온다.
    args.push(...(this.opts.extraArgs ?? []));
    const command = this.opts.command ?? "claude";
    const timeoutMs = this.opts.timeoutMs ?? req.timeoutMs ?? 180_000;

    const ownCwd = this.opts.cwd === undefined;
    const cwd = this.opts.cwd ?? (await mkdtemp(path.join(os.tmpdir(), "specmock-claude-")));
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawnGroup(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.opts.env } }) as ChildProcessWithoutNullStreams;
      let out = "", err = "";
      const onAbort = () => { clearTimeout(timer); killGroup(child, "SIGKILL"); reject(req.signal!.reason instanceof Error ? req.signal!.reason : abortError()); };
      const timer = setTimeout(() => { killGroup(child, "SIGKILL"); reject(new Error(`claude 호출 시간 초과 (${timeoutMs}ms)`)); }, timeoutMs);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      if (req.signal?.aborted) onAbort();   // 리스너를 달기 전에 이미 취소된 경우
      child.on("error", (e) => { req.signal?.removeEventListener("abort", onAbort); clearTimeout(timer); reject(new Error(`claude CLI를 실행할 수 없습니다 (${command}): ${e.message}. Claude Code가 설치돼 있고 PATH에 있는지 확인하세요.`)); });
      // 멀티바이트 문자가 파이프 읽기 경계에서 쪼개져도 깨지지 않도록 스트림이 디코딩하게 한다.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code, signal) => {
        raw.out = out;
        req.signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        // 실패해도 JSON 봉투를 내는 경우가 있으므로 메시지를 뽑아 본다.
        const message = tryParse(out)?.result;
        const stderrLine = err.trim();
        if (code === null) {
          return reject(new ClaudeCallError(`claude 종료 (signal ${signal}): ${stderrLine || out.trim().slice(0, 300)}`, `claude 종료 (signal ${signal})${stderrLine ? `: ${stderrLine}` : ""}`));
        }
        const logDetail = typeof message === "string" ? message : stderrLine;
        reject(new ClaudeCallError(`claude 종료 코드 ${code}: ${typeof message === "string" ? message : stderrLine || out.trim().slice(0, 300)}`, `claude 종료 코드 ${code}${logDetail ? `: ${logDetail}` : ""}`));
      });
      child.stdin.on("error", () => { /* 자식이 먼저 죽으면 EPIPE. close에서 처리된다. */ });
      child.stdin.end(req.prompt);
    }).finally(() => { if (ownCwd) return rm(cwd, { recursive: true, force: true }).catch(() => {}); });

    const envelope = tryParse(stdout);
    if (!envelope) throw new ClaudeCallError(`claude 출력을 JSON으로 읽을 수 없습니다: ${stdout.slice(0, 300)}`, "claude 출력을 JSON으로 읽을 수 없습니다");
    // 기록(error)에는 모델이 쓴 result 문구를 싣지 않고 subtype만 남긴다.
    if (envelope.is_error) throw new ClaudeCallError(`claude 오류: ${String(envelope.result ?? envelope.subtype)}`, `claude 오류: ${envelope.subtype ?? "is_error"}`);
    if (envelope.structured_output === undefined) {
      // 구버전 CLI 호환: result 문자열이 JSON일 수 있다.
      if (typeof envelope.result === "string") { try { return JSON.parse(envelope.result); } catch { /* 아래에서 오류 */ } }
      throw new Error("claude 출력에 structured_output이 없습니다. 구조화 출력(--json-schema)을 지원하는 Claude Code가 필요합니다 (2.1.318에서 확인).");
    }
    return envelope.structured_output;
  }
}

/** jsonl `error`용 한 줄 요약: 첫 줄만, 200자 이내, 비밀 마스킹. */
function logLine(text: string): string {
  return maskSecrets(text.trim().split("\n")[0] ?? "").slice(0, 200);
}

/** 사용자에게 보이는 메시지와 별개로, 사용량 기록에 넣을 요약(stdout 발췌 없음)을 같이 싣는 오류. */
class ClaudeCallError extends Error {
  constructor(message: string, readonly logMessage: string) { super(message); }
}

/** API 과금 경로로 보는 환경 변수. 테스트는 이 전부를 비워 billing 단언을 호스트 환경에서 격리한다. */
export const BILLING_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

/** 환경에서 API 과금 경로로 보이는 신호가 있는가(settings `apiKeyHelper`는 볼 수 없다). */
function detectsApiBilling(env: NodeJS.ProcessEnv): boolean {
  return BILLING_ENV_VARS.some((name) => Boolean(env[name]));
}

const abortError = () => new DOMException("작업이 취소되었습니다", "AbortError");

function tryParse(text: string): ResultEnvelope | null {
  try { return JSON.parse(text) as ResultEnvelope; } catch { return null; }
}
