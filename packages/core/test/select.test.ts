import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { CatalogSchema, MockSpecSchema, RecordedSchema, SelectionSchema, SourceSchema } from "../src/types.js";
import { featureInputHash } from "../src/util/specHash.js";
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

  it("literalIds picks ids verbatim even when they look like expressions", async () => {
    const cat = await ws.read("petstore", "catalog.json", CatalogSchema);
    const base = cat.features[0]!;
    const mk = (id: string, p: string) => ({ ...base, id, path: p });
    await ws.write("petstore", "catalog.json", CatalogSchema, { ...cat, features: [...cat.features, mk("all", "/x-all"), mk("123", "/x-123")] });
    const r = await select(ws, "petstore", ["all", "123"], { literalIds: true });
    expect(r.resolved.sort()).toEqual(["123", "all"]);
    expect(r.selected).toEqual(["all", "123"]);
    await expect(select(ws, "petstore", ["nope"], { literalIds: true })).rejects.toThrow(/알 수 없는 기능 id/);
  });
});

describe("select with recordings", () => {
  async function writeRec(id: string, body: unknown, mockspecHash: string, status = 200): Promise<void> {
    await ws.write("petstore", `recorded/${id}.json`, RecordedSchema, {
      featureId: id, recordedAt: "2026-11-09T00:00:00.000Z", mockspecHash,
      request: { method: "GET", path: "/pets", query: {}, headers: {} },
      response: { status, kind: "json", headers: {}, body, bytes: 10 },
      contract: { expectedStatus: 200, statusMatch: status === 200, schemaErrors: [] },
    });
  }

  it("녹화가 있으면 기본 fixture를 바꾸고, 해시가 같으면 경고가 없다", async () => {
    await select(ws, "petstore", ["all"]);
    const before = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    await writeRec("listPets", [{ id: 7, name: "Real" }], featureInputHash(before, "listPets"));
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const f = spec.features.find((x) => x.id === "listPets")!;
    expect(f.fixtures[0]).toEqual({ status: 200, body: [{ id: 7, name: "Real" }], source: "recorded" });
    expect(spec.assumptions.some((a) => a.includes("낡은 녹화"))).toBe(false);
    expect(spec.contracts).toEqual(before.contracts);
  });

  it("해시가 다르면 낡은 녹화 경고를 남기되 사용한다", async () => {
    await writeRec("listPets", [{ id: 7, name: "Real" }], "old-hash");
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.features.find((x) => x.id === "listPets")!.fixtures[0].source).toBe("recorded");
    expect(spec.assumptions).toContain("listPets: 녹화가 지금 mockspec과 다른 시점에 만들어졌습니다(낡은 녹화). 다시 녹화하려면 record --refresh");
  });

  it("깨진 녹화 파일은 무시하고 사유를 남긴다", async () => {
    await ws.writeText("petstore", "recorded/listPets.json", "{ broken");
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.features.find((x) => x.id === "listPets")!.fixtures[0].source).not.toBe("recorded");
    expect(spec.assumptions).toContain("listPets: 녹화 파일을 읽지 못해 사용하지 않음");
  });

  it("파일 이름과 featureId가 다른 녹화는 무시하고 사유를 남긴다", async () => {
    await select(ws, "petstore", ["all"]);
    const before = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    await writeRec("listPets", [{ id: 7, name: "Real" }], featureInputHash(before, "listPets"));
    const rec = await ws.read("petstore", "recorded/listPets.json", RecordedSchema);
    await ws.write("petstore", "recorded/listPets.json", RecordedSchema, { ...rec, featureId: "getPet" });
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.features.find((x) => x.id === "listPets")!.fixtures[0].source).not.toBe("recorded");
    expect(spec.assumptions).toContain("listPets: 녹화 파일의 featureId가 파일 이름과 다릅니다. 사용하지 않음");
  });
});
