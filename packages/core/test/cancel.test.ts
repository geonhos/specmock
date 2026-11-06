import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClaudeCodeAdapter, Workspace, analyze, analyzeSpec, extract, generate, ingestSpec, prepare, select, summarizeChunks } from "../src/index.js";
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

async function verifyFixture() {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["all"]);
  const out = path.join(root, "mock");
  await generate(ws, "petstore", { outDir: out });
  const fakeBin = path.join(root, "fakebin2");
  await mkdir(fakeBin);
  await copyFile(path.join(BIN, "npm-tree"), path.join(fakeBin, "npm"));
  await chmod(path.join(fakeBin, "npm"), 0o755);
  return { ws, out, fakeBin };
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

it("npm install 취소 시 손자 프로세스도 죽고, 다음 verify는 install을 다시 한다", async () => {
  const { ws, out, fakeBin } = await verifyFixture();
  const gcFile = path.join(root, "gc"), log = path.join(root, "install.log");
  await withEnv({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, PID_FILE: pidFile, GRANDCHILD_FILE: gcFile, INSTALL_LOG: log }, async () => {
    const ac = new AbortController();
    const run = verifyMock(ws, "petstore", { dir: out, signal: ac.signal });
    await waitFor(async () => (await readPid()) > 0);
    const gc = Number((await readFile(gcFile, "utf8")).trim());
    expect(isAlive(gc)).toBe(true);
    ac.abort();
    expect((await run.catch((e) => e)).name).toBe("AbortError");
    await waitFor(async () => !isAlive(gc));
    // 반쯤 쓰인 node_modules가 남아 있으면 안 된다.
    await expect(access(path.join(out, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  // 다음 verify는 install을 다시 시도한다(가짜 npm이 이번에는 바로 성공).
  await withEnv({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAST: "1", INSTALL_LOG: log }, async () => {
    await verifyMock(ws, "petstore", { dir: out }).catch(() => {});
  });
  expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
});

it("마커 없는 node_modules(중단된 install)는 다시 설치한다", async () => {
  const { ws, out, fakeBin } = await verifyFixture();
  await mkdir(path.join(out, "node_modules", "half"), { recursive: true });
  const log = path.join(root, "install.log");
  await withEnv({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAST: "1", INSTALL_LOG: log }, async () => {
    await verifyMock(ws, "petstore", { dir: out }).catch(() => {});
  });
  expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
});

it("이미 abort된 signal이면 install을 시작하지 않는다", async () => {
  const { ws, out, fakeBin } = await verifyFixture();
  const log = path.join(root, "install.log");
  await withEnv({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAST: "1", INSTALL_LOG: log }, async () => {
    const err = await verifyMock(ws, "petstore", { dir: out, signal: AbortSignal.abort() }).catch((e) => e);
    expect(err.name).toBe("AbortError");
  });
  await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
});

it("청크 0 완료 후 청크 1 중 취소해도 청크 0 결과는 남는다", async () => {
  const ws = new Workspace(path.join(root, ".specmock"));
  const doc = Array.from({ length: 4 }, (_, i) => `## Section ${i}\n\n${"text ".repeat(120)}`).join("\n\n");
  const f = path.join(root, "doc.md");
  await writeFile(f, doc);
  await ingestSpec(ws, "pets", [f]);
  const req = await prepare(ws, "pets", { maxChars: 700, overlap: 50 });
  expect(req.chunks.length).toBeGreaterThanOrEqual(2);
  const ac = new AbortController();
  let calls = 0;
  const adapter = {
    name: "claude-code" as const,
    extract: (r: { signal?: AbortSignal }) => {
      if (++calls === 1) return Promise.resolve({ endpoints: [] });
      return new Promise<never>((_, reject) => {
        r.signal!.addEventListener("abort", () => reject(r.signal!.reason), { once: true });
        queueMicrotask(() => ac.abort());
      });
    },
  };
  const err = await extract(ws, "pets", adapter, { signal: ac.signal }).catch((e) => e);
  expect(err.name).toBe("AbortError");
  const chunks = await summarizeChunks(ws, "pets");
  expect(chunks[0]!.done).toBe(true);
  expect(chunks.slice(1).every((c) => !c.done)).toBe(true);
});
