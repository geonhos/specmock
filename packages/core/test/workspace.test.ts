import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SelectionSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { hashJson } from "../src/util/hash.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-ws-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("Workspace", () => {
  it("writes and reads a validated JSON file", async () => {
    const ws = new Workspace(dir);
    const data = { system: "demo", catalogHash: "abc", selected: ["all"], resolved: ["a.b"], updatedAt: "2026-01-01T00:00:00.000Z" };
    await ws.write("demo", "selection.json", SelectionSchema, data);
    expect(await ws.exists("demo", "selection.json")).toBe(true);
    expect(await ws.read("demo", "selection.json", SelectionSchema)).toEqual(data);
  });

  it("throws a friendly error when a file is missing", async () => {
    const ws = new Workspace(dir);
    await expect(ws.read("demo", "catalog.json", SelectionSchema)).rejects.toThrow(/catalog\.json.*specmock analyze/);
  });
});

describe("hashJson", () => {
  it("is stable across key order", () => {
    expect(hashJson({ a: 1, b: [1, { c: 2 }] })).toBe(hashJson({ b: [1, { c: 2 }], a: 1 }));
  });
});
