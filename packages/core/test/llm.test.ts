import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BILLING_ENV_VARS, ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import type { LlmUsage } from "../src/llm/adapter.js";
import { createAdapter } from "../src/llm/index.js";
import { SessionAdapter } from "../src/llm/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const schema = { type: "object", required: ["endpoints"], properties: { endpoints: { type: "array" } } };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-llm-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ClaudeCodeAdapter", () => {
  it("spawns claude with --print --output-format json --json-schema and returns structured_output", async () => {
    const argsLog = path.join(dir, "args.txt");
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude"), model: "sonnet", env: { ARGS_LOG: argsLog } });
    const out = await adapter.complete({ prompt: "find `GET /pets/{petId}` returns one pet.", schema });
    expect(out).toMatchObject({ endpoints: [{ method: "GET", path: "/pets/{petId}" }] });
    const args = (await readFile(argsLog, "utf8")).split("\n");   // trim 금지: 마지막 인자가 빈 문자열일 수 있다
    expect(args).toContain("--print");
    expect(args).toContain("--output-format"); expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--json-schema"); expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(schema);
    expect(args).toContain("--model"); expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--tools"); expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("runs the child in an empty temp cwd, not the caller's cwd, and cleans it up", async () => {
    const cwdLog = path.join(dir, "cwd.txt");
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-cwd"), env: { CWD_LOG: cwdLog } });
    await adapter.complete({ prompt: "x", schema });
    const childCwd = (await readFile(cwdLog, "utf8")).trim();
    expect(childCwd).not.toBe(await realpath(process.cwd()));
    expect(childCwd.startsWith(await realpath(os.tmpdir()))).toBe(true);
    expect(path.basename(childCwd)).toMatch(/^specmock-claude-/);
    await expect(stat(childCwd)).rejects.toThrow();
  });

  it("uses opts.cwd when given and does not remove it", async () => {
    const cwdLog = path.join(dir, "cwd.txt");
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-cwd"), cwd: dir, env: { CWD_LOG: cwdLog } });
    await adapter.complete({ prompt: "x", schema });
    expect((await readFile(cwdLog, "utf8")).trim()).toBe(await realpath(dir));
    await expect(stat(dir)).resolves.toBeTruthy();
  });

  it("surfaces the CLI error message when claude fails", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-fail") });
    await expect(adapter.complete({ prompt: "x", schema })).rejects.toThrow(/Not logged in/);
  });

  it("fails fast when the command does not exist", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "nope") });
    await expect(adapter.complete({ prompt: "x", schema })).rejects.toThrow(/claude CLI를 실행할 수 없습니다/);
  });

  it("keeps multi-byte characters intact when output is split mid-character", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-split") });
    const out = (await adapter.complete({ prompt: "x", schema })) as { note: string };
    expect(out.note).toBe("한글 한글");
  });

  it("disables session persistence and puts --tools right before extraArgs", async () => {
    const argsLog = path.join(dir, "args.txt");
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude"), extraArgs: ["--verbose"], env: { ARGS_LOG: argsLog } });
    await adapter.complete({ prompt: "x", schema });
    const args = (await readFile(argsLog, "utf8")).split("\n");
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 3)).toEqual(["--tools", "", "--verbose"]);
  });

  it("reports is_error envelopes even with exit code 0", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-iserror") });
    await expect(adapter.complete({ prompt: "x", schema })).rejects.toThrow("claude 오류: Reached max turns");
  });

  it("falls back to a JSON result string when structured_output is missing", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-legacy") });
    await expect(adapter.complete({ prompt: "x", schema })).resolves.toEqual({ endpoints: [] });
  });

  it("explains a missing structured_output", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-nostruct") });
    await expect(adapter.complete({ prompt: "x", schema })).rejects.toThrow(/structured_output이 없습니다/);
  });

  it("rejects non-JSON stdout", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-garbage") });
    await expect(adapter.complete({ prompt: "x", schema })).rejects.toThrow(/JSON으로 읽을 수 없습니다: this is not json/);
  });

  it("times out", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-slow"), timeoutMs: 200 });
    await expect(adapter.complete({ prompt: "x", schema })).rejects.toThrow(/시간 초과/);
  }, 5_000);

  it("생성자 timeoutMs가 요청의 timeoutMs보다 우선한다", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-slow"), timeoutMs: 200 });
    await expect(adapter.complete({ prompt: "x", schema, timeoutMs: 60_000 })).rejects.toThrow("claude 호출 시간 초과 (200ms)");
  }, 5_000);
});

describe("ClaudeCodeAdapter onUsage", () => {
  /** billing 단언이 호스트 환경(API 키, Bedrock, Vertex)에 흔들리지 않게 감지 대상을 모두 비운다. */
  const noBilling: Record<string, string> = Object.fromEntries(BILLING_ENV_VARS.map((n) => [n, ""]));
  const collect = () => { const got: LlmUsage[] = []; return { got, onUsage: (u: LlmUsage) => { got.push(u); } }; };

  it("봉투의 usage · 비용 · 시간을 onUsage로 넘긴다", async () => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-usage"), env: { ...noBilling } });
    const before = Date.now();
    await adapter.complete({ prompt: "x", schema, onUsage });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      model: "claude-sonnet-4-5", inputTokens: 1842, outputTokens: 611, cacheReadTokens: 12, cacheCreationTokens: 3977,
      costUsd: 0.0219, costBasis: "list", billing: "subscription", apiDurationMs: 8870, ok: true,
    });
    expect(got[0]!.error).toBeUndefined();
    expect(Date.parse(got[0]!.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(got[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("ANTHROPIC_API_KEY가 있으면 billing은 api-key", async () => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-usage"), env: { ...noBilling, ANTHROPIC_API_KEY: "sk-test" } });
    await adapter.complete({ prompt: "x", schema, onUsage });
    expect(got[0]!.billing).toBe("api-key");
  });

  it.each([["ANTHROPIC_AUTH_TOKEN", "tok"], ["CLAUDE_CODE_USE_BEDROCK", "1"], ["CLAUDE_CODE_USE_VERTEX", "1"]])("%s가 있으면 billing은 api-key", async (name, value) => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-usage"), env: { ...noBilling, [name]: value } });
    await adapter.complete({ prompt: "x", schema, onUsage });
    expect(got[0]!.billing).toBe("api-key");
  });

  it("usage가 없는 봉투는 토큰 필드가 null이고 실패가 아니다", async () => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude"), model: "sonnet" });
    await adapter.complete({ prompt: "x", schema, onUsage });
    expect(got[0]).toMatchObject({
      ok: true, model: "sonnet", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
      costUsd: null, costBasis: null, apiDurationMs: null,
    });
    expect(typeof got[0]!.durationMs).toBe("number");
  });

  it("실패(종료 코드)도 ok:false · durationMs와 함께 기록한다", async () => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-fail") });
    await expect(adapter.complete({ prompt: "x", schema, onUsage })).rejects.toThrow(/Not logged in/);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ok: false, inputTokens: null, model: null });
    expect(got[0]!.error).toMatch(/Not logged in/);
    expect(typeof got[0]!.durationMs).toBe("number");
  });

  it("is_error 봉투는 토큰을 채우고 error는 비밀을 마스킹한다", async () => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-usage"), env: { USAGE_FAIL: "1" } });
    await expect(adapter.complete({ prompt: "x", schema, onUsage })).rejects.toThrow(/boom/);
    expect(got[0]).toMatchObject({ ok: false, inputTokens: 5, outputTokens: 1, costUsd: 0.001 });
    // 모델이 쓴 result 문구(boom, 토큰)는 기록에 없고 subtype만 남는다.
    expect(got[0]!.error).toBe("claude 오류: error_during_execution");
  });

  it("시간 초과와 JSON 파싱 실패도 한 번씩 기록한다", async () => {
    const a = collect();
    await expect(new ClaudeCodeAdapter({ command: path.join(BIN, "claude-slow"), timeoutMs: 200 }).complete({ prompt: "x", schema, onUsage: a.onUsage })).rejects.toThrow(/시간 초과/);
    expect(a.got).toHaveLength(1);
    expect(a.got[0]).toMatchObject({ ok: false });
    expect(a.got[0]!.error).toMatch(/시간 초과/);
    const b = collect();
    await expect(new ClaudeCodeAdapter({ command: path.join(BIN, "claude-garbage") }).complete({ prompt: "x", schema, onUsage: b.onUsage })).rejects.toThrow(/JSON으로 읽을 수 없습니다/);
    expect(b.got).toHaveLength(1);
    expect(b.got[0]!.ok).toBe(false);
  }, 5_000);

  it("실행할 수 없는 command(spawn 실패)도 ok:false · durationMs ≥ 0으로 기록한다", async () => {
    const { got, onUsage } = collect();
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "no-such-claude") });
    await expect(adapter.complete({ prompt: "x", schema, onUsage })).rejects.toThrow(/실행할 수 없습니다/);
    expect(got).toHaveLength(1);
    expect(got[0]!.ok).toBe(false);
    expect(got[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("error는 첫 줄 200자 이내이고 stdout 발췌를 넣지 않는다(사용자에게 던지는 예외는 그대로)", async () => {
    const a = collect();
    await expect(new ClaudeCodeAdapter({ command: path.join(BIN, "claude-garbage") }).complete({ prompt: "x", schema, onUsage: a.onUsage })).rejects.toThrow(/this is not json/);
    expect(a.got[0]!.error).toBe("claude 출력을 JSON으로 읽을 수 없습니다");
    const b = collect();
    await expect(new ClaudeCodeAdapter({ command: path.join(BIN, "claude-usage"), env: { USAGE_FAIL: "1", USAGE_FAIL_LONG: "1" } }).complete({ prompt: "x", schema, onUsage: b.onUsage })).rejects.toThrow(/boom/);
    expect(b.got[0]!.error!.length).toBeLessThanOrEqual(200);
    expect(b.got[0]!.error).not.toContain("\n");
    expect(b.got[0]!.error).not.toContain("SECOND-LINE");
  });

  it("onUsage가 던져도 결과를 잃지 않고 경고만 낸다", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-usage") });
    const orig = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((c: string | Uint8Array) => { lines.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      await expect(adapter.complete({ prompt: "x", schema, onUsage: () => { throw new Error("cb bug"); } })).resolves.toEqual({ endpoints: [] });
    } finally { process.stderr.write = orig; }
    expect(lines.join("")).toMatch(/경고.*cb bug/);
  });
});

describe("SessionAdapter", () => {
  it("does not call anything and explains what to do", async () => {
    const a = new SessionAdapter();
    await expect(a.complete({ prompt: "x", schema })).rejects.toThrow(/세션 모드/);
    expect(a.name).toBe("session");
  });
  it("호출처가 안내 문구를 넘길 수 있다", async () => {
    await expect(new SessionAdapter("지시서를 따르세요").complete({ prompt: "x", schema })).rejects.toThrow(/지시서를 따르세요/);
    await expect(new SessionAdapter().complete({ prompt: "x", schema })).rejects.not.toThrow(/analyze/);
  });
});

describe("createAdapter", () => {
  it("maps names and rejects unknown ones", () => {
    expect(createAdapter("claude-code").name).toBe("claude-code");
    expect(createAdapter("session").name).toBe("session");
    expect(() => createAdapter("gpt" as never)).toThrow(/알 수 없는 LLM 어댑터/);
  });
});
