import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockBusyError, Workspace, analyzeSpec, clearExtracted, ingestSpec, listFeatures, prepare, pruneExtracted, select, submitExtraction, withSystemLock } from "../src/index.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "fixtures", "lock-child.ts");

function child(args: string[]): { done: Promise<string>; firstLine: Promise<string>; pid: number } {
  const p = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  let resolveLine!: (s: string) => void;
  const firstLine = new Promise<string>((r) => { resolveLine = r; });
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolveLine(out.split("\n")[0]!); });
  const done = new Promise<string>((resolve, reject) => p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)))));
  return { done, firstLine, pid: p.pid! };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-lock-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("withSystemLock", () => {
  it("다른 프로세스가 쥐고 있으면 timeoutMs 뒤 LockBusyError(code busy)", async () => {
    const ws = new Workspace(root);
    await mkdir(ws.dir("pets"), { recursive: true });
    const holder = child(["hold", root, "pets", "1500"]);
    expect(await holder.firstLine).toBe("locked");
    const err = await withSystemLock(ws, "pets", async () => "ran", { timeoutMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect(err.code).toBe("busy");
    await holder.done;
    expect(await withSystemLock(ws, "pets", async () => "ran")).toBe("ran");
  });

  it("죽은 pid의 잠금은 회수한다", async () => {
    const ws = new Workspace(root);
    const dead = child(["hold", root, "other", "0"]);
    await dead.done;
    await mkdir(ws.dir("pets"), { recursive: true });
    await writeFile(path.join(ws.dir("pets"), ".lock"), JSON.stringify({ pid: dead.pid, at: new Date().toISOString(), token: "t" }));
    expect(await withSystemLock(ws, "pets", async () => "ran", { timeoutMs: 500 })).toBe("ran");
  });

  it("살아 있는 pid라도 staleMs를 넘긴 잠금은 회수한다", async () => {
    const ws = new Workspace(root);
    await mkdir(ws.dir("pets"), { recursive: true });
    const old = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path.join(ws.dir("pets"), ".lock"), JSON.stringify({ pid: process.pid, at: old, token: "t" }));
    expect(await withSystemLock(ws, "pets", async () => "ran", { timeoutMs: 500, staleMs: 1_000 })).toBe("ran");
  });

  it("빈 잠금 파일(내용 없음)은 mtime이 오래되면 회수하고 새 잠금을 잡는다", async () => {
    const ws = new Workspace(root);
    await mkdir(ws.dir("pets"), { recursive: true });
    const lockFile = path.join(ws.dir("pets"), ".lock");
    await writeFile(lockFile, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    let during: string | null = null;
    expect(await withSystemLock(ws, "pets", async () => { during = await readFile(lockFile, "utf8"); return "ran"; }, { timeoutMs: 500 })).toBe("ran");
    expect(JSON.parse(during!).pid).toBe(process.pid);
    await expect(readFile(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("심볼릭 링크로 연 작업 공간도 같은 잠금(프로세스 안에서 순서 보장)", async () => {
    const real = path.join(root, "real");
    await mkdir(path.join(real, "pets"), { recursive: true });
    const alias = path.join(root, "alias");
    await symlink(real, alias);
    const a = new Workspace(real), b = new Workspace(alias);
    const order: string[] = [];
    let release!: () => void;
    const first = withSystemLock(a, "pets", () => new Promise<void>((r) => { order.push("a-start"); release = () => { order.push("a-end"); r(); }; }));
    await new Promise((r) => setTimeout(r, 20));
    const second = withSystemLock(b, "pets", async () => { order.push("b"); });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("끝나면 .lock을 지운다(예외로 끝나도)", async () => {
    const ws = new Workspace(root);
    await mkdir(ws.dir("pets"), { recursive: true });
    await expect(withSystemLock(ws, "pets", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(readFile(path.join(ws.dir("pets"), ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("없는 시스템·정리 함수의 잠금", () => {
  it("없는 시스템에는 빈 디렉터리를 만들지 않고, select는 기존 오류 문구로 실패한다", async () => {
    const ws = new Workspace(root);
    const err = await select(ws, "ghost", ["GET /x"]).catch((e) => e);
    expect(err.message).toContain("catalog.json 파일이 없습니다");
    await expect(readdir(ws.dir("ghost"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pruneExtracted와 clearExtracted는 잠금을 기다린다", async () => {
    const ws = new Workspace(root);
    await mkdir(ws.file("pets", "extracted"), { recursive: true });
    await writeFile(ws.file("pets", "extracted/005.json"), "{}");
    await writeFile(ws.file("pets", "extracted/manifest.json"), JSON.stringify({ "005": "h" }));
    let release!: () => void;
    const held = withSystemLock(ws, "pets", () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 20));
    let pruned = false, cleared = false;
    const p1 = pruneExtracted(ws, "pets", 1).then(() => { pruned = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(pruned).toBe(false);
    release();
    await Promise.all([held, p1]);
    expect(pruned).toBe(true);
    await writeFile(ws.file("pets", "extracted/001.json"), "{}");
    let release2!: () => void;
    const held2 = withSystemLock(ws, "pets", () => new Promise<void>((r) => { release2 = r; }));
    await new Promise((r) => setTimeout(r, 20));
    const p2 = clearExtracted(ws, "pets").then(() => { cleared = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(cleared).toBe(false);
    release2();
    await Promise.all([held2, p2]);
    expect(cleared).toBe(true);
  });
});

describe("submitExtraction 교차 프로세스", () => {
  it("자식 프로세스 6개가 동시에 서로 다른 청크를 제출해도 manifest에 전부 남는다", async () => {
    const ws = new Workspace(root);
    // 청크 6개짜리 문서
    const doc = Array.from({ length: 6 }, (_, i) => `## Section ${i}\n\n${"text ".repeat(120)}`).join("\n\n");
    await ingestText(ws, "pets", doc);
    const req = await prepare(ws, "pets", { maxChars: 700, overlap: 50 });
    expect(req.chunks.length).toBeGreaterThanOrEqual(6);
    const kids = req.chunks.slice(0, 6).map((c) => child(["submit", root, "pets", String(c.index)]));
    await Promise.all(kids.map((k) => k.done));
    const manifest = JSON.parse(await readFile(ws.file("pets", "extracted/manifest.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(req.chunks.slice(0, 6).map((c) => String(c.index).padStart(3, "0")).sort());
  });

  it("manifest 쓰기가 실패하면 방금 쓴 NNN.json을 지운다", async () => {
    const ws = new Workspace(root);
    await ingestText(ws, "pets", "## A\n\nGET /pets returns pets.\n");
    const req = await prepare(ws, "pets");
    // manifest.json 자리를 비어 있지 않은 디렉터리로 만들어 쓰기를 실패시킨다(2A Task 2와 같은 방법).
    await mkdir(ws.file("pets", "extracted/manifest.json/x"), { recursive: true });
    const c = req.chunks[0]!;
    await expect(submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [] } })).rejects.toThrow();
    await expect(readFile(ws.file("pets", "extracted/000.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("listFeatures", () => {
  it("모르는 그룹은 예외 대신 빈 rows", async () => {
    const ws = new Workspace(root);
    await petstoreCatalog(ws, "pets");
    const r = await listFeatures(ws, "pets", { group: "nope" });
    expect(r.rows).toEqual([]);
    expect(r.total).toBeGreaterThan(0);
    expect(r.group).toBe("nope");
  });
});

async function ingestText(ws: Workspace, system: string, text: string): Promise<void> {
  const f = path.join(root, "doc.md");
  await writeFile(f, text);
  await ingestSpec(ws, system, [f]);
}

async function petstoreCatalog(ws: Workspace, system: string): Promise<void> {
  await ingestSpec(ws, system, [PETSTORE]);
  await analyzeSpec(ws, system);
}
