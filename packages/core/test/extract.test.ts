import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  it("writes one extracted/NNN.json per chunk and reports progress", async () => {
    const calls: string[] = []; const progress: string[] = [];
    const result = await extract(ws, "pets", fakeAdapter(calls), { onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
    const files = (await readdir(path.join(dir, "pets", "extracted"))).sort();
    expect(files[0]).toBe("000.json");
    expect(files).toHaveLength(result.total);
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
