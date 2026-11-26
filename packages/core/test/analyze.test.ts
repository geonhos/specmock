import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeatureIdRegistry } from "../src/analyze/featureId.js";
import { analyze } from "../src/analyze/index.js";
import { analyzeOpenApiDocument } from "../src/analyze/openapi.js";
import { ingest } from "../src/ingest/index.js";
import { CatalogDiffSchema, CatalogSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";
import { fileURLToPath } from "node:url";

const PETS_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "docs", "pets.md");

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-analyze-"));
  ws = new Workspace(dir);
  await ingest(ws, "petstore", [PETSTORE]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("analyze(openapi)", () => {
  it("produces one feature per path×method with stable ids", async () => {
    await analyze(ws, "petstore");
    const catalog = await ws.read("petstore", "catalog.json", CatalogSchema);
    const ids = catalog.features.map((f) => f.id).sort();
    expect(ids).toEqual(["createPet", "deletePet", "getPet", "inventory.list", "listPets"]);
  });

  it("fills group, auth, examples and schemas", async () => {
    await analyze(ws, "petstore");
    const catalog = await ws.read("petstore", "catalog.json", CatalogSchema);
    const byId = Object.fromEntries(catalog.features.map((f) => [f.id, f]));

    expect(byId.getPet.group).toBe("pets");
    expect(byId.getPet.auth).toBe("apiKey");
    expect(byId.getPet.hasExample).toBe(true);
    expect(byId.getPet.responses["200"].examples[0]).toEqual({ source: "spec-example", body: { id: 1, name: "Rex", tag: "dog" } });
    expect(byId.getPet.request.params.petId).toEqual({ schema: { type: "integer" }, required: true });

    expect(byId["inventory.list"].group).toBe("store");
    expect(byId["inventory.list"].auth).toBe("none");

    expect(byId.createPet.request.body?.required).toEqual(["name"]);
    expect(byId.createPet.responses["400"].schema).toBeTruthy();

    expect(byId.listPets.request.query.limit.required).toBe(false);
    expect(byId.deletePet.responses["204"].schema).toBeNull();

    for (const f of catalog.features) {
      expect(f.provenance).toBe("openapi");
      expect(f.confidence).toBe(1);
    }
  });

  it("returns the catalog path and a diff, and records changes against the previous catalog", async () => {
    const first = await analyze(ws, "petstore");
    expect(first.mode).toBe("openapi");
    expect(first.catalogFile).toBe(path.join(dir, "petstore", "catalog.json"));
    expect(first.diff).toEqual({ previousAt: null, added: ["createPet", "deletePet", "getPet", "inventory.list", "listPets"], removed: [], changed: [] });
    const second = await analyze(ws, "petstore");
    expect(second.diff).toMatchObject({ added: [], removed: [], changed: [] });
    expect(second.diff?.previousAt).not.toBeNull();
    const saved = await ws.read("petstore", "catalog-diff.json", CatalogDiffSchema);
    expect(saved).toEqual(second.diff);
  });

  it("asks for LLM extraction when any input is a document and writes nothing", async () => {
    await ingest(ws, "docs", [PETSTORE, PETS_MD]);
    expect(await analyze(ws, "docs")).toEqual({ mode: "needs-llm" });
    expect(await ws.exists("docs", "catalog.json")).toBe(false);
  });
});

describe("analyzeOpenApiDocument (edge cases)", () => {
  const v2 = {
    swagger: "2.0", info: { title: "v2", version: "1" },
    securityDefinitions: { basicAuth: { type: "basic" } },
    security: [{ basicAuth: [] }],
    paths: {
      "/upload": { post: { operationId: "upload", deprecated: true, parameters: [
        { name: "file", in: "formData", type: "file", required: true },
        { name: "note", in: "formData", type: "string", maxLength: 10 },
      ], responses: { default: { description: "x" } } } },
      "/items": { parameters: [{ name: "page", in: "query", type: "integer", format: "int32", required: false }],
        get: { parameters: [{ name: "page", in: "query", type: "integer", required: true }], responses: { "200": { description: "ok", schema: { type: "array", items: { type: "string" } } } } },
        delete: { responses: { "204": { description: "gone" } } } },
      "/a/{id}": { get: { responses: { "200": { description: "ok" } } } },
      "/b": { get: { operationId: "a.get", responses: { "200": { description: "ok" } } } },
    },
  };
  const features = analyzeOpenApiDocument(v2 as never);
  const byId = Object.fromEntries(features.map((f) => [f.id, f]));

  it("synthesizes a body from formData, keeps v2 param keys, notes deprecated, maps basic auth", () => {
    expect(byId.upload.request.body).toEqual({ type: "object", properties: { file: { type: "string", format: "binary" }, note: { type: "string", maxLength: 10 } }, required: ["file"] });
    expect(byId.upload.notes).toEqual(["deprecated"]);
    expect(byId.upload.auth).toBe("basic");
    expect(byId.upload.responses).toEqual({});
  });
  it("lets operation-level params override path-level ones and keeps path-level for siblings", () => {
    expect(byId["items.list"].request.query.page).toEqual({ schema: { type: "integer" }, required: true });
    expect(byId["items.delete"].request.query.page).toEqual({ schema: { type: "integer", format: "int32" }, required: false });
  });
  it("gives explicit operationIds precedence over derived ids", () => {
    expect(byId["a.get"].path).toBe("/b");
    expect(features.find((f) => f.path === "/a/{id}")?.id).toBe("a.get2");
  });
  it("shares a registry across documents", () => {
    const reg = new FeatureIdRegistry();
    const first = analyzeOpenApiDocument(v2 as never, reg);
    const second = analyzeOpenApiDocument(v2 as never, reg);
    const all = new Set([...first, ...second].map((f) => f.id));
    expect(all.size).toBe(first.length + second.length);
  });
});

describe("analyzeOpenApiDocument keeps requestBody.required and response headers", () => {
  const doc = {
    openapi: "3.0.3", info: { title: "t", version: "1" },
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } },
          responses: { "201": { description: "ok", headers: { Location: { required: true, schema: { type: "string" } } }, content: { "application/json": { schema: { type: "object" } } } } },
        },
        get: { operationId: "listItems", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array" } } } } } },
      },
    },
  } as const;

  it("sets bodyRequired from requestBody.required and keeps headers", () => {
    const features = analyzeOpenApiDocument(doc as never);
    const create = features.find((f) => f.method === "POST");
    const list = features.find((f) => f.method === "GET");
    expect(create!.request.bodyRequired).toBe(true);
    expect(create!.responses["201"]!.headers).toEqual({ Location: { schema: { type: "string" }, required: true } });
    expect(list!.request.bodyRequired).toBeUndefined();
    expect(list!.responses["200"]!.headers).toBeUndefined();
  });

  it("v2 in:body param required → bodyRequired", () => {
    const v2 = { swagger: "2.0", info: { title: "t", version: "1" }, paths: { "/x": { post: { operationId: "px", parameters: [{ in: "body", name: "b", required: true, schema: { type: "object" } }], responses: { "200": { description: "ok", headers: { "X-Rate": { type: "integer" } } } } } } } };
    const [f] = analyzeOpenApiDocument(v2 as never);
    expect(f!.request.bodyRequired).toBe(true);
    expect(f!.responses["200"]!.headers).toEqual({ "X-Rate": { schema: { type: "integer" }, required: false } });
  });
});
