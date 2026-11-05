import { readFile, realpath, mkdtemp, rm, writeFile, cp, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/names.js";
import { connect, DOCS_SAMPLE, PETSTORE, ROOT_NODE_MODULES, type Session } from "./helpers.js";

let dir: string; let s: Session;
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-mcp-"))); s = await connect(dir); });
afterEach(async () => { await s.close(); await rm(dir, { recursive: true, force: true }); });

/** examples/docs-sample을 임시 디렉터리로 복사한다(원본을 건드리지 않는다). */
async function copySample(): Promise<{ pets: string; recorded: unknown }> {
  const sample = path.join(dir, "docs-sample");
  await cp(DOCS_SAMPLE, sample, { recursive: true });
  return { pets: path.join(sample, "pets-api.md"), recorded: JSON.parse(await readFile(path.join(sample, "extracted", "000.json"), "utf8")) };
}

describe("tool registry", () => {
  it("registers exactly TOOL_NAMES (10 tools, no leftovers)", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(10);
  });
});

describe("document path: ingest → analyze → get_chunk → submit → merge", () => {
  it("extracts via submitted results and records the manifest; every path is absolute", async () => {
    const { pets, recorded } = await copySample();
    const ing = await s.ok("ingest_spec", { system: "pets", origins: [pets] });
    expect(ing.inputs[0]).toMatchObject({ kind: "markdown", cached: false });
    expect(path.isAbsolute(ing.file)).toBe(true);
    expect(ing.file).toBe(path.join(dir, ".specmock", "pets", "source.json"));

    const a = await s.ok("analyze_spec", { system: "pets" });
    expect(a.mode).toBe("needs-extraction");
    expect(typeof a.prompt).toBe("string");
    expect(a.schema).toHaveProperty("properties.endpoints");
    expect(a.chunks.length).toBeGreaterThan(0);
    for (const c of a.chunks) {
      expect(c).not.toHaveProperty("content");
      expect(c).not.toHaveProperty("file");
      expect(c.done).toBe(false);
    }

    for (const c of a.chunks) {
      const chunk = await s.ok("get_chunk", { system: "pets", index: c.index });
      expect(chunk.contentHash).toBe(c.contentHash);
      expect(chunk).not.toHaveProperty("content"); // 본문은 structuredContent에 중복하지 않는다
      expect(chunk).not.toHaveProperty("file");
      const body = await s.text("get_chunk", { system: "pets", index: c.index });
      expect(body.length).toBeGreaterThan(0);
      expect(body.startsWith("{")).toBe(false); // JSON 이스케이프 없이 원문
      const sub = await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: chunk.contentHash, result: c.index === 0 ? recorded : { endpoints: [] } });
      expect(sub.ok).toBe(true);
      expect(sub.remaining).toEqual(a.chunks.filter((x: { index: number }) => x.index > c.index).map((x: { index: number }) => x.index));
      expect(path.isAbsolute(sub.file)).toBe(true);
      expect(sub.file).toBe(path.join(dir, ".specmock", "pets", "extracted", `${String(c.index).padStart(3, "0")}.json`));
    }
    const manifest = JSON.parse(await readFile(path.join(dir, ".specmock", "pets", "extracted", "manifest.json"), "utf8"));
    expect(manifest["000"]).toBe(a.chunks[0].contentHash);

    const again = await s.ok("analyze_spec", { system: "pets" });
    expect(again.chunks.every((c: { done: boolean }) => c.done)).toBe(true);

    const m = await s.ok("merge_extractions", { system: "pets" });
    expect(m.features).toBe(4);
    expect(m.missingChunks).toEqual([]);
    expect(m.invalidChunks).toEqual([]);
  });

  it("merge proceeds with missing chunks and reports them", async () => {
    const { pets } = await copySample();
    await s.ok("ingest_spec", { system: "pets", origins: [pets] });
    await s.ok("analyze_spec", { system: "pets" });
    const m = await s.ok("merge_extractions", { system: "pets" });
    expect(m.missingChunks.length).toBeGreaterThan(0);
  });

  it("parallel submit_extraction across many chunks all land and the manifest keeps every hash", async () => {
    const big = path.join(dir, "big.md");
    const filler = "가나다라마바사 ".repeat(800);
    const sections = Array.from({ length: 4 }, (_, i) => `# Section ${i}\n\nGET /things/${i} returns thing ${i}.\n\n${filler}\n`);
    await writeFile(big, sections.join("\n"));
    await s.ok("ingest_spec", { system: "big", origins: [big] });
    const a = await s.ok("analyze_spec", { system: "big" });
    expect(a.chunks.length).toBeGreaterThan(2);
    const subs = await Promise.all(a.chunks.map(async (c: { index: number; contentHash: string }) =>
      s.ok("submit_extraction", { system: "big", index: c.index, contentHash: c.contentHash, result: { endpoints: [] } })));
    expect(subs.every((r) => r.ok === true)).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(dir, ".specmock", "big", "extracted", "manifest.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(a.chunks.map((c: { index: number }) => String(c.index).padStart(3, "0")));
    for (const c of a.chunks) expect(manifest[String(c.index).padStart(3, "0")]).toBe(c.contentHash);
    const files = (await readdir(path.join(dir, ".specmock", "big", "extracted"))).filter((f) => f.endsWith(".tmp") || f.includes(".tmp"));
    expect(files).toEqual([]);
    const again = await s.ok("analyze_spec", { system: "big" });
    expect(again.chunks.every((c: { done: boolean }) => c.done)).toBe(true);
  });
});

describe("errors do not kill the server", () => {
  it("submit_extraction validation failure is a normal response with ok=false", async () => {
    const { pets } = await copySample();
    await s.ok("ingest_spec", { system: "pets", origins: [pets] });
    const a = await s.ok("analyze_spec", { system: "pets" });
    const c = a.chunks[0];
    const bad = await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: c.contentHash, result: { endpoints: [{ nope: 1 }] } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("invalid");
    expect(bad.errors.length).toBeGreaterThan(0);
    const stale = await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: "0".repeat(64), result: { endpoints: [] } });
    expect(stale).toMatchObject({ ok: false, reason: "stale-chunk" });
    const unknown = await s.ok("submit_extraction", { system: "pets", index: 999, contentHash: c.contentHash, result: { endpoints: [] } });
    expect(unknown).toMatchObject({ ok: false, reason: "unknown-chunk" });
  });

  it("handler exceptions become isError with tool-name hints, and the next call still works", async () => {
    const msg = await s.err("merge_extractions", { system: "ghost" });
    expect(msg).toMatch(/ingest_spec/);
    expect(msg).not.toMatch(/specmock (ingest|analyze)/);
    expect(await s.err("get_chunk", { system: "ghost", index: 0 })).toBeTruthy();
    expect(await s.err("ingest_spec", { system: "x", origins: [path.join(dir, "no-such.md")] })).toBeTruthy();
    const { pets } = await copySample();
    expect((await s.ok("ingest_spec", { system: "pets", origins: [pets] })).system).toBe("pets");
  });
});

describe("generate_mock output directory guard", () => {
  it("rejects a non-specmock outDir with tool-style hints, then keeps serving", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet"] });
    const msg = await s.err("generate_mock", { system: "petstore", outDir: "." });
    expect(msg).toContain("specmock이 만든 디렉터리가 아닙니다");
    expect(msg).toContain("force: true");
    expect(msg).not.toContain("--force");
    expect(await s.ok("list_features", { system: "petstore" })).toHaveProperty("total");
  });
});

async function linkNodeModules(outDir: string) {
  await symlink(ROOT_NODE_MODULES, path.join(outDir, "node_modules"), "dir");
}

describe("OpenAPI path: ingest → analyze → list → show → select → generate → verify", () => {
  it("passes every contract", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    const a = await s.ok("analyze_spec", { system: "petstore" });
    expect(a).toMatchObject({ mode: "catalog", features: 5 });

    const l = await s.ok("list_features", { system: "petstore" });
    expect(l.rows).toHaveLength(5);
    expect(l.table).toContain("petstore — 5개 기능");
    const f = await s.ok("show_feature", { system: "petstore", id: "getPet" });
    expect(f.feature).toMatchObject({ id: "getPet", method: "GET", path: "/pets/{petId}" });

    const sel = await s.ok("select_features", { system: "petstore", exprs: ["all"] });
    expect(sel.resolved).toHaveLength(5);
    const g = await s.ok("generate_mock", { system: "petstore" });
    expect(g.outDir).toBe(path.join(dir, "mock", "petstore")); // 서버 루트 기준 기본 경로
    await linkNodeModules(g.outDir);

    const v = await s.ok("verify_mock", { system: "petstore" });
    expect(v.failed, JSON.stringify(v.failures, null, 2)).toBe(0);
    expect(v.total).toBeGreaterThanOrEqual(6);
    expect(v.coverageFile).toBe(path.join(dir, ".specmock", "petstore", "coverage.md"));
    expect(v.coverageSummary).toContain("# petstore coverage");
  });

  it("select mode add/remove adjusts the previous selection", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet"] });
    expect((await s.ok("select_features", { system: "petstore", exprs: ["createPet"], mode: "add" })).resolved.sort()).toEqual(["createPet", "getPet"]);
    expect((await s.ok("select_features", { system: "petstore", exprs: ["getPet"], mode: "remove" })).resolved).toEqual(["createPet"]);
  });
});

describe("document path through verify", () => {
  it("submitted extraction → merge → select → generate → verify passes", async () => {
    const { pets: PETS_API, recorded: rec0 } = await copySample();
    await s.ok("ingest_spec", { system: "pets", origins: [PETS_API] });
    const a = await s.ok("analyze_spec", { system: "pets" });
    const rec = rec0;
    for (const c of a.chunks) {
      await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: c.contentHash, result: c.index === 0 ? rec : { endpoints: [] } });
    }
    expect((await s.ok("merge_extractions", { system: "pets" })).features).toBe(4);
    const l = await s.ok("list_features", { system: "pets" });
    expect(l.rows.map((r: { id: string }) => r.id).sort()).toEqual(["pets.create", "pets.delete", "pets.get", "pets.list"]);
    await s.ok("select_features", { system: "pets", exprs: ["all"] });
    const g = await s.ok("generate_mock", { system: "pets" });
    await linkNodeModules(g.outDir);
    const v = await s.ok("verify_mock", { system: "pets" });
    expect(v.failed, JSON.stringify(v.failures, null, 2)).toBe(0);
  });
});

describe("errors", () => {
  it("unknown system → isError with a tool hint, and the server keeps answering", async () => {
    const t = await s.err("list_features", { system: "nosuch" });
    expect(t).toContain("analyze_spec");
    expect(t).not.toContain("specmock analyze");
    expect((await s.client.listTools()).tools.length).toBe(10);
  });

  it("invalid system name and missing required args are tool errors", async () => {
    expect(await s.err("list_features", { system: "../x" })).toMatch(/시스템 이름이 올바르지 않습니다/);
    await s.err("list_features", {});
    expect((await s.client.listTools()).tools.length).toBe(10);
  });

  it("bad selection expression and unknown feature id → isError", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    expect(await s.err("select_features", { system: "petstore", exprs: ["nosuch"] })).toMatch(/알 수 없는 기능 id: nosuch/);
    expect(await s.err("show_feature", { system: "petstore", id: "nosuch" })).toMatch(/알 수 없는 기능 id: nosuch/);
    expect(await s.err("verify_mock", { system: "petstore" })).toContain("generate_mock");
  });

  it("hash mismatch, unknown chunk and broken submission are ok=false, not errors", async () => {
    const { pets: PETS_API, recorded: rec0 } = await copySample();
    await s.ok("ingest_spec", { system: "pets", origins: [PETS_API] });
    const a = await s.ok("analyze_spec", { system: "pets" });
    const c = a.chunks[0];
    expect(await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: "0".repeat(64), result: { endpoints: [] } })).toMatchObject({ ok: false, reason: "stale-chunk" });
    expect(await s.ok("submit_extraction", { system: "pets", index: 999, contentHash: c.contentHash, result: { endpoints: [] } })).toMatchObject({ ok: false, reason: "unknown-chunk" });
    const bad = await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: c.contentHash, result: { endpoints: [{ method: "FETCH" }] } });
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
    expect(bad.errors.some((e: { path: string }) => e.path.startsWith("endpoints.0"))).toBe(true);
    // 깨진 제출 뒤에도 서버가 응답하고, 고친 제출은 받아들인다.
    expect((await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: c.contentHash, result: { endpoints: [] } })).ok).toBe(true);
  });
});

describe("progress notifications", () => {
  it("ingest_spec sends notifications/progress only when the client passes a progressToken", async () => {
    const seen: { progress: number; message?: string }[] = [];
    const r = await s.client.callTool({ name: "ingest_spec", arguments: { system: "petstore", origins: [PETSTORE] } }, { onprogress: (p) => { seen.push(p); } });
    expect(r.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.message).toMatch(/^\[ingest\] /);
    expect(seen.map((p) => p.progress)).toEqual([...seen.map((p) => p.progress)].sort((a, b) => a - b));
    // 토큰이 없으면 알림 없이 정상 동작하고 stderr에는 로그가 남는다.
    const before = seen.length;
    await s.ok("ingest_spec", { system: "petstore2", origins: [PETSTORE] });
    expect(seen.length).toBe(before);
    await expect.poll(() => s.stderr()).toContain("[ingest]");
  });
});

describe("empty document", () => {
  it("warns in the summary text when no chunks could be made", async () => {
    const empty = path.join(dir, "empty.md");
    await writeFile(empty, "   \n");
    await s.ok("ingest_spec", { system: "empty", origins: [empty] });
    const a = await s.ok("analyze_spec", { system: "empty" });
    expect(a.chunks).toEqual([]);
    expect(await s.text("analyze_spec", { system: "empty" })).toMatch(/청크를 만들지 못했습니다/);
  });
});
