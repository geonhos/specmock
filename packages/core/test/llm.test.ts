import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
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

  it("요청의 timeoutMs가 생성자 timeoutMs보다 우선한다", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-slow"), timeoutMs: 60_000 });
    await expect(adapter.complete({ prompt: "x", schema, timeoutMs: 200 })).rejects.toThrow("claude 호출 시간 초과 (200ms)");
  }, 5_000);
});

describe("SessionAdapter", () => {
  it("does not call anything and explains what to do", async () => {
    const a = new SessionAdapter();
    await expect(a.complete({ prompt: "x", schema })).rejects.toThrow(/세션 모드/);
    expect(a.name).toBe("session");
  });
});

describe("createAdapter", () => {
  it("maps names and rejects unknown ones", () => {
    expect(createAdapter("claude-code").name).toBe("claude-code");
    expect(createAdapter("session").name).toBe("session");
    expect(() => createAdapter("gpt" as never)).toThrow(/알 수 없는 LLM 어댑터/);
  });
});
