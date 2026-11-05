import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtractRequest, LlmAdapter } from "./adapter.js";

export interface ClaudeCodeOptions {
  command?: string;        // 기본 "claude"
  model?: string;          // 기본: CLI 기본 모델
  timeoutMs?: number;      // 기본 180_000
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;            // 기본: 호출마다 만드는 빈 임시 디렉터리
}

interface ResultEnvelope { is_error?: boolean; subtype?: string; result?: unknown; structured_output?: unknown }

/**
 * 로컬 Claude Code 구독으로 추출한다. `claude --print --output-format json --json-schema <schema> --tools ""`를
 * 자식 프로세스로 띄우고 프롬프트를 stdin으로 준다. 도구를 비워 파일 접근 없이 텍스트만 보게 하고,
 * `--no-session-persistence`로 청크마다 ~/.claude/projects 아래 대화 기록이 쌓이지 않게 한다.
 *
 * `extraArgs`는 옵션(`--flag`)만 넣는다. `--tools`는 가변 인자라 그 뒤에 위치 인자를 두면 삼켜진다.
 * 자식은 빈 임시 디렉터리에서 실행한다. 호출자 cwd의 .claude/settings.json(agent·hook 등)과 CLAUDE.md를 상속하지 않게 하기 위해서다.
 * 부모 환경에 ANTHROPIC_API_KEY가 있으면 claude가 구독 대신 API 키로 과금한다(일부러 제거하지 않는다).
 */
export class ClaudeCodeAdapter implements LlmAdapter {
  readonly name = "claude-code" as const;
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async extract(req: ExtractRequest): Promise<unknown> {
    const args = ["--print", "--output-format", "json", "--json-schema", JSON.stringify(req.schema), "--no-session-persistence"];
    if (this.opts.model) args.push("--model", this.opts.model);
    args.push("--tools", "");   // 마지막 고정 플래그. 뒤에는 extraArgs 옵션만 온다.
    args.push(...(this.opts.extraArgs ?? []));
    const command = this.opts.command ?? "claude";
    const timeoutMs = this.opts.timeoutMs ?? 180_000;

    const ownCwd = this.opts.cwd === undefined;
    const cwd = this.opts.cwd ?? (await mkdtemp(path.join(os.tmpdir(), "specmock-claude-")));
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.opts.env } });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude 호출 시간 초과 (${timeoutMs}ms)`)); }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude CLI를 실행할 수 없습니다 (${command}): ${e.message}. Claude Code가 설치돼 있고 PATH에 있는지 확인하세요.`)); });
      // 멀티바이트 문자가 파이프 읽기 경계에서 쪼개져도 깨지지 않도록 스트림이 디코딩하게 한다.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        // 실패해도 JSON 봉투를 내는 경우가 있으므로 메시지를 뽑아 본다.
        const message = tryParse(out)?.result;
        if (code === null) return reject(new Error(`claude 종료 (signal ${signal}): ${err.trim() || out.trim().slice(0, 300)}`));
        reject(new Error(`claude 종료 코드 ${code}: ${typeof message === "string" ? message : err.trim() || out.trim().slice(0, 300)}`));
      });
      child.stdin.on("error", () => { /* 자식이 먼저 죽으면 EPIPE. close에서 처리된다. */ });
      child.stdin.end(req.prompt);
    }).finally(() => { if (ownCwd) return rm(cwd, { recursive: true, force: true }); });

    const envelope = tryParse(stdout);
    if (!envelope) throw new Error(`claude 출력을 JSON으로 읽을 수 없습니다: ${stdout.slice(0, 300)}`);
    if (envelope.is_error) throw new Error(`claude 오류: ${String(envelope.result ?? envelope.subtype)}`);
    if (envelope.structured_output === undefined) {
      // 구버전 CLI 호환: result 문자열이 JSON일 수 있다.
      if (typeof envelope.result === "string") { try { return JSON.parse(envelope.result); } catch { /* 아래에서 오류 */ } }
      throw new Error("claude 출력에 structured_output이 없습니다. 구조화 출력(--json-schema)을 지원하는 Claude Code가 필요합니다 (2.1.318에서 확인).");
    }
    return envelope.structured_output;
  }
}

function tryParse(text: string): ResultEnvelope | null {
  try { return JSON.parse(text) as ResultEnvelope; } catch { return null; }
}
