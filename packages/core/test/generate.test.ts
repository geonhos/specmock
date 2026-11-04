import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let ws: Workspace;
let out: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-gen-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  out = path.join(dir, "mock", "petstore");
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet", "deletePet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("generate(ts-hono)", () => {
  it("renders the project layout, fixtures, contracts and lock", async () => {
    const report = await generate(ws, "petstore", { outDir: out });
    expect(report.outDir).toBe(out);

    const files = (await readdir(out, { recursive: true })).map((f) => f.split(path.sep).join("/")).sort();
    expect(files).toEqual(expect.arrayContaining([
      "package.json", "tsconfig.json", "README.md", "specmock.lock.json",
      "src/server.ts", "src/notMocked.ts", "src/fixtures.ts", "src/validate.ts", "src/routes/pets.ts",
      "fixtures/getPet/200.json", "fixtures/getPet/404.json", "fixtures/createPet/201.json", "fixtures/createPet/400.json", "fixtures/deletePet/204.json",
      "contracts/getPet.json", "contracts/createPet.json", "contracts/deletePet.json",
    ]));

    const route = await readFile(path.join(out, "src/routes/pets.ts"), "utf8");
    expect(route).toContain('app.on("GET", "/pets/:petId"');
    expect(route).toContain('app.on("POST", "/pets"');
    expect(route).toContain('return c.body(null, 204)');

    const server = await readFile(path.join(out, "src/server.ts"), "utf8");
    expect(server).toContain('import { register as register_pets } from "./routes/pets.js"');
    expect(server).toContain("/__specmock/health");

    const notMocked = await readFile(path.join(out, "src/notMocked.ts"), "utf8");
    expect(notMocked).toContain('"listPets"');
    expect(notMocked).toContain('"inventory.list"');

    expect(JSON.parse(await readFile(path.join(out, "fixtures/getPet/200.json"), "utf8"))).toEqual({ id: 1, name: "Rex", tag: "dog" });

    const lock = await readLock(out);
    expect(lock?.language).toBe("ts");
    expect(lock?.start).toEqual({ command: "npx", args: ["tsx", "src/server.ts"] });
    expect(Object.keys(lock?.fixtureHashes ?? {})).toContain("fixtures/getPet/200.json");
  });

  it("preserves user-edited fixtures on regenerate unless force", async () => {
    await generate(ws, "petstore", { outDir: out });
    const fixture = path.join(out, "fixtures/getPet/200.json");
    await writeFile(fixture, JSON.stringify({ id: 99, name: "Edited" }), "utf8");

    const second = await generate(ws, "petstore", { outDir: out });
    expect(second.preserved).toContain("fixtures/getPet/200.json");
    expect(JSON.parse(await readFile(fixture, "utf8"))).toEqual({ id: 99, name: "Edited" });

    const third = await generate(ws, "petstore", { outDir: out, force: true });
    expect(third.preserved).toEqual([]);
    expect(JSON.parse(await readFile(fixture, "utf8"))).toEqual({ id: 1, name: "Rex", tag: "dog" });
  });
});
