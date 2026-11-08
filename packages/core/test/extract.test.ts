import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extract } from "../src/analyze/extract.js";
import { prepare } from "../src/analyze/prepare.js";
import { ingest } from "../src/ingest/index.js";
import type { LlmAdapter } from "../src/llm/adapter.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PETS_MD = path.join(here, "fixtures", "docs", "pets.md");
const FAKE_CLAUDE = path.join(here, "bin", "claude");

let dir: string; let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-extract-")); ws = new Workspace(dir);
  await ingest(ws, "pets", [PETS_MD]);
  await prepare(ws, "pets", { maxChars: 400, overlap: 50 });   // 청크 여러 개
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fakeAdapter(calls: string[]): LlmAdapter {
  return { name: "claude-code", async extract(req) { calls.push(req.prompt); return { endpoints: [] }; } };
}

describe("extract", () => {
  it("낡은 결과의 manifest 키는 재추출이 실패해도 디스크에서 지워진다", async () => {
    await extract(ws, "pets", fakeAdapter([]));
    const manifestFile = path.join(dir, "pets", "extracted", "manifest.json");
    const m = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, string>;
    m["000"] = "outdated-hash";
    await writeFile(manifestFile, JSON.stringify(m));
    const failing: LlmAdapter = { name: "claude-code", async extract() { throw new Error("boom"); } };
    const r = await extract(ws, "pets", failing);
    expect(r.failed.some((f) => f.chunk === 0)).toBe(true);
    expect(JSON.parse(await readFile(manifestFile, "utf8"))["000"]).toBeUndefined();
  });

  it("writes one extracted/NNN.json per chunk and reports progress", async () => {
    const calls: string[] = []; const progress: string[] = [];
    const result = await extract(ws, "pets", fakeAdapter(calls), { onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
    const files = (await readdir(path.join(dir, "pets", "extracted"))).sort();
    expect(files[0]).toBe("000.json");
    expect(files.filter((f) => /^\d{3,}\.json$/.test(f))).toHaveLength(result.total);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(calls).toHaveLength(result.total);
    expect(calls[0]).toContain("# Pets API");                   // 청크 본문이 프롬프트에 들어감
    expect(progress[progress.length - 1]).toBe(`${result.total}/${result.total}`);
    expect(result.skipped).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, "pets", "extracted", "000.json"), "utf8"))).toEqual({ endpoints: [] });
  });

  it("skips chunks that already have a result unless refresh", async () => {
    const calls: string[] = [];
    await extract(ws, "pets", fakeAdapter(calls));
    const n = calls.length;
    await extract(ws, "pets", fakeAdapter(calls));
    expect(calls).toHaveLength(n);
    const r = await extract(ws, "pets", fakeAdapter(calls), { refresh: true });
    expect(calls).toHaveLength(2 * n);
    expect(r.skipped).toBe(0);
  });

  it("re-extracts only chunks whose text changed after a re-prepare", async () => {
    const calls: string[] = [];
    await extract(ws, "pets", fakeAdapter(calls));
    const n = calls.length;
    const needle = "/pets/{petId}";
    const before = (await readdir(path.join(dir, "pets", "chunks"))).sort();
    const affected = (await Promise.all(before.map((f) => readFile(path.join(dir, "pets", "chunks", f), "utf8")))).filter((t) => t.includes(needle)).length;
    expect(affected).toBeGreaterThan(0);
    expect(affected).toBeLessThan(n);

    const srcFile = path.join(dir, "pets", "source.json");
    const src = (await readFile(srcFile, "utf8")).replaceAll(needle, "/pets/{petXd}");   // 같은 길이라 청크 수는 그대로
    await writeFile(srcFile, src);
    const req = await prepare(ws, "pets", { maxChars: 400, overlap: 50 });
    expect(req.chunks).toHaveLength(n);

    calls.length = 0;
    const r = await extract(ws, "pets", fakeAdapter(calls));
    expect(calls).toHaveLength(affected);
    expect(r.written).toBe(affected);
    expect(r.skipped).toBe(n - affected);
  });

  it("keeps a hand-written result that has no manifest entry, and merge-facing names exclude the manifest", async () => {
    const extractedDir = path.join(dir, "pets", "extracted");
    await mkdir(extractedDir, { recursive: true });
    const handmade = JSON.stringify({ endpoints: [{ method: "GET", path: "/hand", responses: [], evidence: [], confidence: 0.5 }] });
    await writeFile(path.join(extractedDir, "000.json"), handmade);
    const calls: string[] = [];
    const r = await extract(ws, "pets", fakeAdapter(calls));
    expect(r.skipped).toBe(1);
    expect(calls).toHaveLength(r.total - 1);
    expect(await readFile(path.join(extractedDir, "000.json"), "utf8")).toBe(handmade);
    const names = await readdir(extractedDir);
    expect(names).toContain("manifest.json");
    expect(names.filter((f) => /^\d{3,}\.json$/.test(f))).not.toContain("manifest.json");
    expect(JSON.parse(await readFile(path.join(extractedDir, "manifest.json"), "utf8"))["000"]).toBeUndefined();
  });

  it("tolerates a corrupt manifest and prunes entries past the chunk count", async () => {
    const calls: string[] = [];
    await extract(ws, "pets", fakeAdapter(calls));
    const manifestFile = path.join(dir, "pets", "extracted", "manifest.json");
    const m = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, string>;
    m["099"] = "x";
    await writeFile(manifestFile, JSON.stringify(m));
    const n = calls.length;
    await extract(ws, "pets", fakeAdapter(calls));
    expect(calls).toHaveLength(n);
    expect(JSON.parse(await readFile(manifestFile, "utf8"))["099"]).toBeUndefined();
    await writeFile(manifestFile, "{not json");
    await extract(ws, "pets", fakeAdapter(calls));
    expect(calls).toHaveLength(n);   // 깨진 매니페스트면 파일을 손으로 쓴 것으로 보고 유지한다
  });

  it("continues after a failing chunk and reports it", async () => {
    let i = 0;
    const flaky: LlmAdapter = { name: "claude-code", async extract() { if (i++ === 1) throw new Error("boom"); return { endpoints: [] }; } };
    const r = await extract(ws, "pets", flaky);
    expect(r.failed).toEqual([{ chunk: 1, error: "boom" }]);
    expect((await readdir(path.join(dir, "pets", "extracted"))).includes("001.json")).toBe(false);
  });

  it("does not write a result that fails schema validation", async () => {
    const bad: LlmAdapter = { name: "claude-code", async extract() { return { nope: true }; } };
    const r = await extract(ws, "pets", bad);
    expect(r.failed[0].error).toMatch(/스키마/);
    expect(r.written).toBe(0);
  });

  it("works end to end with the fake claude binary", async () => {
    const r = await extract(ws, "pets", new ClaudeCodeAdapter({ command: FAKE_CLAUDE }));
    expect(r.written).toBe(r.total);
    const all = await Promise.all((await readdir(path.join(dir, "pets", "extracted"))).map((f) => readFile(path.join(dir, "pets", "extracted", f), "utf8")));
    expect(all.some((t) => t.includes("/pets/{petId}"))).toBe(true);
  });
});
