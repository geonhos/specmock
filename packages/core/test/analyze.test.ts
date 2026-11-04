import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { CatalogSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

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
});
