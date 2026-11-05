import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjustConfidence, merge, normalizePath, verifyEvidence } from "../src/analyze/merge.js";
import { prepare } from "../src/analyze/prepare.js";
import { ingest } from "../src/ingest/index.js";
import { CatalogDiffSchema, CatalogSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, "fixtures", "docs");

describe("verifyEvidence", () => {
  it("matches after whitespace and backtick normalization", () => {
    const text = "Call   `GET /pets`\nreturns a list.";
    expect(verifyEvidence(["GET /pets returns a list."], text)).toEqual({ found: 1, total: 1 });
    expect(verifyEvidence(["nothing like this"], text)).toEqual({ found: 0, total: 1 });
    expect(verifyEvidence([], text)).toEqual({ found: 0, total: 0 });
  });

  it("ignores quotes shorter than 8 characters and is case-insensitive", () => {
    const text = "## Pets\n\n**GET** /pets lists pets.";
    expect(verifyEvidence(["/pets"], text)).toEqual({ found: 0, total: 1 });
    expect(verifyEvidence(["get /PETS lists pets"], text)).toEqual({ found: 1, total: 1 });
  });
});

describe("adjustConfidence", () => {
  it("applies the design table", () => {
    expect(adjustConfidence(0.9, { evidenceFound: 1, evidenceTotal: 1, hasExample: false, inferred: false })).toBeCloseTo(0.9);
    expect(adjustConfidence(0.9, { evidenceFound: 0, evidenceTotal: 1, hasExample: false, inferred: false })).toBeCloseTo(0.27);
    expect(adjustConfidence(0.95, { evidenceFound: 1, evidenceTotal: 1, hasExample: true, inferred: false })).toBe(1);
    expect(adjustConfidence(0.9, { evidenceFound: 1, evidenceTotal: 1, hasExample: true, inferred: true })).toBe(0.5);
    expect(adjustConfidence(0.9, { evidenceFound: 0, evidenceTotal: 0, hasExample: false, inferred: false })).toBeCloseTo(0.9 * 0.7);
  });
});

describe("normalizePath", () => {
  it("strips host, query and fragment, converts :id and <id>, trims trailing slash", () => {
    expect(normalizePath("https://api.example.com/v1/pets/:petId?x=1#frag")).toBe("/v1/pets/{petId}");
    expect(normalizePath("/pets/<id>/")).toBe("/pets/{id}");
    expect(normalizePath("  /pets  ")).toBe("/pets");
    expect(normalizePath("/")).toBe("/");
  });
  it("returns null for paths without a leading slash or with whitespace", () => {
    expect(normalizePath("pets/bad")).toBeNull();
    expect(normalizePath("/pets/{pet id}")).toBeNull();
    expect(normalizePath("")).toBeNull();
  });
});

describe("merge", () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "specmock-merge-"));
    ws = new Workspace(dir);
    await ingest(ws, "pets", [path.join(DOCS, "pets.md")]);
    await prepare(ws, "pets");
    await cp(path.join(DOCS, "extracted"), path.join(dir, "pets", "extracted"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a catalog with doc-extracted features, merged by method+path", async () => {
    const result = await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const ids = catalog.features.map((f) => `${f.method} ${f.path}`).sort();
    expect(ids).toEqual(["DELETE /pets/{petId}", "GET /pets", "GET /pets/{petId}", "POST /pets", "PUT /pets/{petId}"]);
    const get = catalog.features.find((f) => f.method === "GET" && f.path === "/pets/{petId}")!;
    expect(get.id).toBe("pets.get");
    expect(get.group).toBe("pets");
    expect(get.provenance).toBe("doc-extracted");
    expect(Object.keys(get.responses).sort()).toEqual(["200", "404"]); // 두 항목이 합쳐짐
    expect(get.responses["200"].examples[0]).toEqual({ source: "doc-sample", body: { id: 1, name: "Rex", tag: "dog" } });
    expect(get.responses["200"].schema).toEqual({ type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, tag: { type: "string" } } }); // 샘플에서 유추
    expect(get.notes).toContain("200 응답 스키마는 샘플에서 유추");
    expect(get.responses["404"].schema).toEqual({ type: "object", properties: { code: { type: "integer" }, message: { type: "string" } } }); // LLM이 준 스키마 유지
    expect(get.hasExample).toBe(true);
    expect(get.confidence).toBe(1); // 0.9 + 0.1
    expect(get.evidence).toHaveLength(2);
    expect(get.evidence[0]).toMatchObject({ chunk: 0, quote: expect.stringContaining("returns one pet") });
    expect(get.request.params.petId).toEqual({ schema: { type: "string" }, required: true });
    expect(get.auth).toBe("bearer");
    expect(get.title).toBe("Get a pet");
    expect(result.features).toBe(5);
    expect(result.catalogFile).toBe(path.join(dir, "pets", "catalog.json"));
    expect(result.diff.added).toHaveLength(5);
    const diff = await ws.read("pets", "catalog-diff.json", CatalogDiffSchema);
    expect(diff.previousAt).toBeNull();
  });

  it("fills path params from the template and keeps the request body", async () => {
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const del = catalog.features.find((f) => f.method === "DELETE")!;
    expect(del.request.params.petId).toEqual({ schema: { type: "string" }, required: true });
    const post = catalog.features.find((f) => f.method === "POST")!;
    expect(post.request.body?.required).toEqual(["name"]);
    expect(post.responses["201"]).toEqual({ schema: null, examples: [] });
    expect(post.hasExample).toBe(false);
    const list = catalog.features.find((f) => f.method === "GET" && f.path === "/pets")!;
    expect(list.id).toBe("pets.list");
    expect(list.request.query.limit).toEqual({ schema: { type: "integer", maximum: 100 }, required: false });
    expect(list.responses["200"].schema).toEqual({ type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, tag: { type: "string" } } } });
  });

  it("lowers confidence and notes evidence mismatch, caps inferred at 0.5, rejects bad paths", async () => {
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const del = catalog.features.find((f) => f.method === "DELETE")!;
    expect(del.confidence).toBeCloseTo(0.27);
    expect(del.notes).toContain("근거 불일치: 인용 1건 중 1건을 원문에서 찾지 못함");
    const put = catalog.features.find((f) => f.method === "PUT")!;
    expect(put.confidence).toBeLessThanOrEqual(0.5);
    expect(put.provenance).toBe("inferred");
    expect(put.notes).toContain("method 추론됨");
    expect(catalog.rejected).toHaveLength(1);
    expect(catalog.rejected[0].reason).toMatch(/path/);
    expect(catalog.rejected[0].chunk).toBe(0);
  });

  it("prefers openapi features when both exist and marks doc-only ones", async () => {
    await ingest(ws, "mixed", [PETSTORE, path.join(DOCS, "pets.md")]);
    await prepare(ws, "mixed");
    await cp(path.join(DOCS, "extracted"), path.join(dir, "mixed", "extracted"), { recursive: true });
    await merge(ws, "mixed");
    const catalog = await ws.read("mixed", "catalog.json", CatalogSchema);
    const get = catalog.features.find((f) => f.method === "GET" && f.path === "/pets/{petId}")!;
    expect(get.id).toBe("getPet"); // operationId 유지
    expect(get.provenance).toBe("openapi");
    expect(get.confidence).toBe(1);
    expect(catalog.features.filter((f) => f.provenance !== "openapi").map((f) => f.method)).toEqual(["PUT"]); // 문서에만 있는 것
    expect(catalog.features).toHaveLength(6);
  });

  it("proceeds with missing extracted files and records it", async () => {
    await rm(path.join(dir, "pets", "extracted"), { recursive: true, force: true });
    const result = await merge(ws, "pets");
    expect(result.features).toBe(0);
    expect(result.missingChunks).toEqual([0]);
    expect(result.invalidChunks).toEqual([]);
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(catalog.rejected[0].reason).toContain("미추출");
    expect(catalog.rejected[0].chunk).toBe(0);
  });

  it("rejects individual items that do not match the schema but keeps going", async () => {
    await writeFile(path.join(dir, "pets", "extracted", "000.json"), JSON.stringify({ endpoints: [{ method: "GET" }] }));
    const result = await merge(ws, "pets");
    expect(result.features).toBe(0);
    expect(result.invalidChunks).toEqual([]);
    expect(result.rejected).toBe(1);
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(catalog.rejected[0].reason).toMatch(/^항목 스키마 불일치/);
    expect(catalog.rejected[0].chunk).toBe(0);
  });

  it("marks the chunk invalid when the file has no endpoints array or is not JSON", async () => {
    await writeFile(path.join(dir, "pets", "extracted", "000.json"), JSON.stringify({ nope: true }));
    expect((await merge(ws, "pets")).invalidChunks).toEqual([0]);
    await writeFile(path.join(dir, "pets", "extracted", "000.json"), "{ not json");
    const result = await merge(ws, "pets");
    expect(result.invalidChunks).toEqual([0]);
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(catalog.rejected[0].reason).toContain("JSON 파싱 실패");
  });

  it("drops a schema that does not compile and notes it", async () => {
    const bad = {
      endpoints: [{
        method: "GET", path: "/pets", title: "List", responses: [{ status: 200, schema: { type: "nonsense" }, example: [1] }],
        evidence: ["`GET /pets` returns an array of pets."], confidence: 0.9,
      }],
    };
    await writeFile(path.join(dir, "pets", "extracted", "000.json"), JSON.stringify(bad));
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const list = catalog.features[0];
    expect(list.notes.some((n) => n.startsWith("responses.200 스키마 무시"))).toBe(true);
    expect(list.responses["200"].schema).toEqual({ type: "array", items: { type: "integer" } }); // 샘플에서 유추로 대체
  });

  it("writes catalog-diff.json against the previous catalog and prunes stale extracted files", async () => {
    await merge(ws, "pets");
    await writeFile(path.join(dir, "pets", "extracted", "007.json"), "{}");
    const result = await merge(ws, "pets");
    expect(result.diff.added).toEqual([]);
    expect(result.diff.removed).toEqual([]);
    expect(result.diff.changed).toEqual([]);
    expect(result.diff.previousAt).not.toBeNull();
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.join(dir, "pets", "extracted"))).toEqual(["000.json"]);
  });
});
