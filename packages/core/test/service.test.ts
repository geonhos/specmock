import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmAdapter } from "../src/llm/adapter.js";
import { analyzeSpec, clearExtracted } from "../src/service/analyze.js";
import { getChunk, summarizeChunks } from "../src/service/chunks.js";
import type { ServiceEvent } from "../src/service/events.js";
import { findFeature, listFeatures } from "../src/service/features.js";
import { ingestSpec } from "../src/service/ingest.js";
import { runPipeline } from "../src/service/run.js";
import { resolveMockDir, verifyMock } from "../src/service/verify.js";
import { prepare } from "../src/analyze/prepare.js";
import { submitExtraction } from "../src/analyze/submit.js";
import { generate } from "../src/generate/index.js";
import { select } from "../src/select/index.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE, ROOT_NODE_MODULES } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PETS_MD = path.join(here, "fixtures", "docs", "pets.md");
const GET_PET = { method: "GET", path: "/pets/{petId}", title: "Get a pet", responses: [{ status: 200, example: { id: 1 } }], evidence: ["GET /pets/{petId}"], confidence: 0.9 };

let dir: string; let ws: Workspace; let events: ServiceEvent[];
const onEvent = (e: ServiceEvent) => { events.push(e); };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-svc-"));
  ws = new Workspace(path.join(dir, ".specmock")); events = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ingestSpec", () => {
  it("returns per-input kind/chars/cached plus harvest info and forwards logs as events", async () => {
    const r = await ingestSpec(ws, "petstore", [PETSTORE], { onEvent });
    expect(r.system).toBe("petstore");
    expect(r.file).toBe(ws.file("petstore", "source.json"));
    expect(r.inputs).toEqual([expect.objectContaining({ kind: "openapi", origin: PETSTORE, cached: false, harvestCandidate: [], harvested: false })]);
    expect(events.every((e) => e.stage === "ingest")).toBe(true);
  });
});

describe("analyzeSpec", () => {
  it("openapi input → catalog via openapi", async () => {
    await ingestSpec(ws, "petstore", [PETSTORE]);
    const r = await analyzeSpec(ws, "petstore");
    expect(r).toMatchObject({ mode: "catalog", via: "openapi" });
  });

  it("document input, session → prepared (no extraction)", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    const r = await analyzeSpec(ws, "pets", { onEvent });
    expect(r.mode).toBe("prepared");
    if (r.mode !== "prepared") return;
    expect(r.request.chunks.length).toBeGreaterThan(0);
    expect(r.removed).toBeNull();
  });

  it("refresh clears extracted/ before prepare and reports the count as an event", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    await analyzeSpec(ws, "pets");
    await mkdir(ws.file("pets", "extracted"), { recursive: true });
    await writeFile(ws.file("pets", "extracted/000.json"), '{"endpoints":[]}');
    await writeFile(ws.file("pets", "extracted/manifest.json"), "{}");
    const r = await analyzeSpec(ws, "pets", { refresh: true, onEvent });
    expect(r).toMatchObject({ mode: "prepared", removed: 1 });
    expect(events.map((e) => e.message)).toContain("기존 추출 결과 1개를 지웠습니다");
  });

  it("step merge → catalog via merge, incomplete when chunks are missing", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    await analyzeSpec(ws, "pets");
    const r = await analyzeSpec(ws, "pets", { step: "merge" });
    expect(r).toMatchObject({ mode: "catalog", via: "merge", incomplete: true });
  });

  it("claude-code with an injected adapter → catalog via llm, with progress events", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    const adapter: LlmAdapter = { name: "claude-code", async extract() { return { endpoints: [] }; } };
    const r = await analyzeSpec(ws, "pets", { llm: "claude-code", adapter, onEvent });
    expect(r).toMatchObject({ mode: "catalog", via: "llm", incomplete: false });
    expect(events.some((e) => e.stage === "extract" && e.done !== undefined && e.total !== undefined)).toBe(true);
  });

  it("clearExtracted returns 0 when the directory does not exist", async () => {
    expect(await clearExtracted(ws, "nothing")).toBe(0);
  });
});

describe("chunks", () => {
  it("summarizeChunks marks done only when the manifest hash matches", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    const request = await prepare(ws, "pets", { maxChars: 400, overlap: 50 }); // 청크가 둘 이상 나오도록 작게 자른다
    expect(request.chunks.length).toBeGreaterThan(1);
    const r = { request };
    const c0 = r.request.chunks[0]!;
    await submitExtraction(ws, "pets", { index: c0.index, contentHash: c0.contentHash!, result: { endpoints: [] } });
    await writeFile(ws.file("pets", "extracted/001.json"), '{"endpoints":[]}'); // 손으로 쓴 파일: manifest 없음
    const s = await summarizeChunks(ws, "pets", r.request);
    expect(s[0]).toMatchObject({ index: 0, done: true, contentHash: c0.contentHash });
    expect(s[1]!.done).toBe(false);
    expect(s[0]).not.toHaveProperty("content");
  });

  it("summarizeChunks reports done=false when the manifest hash differs from the chunk (stale)", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    const request = await prepare(ws, "pets");
    const c0 = request.chunks[0]!;
    await submitExtraction(ws, "pets", { index: c0.index, contentHash: c0.contentHash!, result: { endpoints: [] } });
    expect((await summarizeChunks(ws, "pets", request))[0]!.done).toBe(true);
    await writeFile(ws.file("pets", "extracted/manifest.json"), JSON.stringify({ "000": "0".repeat(64) }));
    const s = await summarizeChunks(ws, "pets", request);
    expect(s[0]).toMatchObject({ index: 0, done: false, contentHash: c0.contentHash });
  });

  it("getChunk returns the body; unknown index throws", async () => {
    await ingestSpec(ws, "pets", [PETS_MD]);
    await analyzeSpec(ws, "pets");
    const c = await getChunk(ws, "pets", 0);
    expect(c.content).toContain("# Pets API");
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(getChunk(ws, "pets", 999)).rejects.toThrow(/청크 999/);
  });
});

describe("features", () => {
  beforeEach(async () => { await ingestSpec(ws, "petstore", [PETSTORE]); await analyzeSpec(ws, "petstore"); });

  it("findFeature returns the feature or throws the CLI message", async () => {
    expect((await findFeature(ws, "petstore", "getPet")).path).toBe("/pets/{petId}");
    await expect(findFeature(ws, "petstore", "nope")).rejects.toThrow("알 수 없는 기능 id: nope");
  });

  it("listFeatures returns the table and rows numbered like `specmock list`", async () => {
    const l = await listFeatures(ws, "petstore");
    expect(l.table).toContain("petstore — 5개 기능");
    expect(l.rows).toHaveLength(5);
    expect(l.rows[0]).toEqual(expect.objectContaining({ index: 1, id: expect.any(String), provenance: "openapi", warnings: expect.any(Array) }));
    await expect(listFeatures(ws, "petstore", { group: "nope" })).resolves.toMatchObject({ rows: [], group: "nope" });
  });
});

describe("verify", () => {
  it("resolveMockDir: explicit dir → generate.json → default, and throws the CLI hint when missing", async () => {
    await ingestSpec(ws, "petstore", [PETSTORE]); await analyzeSpec(ws, "petstore");
    await expect(resolveMockDir(ws, "petstore", path.join(dir, "none"))).rejects.toThrow(/먼저 specmock generate petstore 을 실행하거나 --dir 로/);
    await select(ws, "petstore", ["all"]);
    const out = path.join(dir, "elsewhere");
    await generate(ws, "petstore", { outDir: out });
    expect(await resolveMockDir(ws, "petstore")).toBe(out);
  });

  it("resolveMockDir: explicit dir beats generate.json; with neither, falls back to ./mock/<system>", async () => {
    await ingestSpec(ws, "petstore", [PETSTORE]); await analyzeSpec(ws, "petstore");
    await select(ws, "petstore", ["all"]);
    const recorded = path.join(dir, "recorded"); const explicit = path.join(dir, "explicit");
    await generate(ws, "petstore", { outDir: recorded });
    await mkdir(explicit);
    expect(await resolveMockDir(ws, "petstore", explicit)).toBe(explicit);
    expect(await resolveMockDir(ws, "petstore")).toBe(recorded);
    // generate.json이 없고 인자도 없으면 cwd 기준 mock/<system>
    const cwd = process.cwd();
    const root = await mkdtemp(path.join(os.tmpdir(), "specmock-svc-cwd-"));
    try {
      await mkdir(path.join(root, "mock", "nogen"), { recursive: true });
      process.chdir(root);
      expect(await resolveMockDir(ws, "nogen")).toBe(path.join(await realpath(root), "mock", "nogen"));
    } finally { process.chdir(cwd); await rm(root, { recursive: true, force: true }); }
  });

  it("verifyMock writes coverage.md and returns the result", async () => {
    await ingestSpec(ws, "petstore", [PETSTORE]); await analyzeSpec(ws, "petstore");
    await select(ws, "petstore", ["getPet"]);
    const out = path.join(dir, "mock", "petstore");
    await generate(ws, "petstore", { outDir: out });
    await symlink(ROOT_NODE_MODULES, path.join(out, "node_modules"), "dir");
    const v = await verifyMock(ws, "petstore", { onEvent });
    expect(v.dir).toBe(out);
    expect(v.result.failed).toBe(0);
    expect(v.coverageFile).toBe(ws.file("petstore", "coverage.md"));
    expect(await readFile(v.coverageFile, "utf8")).toBe(v.coverageMarkdown);
  });
});

describe("runPipeline", () => {
  it("rejects document input without claude-code with the CLI message", async () => {
    await expect(runPipeline(ws, "pets", [PETS_MD], { verify: false })).rejects.toThrow("문서 입력은 run에서 --llm claude-code 가 필요합니다");
  });

  it("throws when every chunk failed", async () => {
    const adapter: LlmAdapter = { name: "claude-code", async extract() { throw new Error("boom"); } };
    await expect(runPipeline(ws, "pets", [PETS_MD], { llm: "claude-code", adapter, verify: false })).rejects.toThrow(/LLM 추출이 모두 실패했습니다: boom/);
  });

  it("partial extraction failure: continues and sets extractFailed", async () => {
    const big = path.join(dir, "big.md");
    const filler = (n: number) => `${"가나다라마바사 ".repeat(Math.ceil(n / 8))}\n`;
    await writeFile(big, `# Pets\n\nGET /pets/{petId} returns a pet.\n\n${filler(5000)}\n# Other\n\n${filler(5000)}`);
    let calls = 0;
    const adapter: LlmAdapter = { name: "claude-code", async extract() { if (calls++ === 0) return { endpoints: [GET_PET] }; throw new Error("boom"); } };
    const r = await runPipeline(ws, "big", [big], { llm: "claude-code", adapter, verify: false, outDir: path.join(dir, "m") });
    expect(calls).toBeGreaterThan(1);
    expect(r.extractFailed).toBe(true);
    expect(r.extract?.failed.length).toBeGreaterThan(0);
    expect(r.catalog.features).toHaveLength(1);
    expect(r.generate.outDir).toBe(path.join(dir, "m"));
  });

  it("calls onStage in order for openapi input", async () => {
    const stages: string[] = [];
    const r = await runPipeline(ws, "petstore", [PETSTORE], { outDir: path.join(dir, "m"), verify: false, onStage: (s) => { stages.push(s.stage); } });
    expect(stages).toEqual(["catalog", "select", "generate"]);
    expect(r.selection.resolved).toHaveLength(5);
    expect(r.verify).toBeNull();
    expect(r.extractFailed).toBe(false);
  });
});
