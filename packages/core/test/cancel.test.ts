import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClaudeCodeAdapter, Workspace, analyze, analyzeSpec, generate, ingestSpec, select, summarizeChunks } from "../src/index.js";
import { verifyMock } from "../src/service/verify.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const PETS_MD = path.join(here, "..", "..", "..", "examples", "docs-sample", "pets-api.md");
let root: string, pidFile: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-cancel-")); pidFile = path.join(root, "pid"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timeout");
}
const readPid = async () => Number((await readFile(pidFile, "utf8").catch(() => "")).trim());

it("추출 중 abort하면 claude 자식을 죽이고 AbortError로 끝나며, 실패 청크로 기록하지 않는다", async () => {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "pets", [PETS_MD]);
  const ac = new AbortController();
  const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-pid"), env: { PID_FILE: pidFile } });
  const run = analyzeSpec(ws, "pets", { llm: "claude-code", adapter, signal: ac.signal });
  await waitFor(async () => (await readPid()) > 0);
  const pid = await readPid();
  ac.abort();
  const err = await run.catch((e) => e);
  expect(err.name).toBe("AbortError");
  await waitFor(async () => !isAlive(pid));
  expect((await summarizeChunks(ws, "pets")).every((c) => !c.done)).toBe(true);
});

it("시작 전에 이미 abort된 signal이면 claude를 띄우지 않는다", async () => {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "pets", [PETS_MD]);
  const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-pid"), env: { PID_FILE: pidFile } });
  const err = await analyzeSpec(ws, "pets", { llm: "claude-code", adapter, signal: AbortSignal.abort() }).catch((e) => e);
  expect(err.name).toBe("AbortError");
  await expect(readFile(pidFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it("검증 중 abort하면 npm install 자식을 죽이고 AbortError로 끝난다", async () => {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["all"]);
  const out = path.join(root, "mock");
  await generate(ws, "petstore", { outDir: out });   // node_modules 없음 → npm install 경로
  const fakeBin = path.join(root, "fakebin");
  await mkdir(fakeBin);
  await copyFile(path.join(BIN, "claude-pid"), path.join(fakeBin, "npm"));
  await (await import("node:fs/promises")).chmod(path.join(fakeBin, "npm"), 0o755);
  const oldPath = process.env.PATH, oldPid = process.env.PID_FILE;
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath}`;
  process.env.PID_FILE = pidFile;
  try {
    const ac = new AbortController();
    const run = verifyMock(ws, "petstore", { dir: out, signal: ac.signal });
    await waitFor(async () => (await readPid()) > 0);
    const pid = await readPid();
    ac.abort();
    const err = await run.catch((e) => e);
    expect(err.name).toBe("AbortError");
    await waitFor(async () => !isAlive(pid));
  } finally {
    process.env.PATH = oldPath;
    if (oldPid === undefined) delete process.env.PID_FILE; else process.env.PID_FILE = oldPid;
  }
});
