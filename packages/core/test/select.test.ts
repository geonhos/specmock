import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema, SelectionSchema } from "../src/types.js";
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

  it("records assumptions for features without response schema", async () => {
    const result = await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.assumptions.length).toBe(0); // petstore는 전부 스키마가 있음
    expect(result.resolved).toHaveLength(5);
  });
});
