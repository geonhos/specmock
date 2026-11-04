import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSelection } from "../src/select/expression.js";
import type { Catalog, Feature } from "../src/types.js";

function f(partial: Partial<Feature> & Pick<Feature, "id" | "group" | "method" | "path">): Feature {
  return {
    title: partial.id, summary: "", request: { params: {}, query: {}, headers: {}, body: null },
    responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
    ...partial,
  };
}

const catalog: Catalog = {
  system: "demo", generatedAt: "2026-01-01T00:00:00.000Z", rejected: [],
  features: [
    f({ id: "accounts.list", group: "accounts", method: "GET", path: "/accounts" }),           // #1
    f({ id: "users.list", group: "users", method: "GET", path: "/users", confidence: 0.6 }),     // #2
    f({ id: "users.get", group: "users", method: "GET", path: "/users/{id}", hasExample: true }), // #3
    f({ id: "users.delete", group: "users", method: "DELETE", path: "/users/{id}" }),           // #4
  ],
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-expr-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("resolveSelection", () => {
  it("all", async () => {
    expect(await resolveSelection(catalog, ["all"])).toEqual(["accounts.list", "users.list", "users.get", "users.delete"]);
  });
  it("numbers and ranges", async () => {
    expect(await resolveSelection(catalog, ["1,3-4"])).toEqual(["accounts.list", "users.get", "users.delete"]);
  });
  it("ids and globs", async () => {
    expect(await resolveSelection(catalog, ["users.*"])).toEqual(["users.list", "users.get", "users.delete"]);
    expect(await resolveSelection(catalog, ["users.get", "accounts.list"])).toEqual(["accounts.list", "users.get"]);
  });
  it("exclusion", async () => {
    expect(await resolveSelection(catalog, ["users.*,-users.delete"])).toEqual(["users.list", "users.get"]);
  });
  it("filters select from catalog when empty, restrict otherwise", async () => {
    expect(await resolveSelection(catalog, ["method:DELETE"])).toEqual(["users.delete"]);
    expect(await resolveSelection(catalog, ["has:example"])).toEqual(["users.get"]);
    expect(await resolveSelection(catalog, ["users.*,confidence>=0.8"])).toEqual(["users.get", "users.delete"]);
    expect(await resolveSelection(catalog, ["all,-method:GET"])).toEqual(["users.delete"]);
    expect(await resolveSelection(catalog, ["group:users"])).toEqual(["users.list", "users.get", "users.delete"]);
    expect(await resolveSelection(catalog, ["all,-group:users"])).toEqual(["accounts.list"]);
  });
  it("expands @file", async () => {
    const file = path.join(dir, "selection.json");
    await writeFile(file, JSON.stringify({ selected: ["users.get", "accounts.list"] }), "utf8");
    expect(await resolveSelection(catalog, [`@${file}`])).toEqual(["accounts.list", "users.get"]);
  });
  it("errors on unknown id or bad syntax", async () => {
    await expect(resolveSelection(catalog, ["nope.get"])).rejects.toThrow(/알 수 없는 기능 id: nope\.get/);
    await expect(resolveSelection(catalog, ["99"])).rejects.toThrow(/번호 99/);
    await expect(resolveSelection(catalog, ["confidence>>1"])).rejects.toThrow(/해석할 수 없는 선택 항목/);
  });
});
