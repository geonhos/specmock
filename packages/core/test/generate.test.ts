import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE, ROOT_NODE_MODULES } from "./helpers.js";

const exists = (p: string) => access(p).then(() => true, () => false);

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

  it("keeps preserving an edited fixture across repeated regenerates", async () => {
    await generate(ws, "petstore", { outDir: out });
    const fixture = path.join(out, "fixtures/getPet/200.json");
    await writeFile(fixture, JSON.stringify({ id: 99, name: "Edited" }), "utf8");

    const second = await generate(ws, "petstore", { outDir: out });
    expect(second.preserved).toContain("fixtures/getPet/200.json");
    const third = await generate(ws, "petstore", { outDir: out });
    expect(third.preserved).toContain("fixtures/getPet/200.json");
    expect(JSON.parse(await readFile(fixture, "utf8"))).toEqual({ id: 99, name: "Edited" });

    // lock에는 생성기가 썼을 내용의 해시가 남아 있어야 한다(사용자 수정본의 해시가 아니라).
    const lock = await readLock(out);
    const { createHash } = await import("node:crypto");
    const generated = JSON.stringify({ id: 1, name: "Rex", tag: "dog" }, null, 2) + "\n";
    expect(lock?.fixtureHashes["fixtures/getPet/200.json"]).toBe(createHash("sha256").update(generated).digest("hex"));
  });

  it("removes orphaned contracts, routes and unedited fixtures when features are deselected", async () => {
    await select(ws, "petstore", ["all"]);
    await generate(ws, "petstore", { outDir: out });
    expect(await exists(path.join(out, "contracts/listPets.json"))).toBe(true);
    expect(await exists(path.join(out, "src/routes/store.ts"))).toBe(true);
    expect(await exists(path.join(out, "fixtures/inventory.list/200.json"))).toBe(true);

    await select(ws, "petstore", ["getPet", "createPet", "deletePet"]);
    const report = await generate(ws, "petstore", { outDir: out });
    expect(report.orphaned).toEqual([]);
    expect(await exists(path.join(out, "contracts/listPets.json"))).toBe(false);
    expect(await exists(path.join(out, "contracts/inventory.list.json"))).toBe(false);
    expect(await exists(path.join(out, "src/routes/store.ts"))).toBe(false);
    expect(await exists(path.join(out, "fixtures/inventory.list"))).toBe(false);
    expect(await exists(path.join(out, "fixtures/listPets"))).toBe(false);
    expect(await exists(path.join(out, "src/routes/pets.ts"))).toBe(true);
    expect(await exists(path.join(out, "fixtures/getPet/200.json"))).toBe(true);
    const lock = await readLock(out);
    expect(Object.keys(lock?.fixtureHashes ?? {})).not.toContain("fixtures/listPets/200.json");
  });

  it("keeps an edited fixture of a deselected feature and reports it as orphaned", async () => {
    await select(ws, "petstore", ["all"]);
    await generate(ws, "petstore", { outDir: out });
    const fixture = path.join(out, "fixtures/listPets/200.json");
    await writeFile(fixture, JSON.stringify([{ id: 7, name: "Kept" }]), "utf8");

    await select(ws, "petstore", ["getPet", "createPet", "deletePet"]);
    const report = await generate(ws, "petstore", { outDir: out });
    expect(report.orphaned).toEqual(["fixtures/listPets/200.json"]);
    expect(JSON.parse(await readFile(fixture, "utf8"))).toEqual([{ id: 7, name: "Kept" }]);
    expect(await exists(path.join(out, "contracts/listPets.json"))).toBe(false);
  });

  it("generated project typechecks under NodeNext", { timeout: 60_000 }, async () => {
    await select(ws, "petstore", ["all"]);
    await generate(ws, "petstore", { outDir: out });
    await symlink(ROOT_NODE_MODULES, path.join(out, "node_modules"), "dir");

    const tsc = path.join(ROOT_NODE_MODULES, ".bin", "tsc");
    const result = await promisify(execFile)(tsc, ["--noEmit", "-p", "tsconfig.json"], { cwd: out })
      .then((r) => ({ code: 0, ...r }))
      .catch((e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    expect(result.code, `tsc failed\n${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
