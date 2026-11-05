import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepare } from "../src/analyze/prepare.js";
import { submitExtraction } from "../src/analyze/submit.js";
import { ingest } from "../src/ingest/index.js";
import type { AnalyzeRequest } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PETS_MD = path.join(here, "fixtures", "docs", "pets.md");
const ENDPOINT = {
  method: "GET", path: "/pets/{petId}", title: "Get a pet",
  responses: [{ status: 200, example: { id: 1 } }],
  evidence: ["`GET /pets/{petId}` returns one pet."], confidence: 0.9,
};

let dir: string; let ws: Workspace; let req: AnalyzeRequest;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-submit-")); ws = new Workspace(dir);
  await ingest(ws, "pets", [PETS_MD]);
  req = await prepare(ws, "pets", { maxChars: 400, overlap: 50 });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const extracted = (name: string) => path.join(dir, "pets", "extracted", name);

describe("submitExtraction", () => {
  it("writes extracted/NNN.json and records the chunk hash in the manifest", async () => {
    const c = req.chunks[1]!;
    const r = await submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [ENDPOINT] } });
    expect(r).toEqual({ ok: true, file: extracted("001.json") });
    const saved = JSON.parse(await readFile(extracted("001.json"), "utf8"));
    expect(saved.endpoints[0]).toMatchObject({ method: "GET", path: "/pets/{petId}", summary: "", auth: "unknown" }); // 기본값 채움
    expect(JSON.parse(await readFile(extracted("manifest.json"), "utf8"))).toEqual({ "001": c.contentHash });
  });

  it("keeps existing manifest entries for other chunks", async () => {
    const [a, b] = [req.chunks[0]!, req.chunks[1]!];
    await submitExtraction(ws, "pets", { index: a.index, contentHash: a.contentHash!, result: { endpoints: [] } });
    await submitExtraction(ws, "pets", { index: b.index, contentHash: b.contentHash!, result: { endpoints: [] } });
    expect(JSON.parse(await readFile(extracted("manifest.json"), "utf8"))).toEqual({ "000": a.contentHash, "001": b.contentHash });
  });

  it("rejects schema errors with paths and reasons and writes nothing", async () => {
    const c = req.chunks[0]!;
    const r = await submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [{ ...ENDPOINT, method: "FETCH", confidence: 2 }] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
    const paths = r.errors!.map((e) => e.path);
    expect(paths).toContain("endpoints.0.method");
    expect(paths).toContain("endpoints.0.confidence");
    expect(r.errors!.every((e) => e.message.length > 0)).toBe(true);
    expect(await readdir(path.join(dir, "pets", "extracted"))).toEqual([]);
  });

  it("rejects unknown keys on the result and on endpoints (strict)", async () => {
    const c = req.chunks[0]!;
    const r = await submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [{ ...ENDPOINT, respones: [] }], extra: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
    expect(r.errors!.map((e) => e.message).join(" ")).toMatch(/respones|extra/);
  });

  it("accepts unknown keys when lenient (extract path)", async () => {
    const c = req.chunks[0]!;
    const r = await submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [{ ...ENDPOINT, respones: [] }] } }, { lenient: true });
    expect(r.ok).toBe(true);
    expect(JSON.parse(await readFile(extracted("000.json"), "utf8")).endpoints[0]).not.toHaveProperty("respones");
  });

  it("rejects a stale contentHash", async () => {
    const c = req.chunks[0]!;
    const r = await submitExtraction(ws, "pets", { index: c.index, contentHash: "0".repeat(64), result: { endpoints: [] } });
    expect(r).toMatchObject({ ok: false, reason: "stale-chunk" });
    expect(await readdir(path.join(dir, "pets", "extracted"))).toEqual([]);
  });

  it("rejects an unknown chunk index", async () => {
    const r = await submitExtraction(ws, "pets", { index: 999, contentHash: "x", result: { endpoints: [] } });
    expect(r).toMatchObject({ ok: false, reason: "unknown-chunk" });
  });

  it("writes atomically: a failed rename leaves no partial file and no manifest entry", async () => {
    const c = req.chunks[0]!;
    // 대상 경로를 비어 있지 않은 디렉터리로 만들어 rename을 실패시킨다.
    await mkdir(extracted("000.json"));
    await writeFile(path.join(extracted("000.json"), "keep"), "x");
    await expect(submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [ENDPOINT] } })).rejects.toThrow();
    expect(await readFile(path.join(extracted("000.json"), "keep"), "utf8")).toBe("x"); // 그대로
    const names = await readdir(path.join(dir, "pets", "extracted"));
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(names).not.toContain("manifest.json");
  });
});
