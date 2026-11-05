import { mkdir, readFile, realpath, mkdtemp, rm, writeFile, cp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/names.js";
import { connect, DOCS_SAMPLE, type Session } from "./helpers.js";

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
  it("registers exactly TOOL_NAMES (analysis tools only until Task 5)", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("ping");
    for (const n of ["ingest_spec", "analyze_spec", "get_chunk", "submit_extraction", "merge_extractions"]) expect(names).toContain(n);
    for (const n of names) expect(TOOL_NAMES as readonly string[]).toContain(n);
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
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk).not.toHaveProperty("file");
      const sub = await s.ok("submit_extraction", { system: "pets", index: c.index, contentHash: chunk.contentHash, result: c.index === 0 ? recorded : { endpoints: [] } });
      expect(sub.ok).toBe(true);
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
    expect(msg).toMatch(/analyze_spec|ingest_spec|ghost/);
    expect(msg).not.toMatch(/specmock (ingest|analyze)/);
    expect(await s.err("get_chunk", { system: "ghost", index: 0 })).toBeTruthy();
    expect(await s.err("ingest_spec", { system: "x", origins: [path.join(dir, "no-such.md")] })).toBeTruthy();
    await mkdir(path.join(dir, "ok"));
    const { pets } = await copySample();
    expect((await s.ok("ingest_spec", { system: "pets", origins: [pets] })).system).toBe("pets");
  });

  it("writes nothing but protocol to stdout (client keeps working) and no harness traces on stderr", async () => {
    const { pets } = await copySample();
    await s.ok("ingest_spec", { system: "pets", origins: [pets] });
    expect(s.stderr()).not.toMatch(/harness/i);
  });
});
