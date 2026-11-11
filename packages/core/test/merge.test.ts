import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjustConfidence, merge, normalizePath, normalizeVarName, verifyEvidence } from "../src/analyze/merge.js";
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
  it("converts :id only at segment boundaries and leaves custom-method colons alone", () => {
    expect(normalizePath("/users/:id/posts/:postId")).toBe("/users/{id}/posts/{postId}");
    expect(normalizePath("/v1/resources:batchGet")).toBe("/v1/resources:batchGet");
    expect(normalizePath("/a/<id>:cancel")).toBe("/a/<id>:cancel");
  });
  it("normalizes variable spellings to lowercase single braces", () => {
    expect(normalizePath("/v1/customers/{{CUSTOMER_ID}}")).toBe("/v1/customers/{customer_id}");
    expect(normalizePath("/v1/customers/{CUSTOMER_ID}")).toBe("/v1/customers/{customer_id}");
    expect(normalizePath("/v1/customers/:id")).toBe("/v1/customers/{id}");
    expect(normalizePath("/v1/customers/{id}")).toBe("/v1/customers/{id}");
    expect(normalizePath("/pets/{petId}")).toBe("/pets/{petId}");
    expect(normalizeVarName("ID")).toBe("id");
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

  const extractedFile = () => path.join(dir, "pets", "extracted", "000.json");
  const ep = (over: Record<string, unknown>) => ({
    method: "GET", path: "/pets", title: "List", responses: [], evidence: ["`GET /pets` returns an array of pets."], confidence: 0.9, ...over,
  });

  it("does not let a colliding $id poison later schema checks", async () => {
    const colliding = { $id: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } };
    const plain = { type: "object", properties: { b: { type: "integer" } } };
    await writeFile(extractedFile(), JSON.stringify({ endpoints: [
      ep({ path: "/first", responses: [{ status: 200, schema: colliding }] }),
      ep({ path: "/second", responses: [{ status: 200, schema: plain }] }),
    ] }));
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const first = catalog.features.find((f) => f.path === "/first")!;
    const second = catalog.features.find((f) => f.path === "/second")!;
    expect(first.responses["200"].schema).toEqual(colliding); // $id는 컴파일 복사본에서만 뗀다
    expect(first.notes.some((n) => n.includes("스키마 무시"))).toBe(false);
    expect(second.responses["200"].schema).toEqual(plain);
    expect(second.notes.some((n) => n.includes("스키마 무시"))).toBe(false);
    // 두 번째 merge에서도 같은 결과(모듈 전역 상태 없음)
    await merge(ws, "pets");
    const again = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(again.features.find((f) => f.path === "/second")!.responses["200"].schema).toEqual(plain);
  });

  it("survives a 5000-level nested example and keeps the other features", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    await writeFile(extractedFile(), JSON.stringify({ endpoints: [
      ep({ path: "/deep", responses: [{ status: 200, schema: null, example: deep }] }),
      ep({ path: "/shallow", responses: [{ status: 200, schema: null, example: { ok: true } }] }),
    ] }));
    const result = await merge(ws, "pets");
    expect(result.features).toBe(2);
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const shallow = catalog.features.find((f) => f.path === "/shallow")!;
    expect(shallow.responses["200"].schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    const stored = JSON.stringify(catalog.features.find((f) => f.path === "/deep")!.responses["200"].examples[0].body);
    expect(stored).toContain("[specmock: 깊이 초과로 생략]");
    expect((stored.match(/\{"n":/g) ?? []).length).toBeLessThanOrEqual(64);
  });

  it("keeps params named like Object.prototype members and never lets __proto__ keys touch prototypes", async () => {
    const text = `{"endpoints":[${JSON.stringify(ep({
      path: "/odd/{constructor}",
      pathParams: [{ name: "constructor", required: true, schema: { type: "string" } }],
      queryParams: [{ name: "__proto__", required: false, schema: { type: "string" } }, { name: "hasOwnProperty", required: true, schema: null }],
      responses: [{ status: 200, schema: null, example: "EXAMPLE" }],
    })).replace('"EXAMPLE"', '{"__proto__": {"x": 1}, "toString": 2}')}]}`;
    await writeFile(extractedFile(), text);
    const result = await merge(ws, "pets");
    expect(result.features).toBe(1);
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const f = catalog.features[0];
    expect(Object.hasOwn(f.request.params, "constructor")).toBe(true);
    expect(f.request.params.constructor).toEqual({ schema: { type: "string" }, required: true });
    expect(Object.hasOwn(f.request.query, "hasOwnProperty")).toBe(true);
    // zod v4는 record/object를 파싱할 때 "__proto__" 키를 조용히 버린다(ws.write 검증 단계). 디스크의 카탈로그에는 없지만
    // merge가 그 키로 프로토타입을 바꾸지 않았다는 것이 중요하다.
    expect(Object.getPrototypeOf(f.request.query)).toBe(Object.prototype);
    expect(Object.keys(f.request.query)).toEqual(["hasOwnProperty"]);
    const props = f.responses["200"].schema!.properties as Record<string, unknown>;
    // 스키마 안의 properties는 zod가 unknown으로 통과시키므로 "__proto__" own property가 그대로 남는다.
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect(Object.hasOwn(props, "__proto__")).toBe(true);
    expect(props.toString).toEqual({ type: "integer" });
  });

  it("stores a preview of the file text when JSON parsing fails", async () => {
    await writeFile(extractedFile(), "{ not json " + "x".repeat(1000));
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(typeof catalog.rejected[0].raw).toBe("string");
    expect((catalog.rejected[0].raw as string).length).toBe(500);
    expect(catalog.rejected[0].raw as string).toMatch(/^\{ not json/);
  });

  it("dedupes doc paths against openapi paths with a trailing slash", async () => {
    const spec = {
      openapi: "3.0.0", info: { title: "t", version: "1" },
      paths: { "/pets/": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } } },
    };
    const specFile = path.join(dir, "slash.json");
    await writeFile(specFile, JSON.stringify(spec));
    await ingest(ws, "slash", [specFile, path.join(DOCS, "pets.md")]);
    await prepare(ws, "slash");
    await cp(path.join(DOCS, "extracted"), path.join(dir, "slash", "extracted"), { recursive: true });
    await merge(ws, "slash");
    const catalog = await ws.read("slash", "catalog.json", CatalogSchema);
    const lists = catalog.features.filter((f) => f.method === "GET" && f.path.replace(/\/$/, "") === "/pets");
    expect(lists).toHaveLength(1);
    expect(lists[0].provenance).toBe("openapi");
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

  const mk = (o: Record<string, unknown>) => ({
    title: "t", summary: "", auth: "none", responses: [], evidence: [], confidence: 0.9, ...o,
  });
  const writeExtracted = (endpoints: unknown[]) =>
    writeFile(path.join(dir, "pets", "extracted", "000.json"), JSON.stringify({ endpoints }));

  it("unifies group spelling case-insensitively (most frequent, ties to first seen)", async () => {
    await writeExtracted([
      mk({ method: "GET", path: "/v1/customers", group: "customers" }),
      mk({ method: "POST", path: "/v1/customers", group: "Customers" }),
      mk({ method: "GET", path: "/v1/customers/{id}", group: "Customers" }),
      mk({ method: "DELETE", path: "/v1/customers/{id}", group: "Customers" }),
      mk({ method: "GET", path: "/v1/charges", group: "Billing" }),
      mk({ method: "POST", path: "/v1/charges", group: "billing" }),
    ]);
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const groups = (m: string) => [...new Set(catalog.features.filter((f) => f.path.includes(m)).map((f) => f.group))];
    expect(groups("customers")).toEqual(["Customers"]);
    expect(groups("charges")).toEqual(["Billing"]);
    expect(catalog.features.find((f) => f.method === "GET" && f.path === "/v1/customers")!.id).toBe("customers.list");
  });

  it("merges the same endpoint whose path variable names differ", async () => {
    await writeExtracted([
      mk({ method: "POST", path: "/v1/customers/{{CUSTOMER_ID}}", confidence: 0.9, inferred: { method: true },
        pathParams: [{ name: "CUSTOMER_ID", required: true, schema: { type: "string" }, description: "" }],
        requestBody: { type: "object", properties: { name: { type: "string" } } } }),
      mk({ method: "POST", path: "/v1/customers/{id}", confidence: 0.9,
        pathParams: [{ name: "id", required: true, schema: { type: "string" }, description: "" }],
        requestBody: { type: "object", properties: { email: { type: "string" } } } }),
    ]);
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(catalog.features).toHaveLength(1);
    const f = catalog.features[0];
    expect(f.path).toBe("/v1/customers/{id}"); // 메서드가 명시된 항목이 대표
    expect(f.id).toBe("customers.update");
    expect(Object.keys(f.request.params)).toEqual(["id"]);
  });
});
