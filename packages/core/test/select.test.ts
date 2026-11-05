import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { CatalogSchema, MockSpecSchema, SelectionSchema, SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-select-"));
  ws = new Workspace(dir);
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("select", () => {
  it("writes selection.json and mockspec.json for the chosen features", async () => {
    const result = await select(ws, "petstore", ["getPet", "listPets"]);
    expect(result.resolved).toEqual(["listPets", "getPet"]);

    const selection = await ws.read("petstore", "selection.json", SelectionSchema);
    expect(selection.selected).toEqual(["getPet", "listPets"]);
    expect(selection.resolved).toEqual(["listPets", "getPet"]);
    expect(selection.catalogHash).toMatch(/^[0-9a-f]{64}$/);

    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.features.map((f) => f.id)).toEqual(["listPets", "getPet"]);
    expect(spec.notMocked.map((f) => f.id).sort()).toEqual(["createPet", "deletePet", "inventory.list"]);
    expect(spec.features[1].fixtures[0]).toEqual({ status: 200, body: { id: 1, name: "Rex", tag: "dog" }, source: "spec-example" });
    expect(spec.contracts.filter((c) => c.featureId === "getPet")[0].request.path).toBe("/pets/1");
  });

  it("--add merges with the previous selection, --remove subtracts", async () => {
    await select(ws, "petstore", ["getPet"]);
    const added = await select(ws, "petstore", ["createPet"], { add: true });
    expect(added.resolved).toEqual(["createPet", "getPet"]); // 표시 순서: /pets POST → /pets/{petId} GET
    const selection = await ws.read("petstore", "selection.json", SelectionSchema);
    expect(selection.selected).toEqual(["getPet", "createPet"]);

    const removed = await select(ws, "petstore", ["getPet"], { remove: true });
    expect(removed.resolved).toEqual(["createPet"]);
  });

  it("--remove splits comma-joined expressions and negates each", async () => {
    await select(ws, "petstore", ["all"]);
    const r = await select(ws, "petstore", ["getPet,createPet"], { remove: true });
    expect(r.resolved).toEqual(["listPets", "deletePet", "inventory.list"]);
    expect(r.selected.slice(-2)).toEqual(["-getPet", "-createPet"]);
  });

  it("--remove without a previous selection and add+remove together are rejected", async () => {
    await expect(select(ws, "petstore", ["getPet"], { remove: true })).rejects.toThrow(/기존 선택이 없습니다/);
    await expect(select(ws, "petstore", ["getPet"], { add: true, remove: true })).rejects.toThrow(/함께 쓸 수 없습니다/);
  });

  it("flags catalogChanged on a plain re-select after the catalog changed", async () => {
    await select(ws, "petstore", ["getPet"]);
    const catalog = await ws.read("petstore", "catalog.json", CatalogSchema);
    catalog.features[0].title = "changed";
    await ws.write("petstore", "catalog.json", CatalogSchema, catalog);
    const r = await select(ws, "petstore", ["getPet"]);
    expect(r.catalogChanged).toBe(true);
  });

  it("records assumptions for features without response schema", async () => {
    const result = await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.assumptions.length).toBe(0); // petstore는 전부 스키마가 있음
    expect(result.resolved).toHaveLength(5);
  });

  it("copies harvest notes from source.json into assumptions", async () => {
    const source = await ws.read("petstore", "source.json", SourceSchema);
    source.inputs[0].harvested = { pages: [], interactions: [], notes: ["ego-browser 미설치. 수확 미수행"] };
    await ws.write("petstore", "source.json", SourceSchema, source);
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.assumptions[0]).toBe("입력: ego-browser 미설치. 수확 미수행");
  });
});
