import { spawn } from "node:child_process";
import type { ExtractRequest, LlmAdapter } from "./adapter.js";

export interface ClaudeCodeOptions {
  command?: string;        // 기본 "claude"
  model?: string;          // 기본: CLI 기본 모델
  timeoutMs?: number;      // 기본 180_000
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

interface ResultEnvelope { is_error?: boolean; subtype?: string; result?: unknown; structured_output?: unknown }

/**
 * 로컬 Claude Code 구독으로 추출한다. `claude --print --output-format json --json-schema <schema> --tools ""`를
 * 자식 프로세스로 띄우고 프롬프트를 stdin으로 준다. 도구를 비워 파일 접근 없이 텍스트만 보게 한다.
 */
export class ClaudeCodeAdapter implements LlmAdapter {
  readonly name = "claude-code" as const;
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async extract(req: ExtractRequest): Promise<unknown> {
    const args = ["--print", "--output-format", "json", "--json-schema", JSON.stringify(req.schema), "--tools", ""];
    if (this.opts.model) args.push("--model", this.opts.model);
    args.push(...(this.opts.extraArgs ?? []));
    const command = this.opts.command ?? "claude";
    const timeoutMs = this.opts.timeoutMs ?? 180_000;

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.opts.env } });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude 호출 시간 초과 (${timeoutMs}ms)`)); }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude CLI를 실행할 수 없습니다 (${command}): ${e.message}. Claude Code가 설치돼 있고 PATH에 있는지 확인하세요.`)); });
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        // 실패해도 JSON 봉투를 내는 경우가 있으므로 메시지를 뽑아 본다.
        const message = tryParse(out)?.result;
        reject(new Error(`claude 종료 코드 ${code}: ${typeof message === "string" ? message : err.trim() || out.trim().slice(0, 300)}`));
      });
      child.stdin.on("error", () => { /* 자식이 먼저 죽으면 EPIPE. close에서 처리된다. */ });
      child.stdin.end(req.prompt);
    });

    const envelope = tryParse(stdout);
    if (!envelope) throw new Error(`claude 출력을 JSON으로 읽을 수 없습니다: ${stdout.slice(0, 300)}`);
    if (envelope.is_error) throw new Error(`claude 오류: ${String(envelope.result ?? envelope.subtype)}`);
    if (envelope.structured_output === undefined) {
      // 구버전 CLI 호환: result 문자열이 JSON일 수 있다.
      if (typeof envelope.result === "string") { try { return JSON.parse(envelope.result); } catch { /* 아래에서 오류 */ } }
      throw new Error("claude 출력에 structured_output이 없습니다. Claude Code 2.1 이상이 필요합니다 (claude --version).");
    }
    return envelope.structured_output;
  }
}

function tryParse(text: string): ResultEnvelope | null {
  try { return JSON.parse(text) as ResultEnvelope; } catch { return null; }
}
