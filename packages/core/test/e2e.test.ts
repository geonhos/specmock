import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { renderCoverage } from "../src/verify/coverage.js";
import { verify } from "../src/verify/index.js";
import { markInstalled, startMock } from "../src/verify/server.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE, ROOT_NODE_MODULES } from "./helpers.js";

let dir: string;
let ws: Workspace;
let out: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-e2e-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  out = path.join(dir, "mock", "petstore");
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function linkNodeModules() {
  await symlink(ROOT_NODE_MODULES, path.join(out, "node_modules"), "dir");
  // 루트 node_modules를 쓰므로 npm install을 건너뛴다(마커는 outDir마다 따로 생긴다).
  await markInstalled(out, (await readLock(out))!);
}

describe("e2e: ingest → analyze → select → generate → verify", () => {
  it("all contracts pass for the full petstore", async () => {
    await select(ws, "petstore", ["all"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();

    const result = await verify(out);
    expect(result.failed, JSON.stringify(result.results.filter((r) => !r.passed), null, 2)).toBe(0);
    expect(result.total).toBeGreaterThanOrEqual(6); // 5 정상 + createPet 필수 누락

    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const md = renderCoverage(spec, result);
    expect(md).toContain("# petstore coverage");
    expect(md).toContain("선택 기능: 5 / 5");
    expect(md).toMatch(/spec-example\s*\|\s*1/);
    expect(md).toContain("contract: 통과 " + result.passed);
  });

  it("answers 501 not_mocked for unselected catalog paths and 404 for unknown ones", async () => {
    await select(ws, "petstore", ["getPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();

    const lock = (await readLock(out))!;
    const server = await startMock(out, lock);
    try {
      const notMocked = await fetch(`http://127.0.0.1:${server.port}/pets`, { method: "POST" });
      expect(notMocked.status).toBe(501);
      expect(await notMocked.json()).toMatchObject({ error: "not_mocked", feature: "createPet" });

      const unknown = await fetch(`http://127.0.0.1:${server.port}/nope`);
      expect(unknown.status).toBe(404);

      const ok = await fetch(`http://127.0.0.1:${server.port}/pets/7`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: 1, name: "Rex", tag: "dog" });

      const bad = await fetch(`http://127.0.0.1:${server.port}/pets/abc`);
      expect(bad.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("reports a failing contract when a fixture violates the schema", async () => {
    await select(ws, "petstore", ["getPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();
    await writeFile(path.join(out, "fixtures/getPet/200.json"), JSON.stringify({ id: "not-a-number" }), "utf8");

    const result = await verify(out);
    expect(result.failed).toBe(1);
    expect(result.results[0].errors.join("\n")).toMatch(/name|integer/);
    expect(await readFile(path.join(out, "specmock.lock.json"), "utf8")).toContain("getPet");
  });

  it("verify still passes after deselecting features and regenerating (orphan cleanup)", async () => {
    await select(ws, "petstore", ["all"]);
    await generate(ws, "petstore", { outDir: out });
    await select(ws, "petstore", ["getPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();
    const result = await verify(out);
    expect(result.total).toBe(1);
    expect(result.failed).toBe(0);
    expect((await readdir(path.join(out, "contracts"))).sort()).toEqual(["getPet.json"]);
  });

  it("fails fast with a clear message when the start command cannot be spawned", async () => {
    await select(ws, "petstore", ["getPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();
    const lock = (await readLock(out))!;
    await expect(startMock(out, { ...lock, start: { command: "definitely-not-a-command-xyz", args: [] } }, { timeoutMs: 5000 }))
      .rejects.toThrow(/시작할 수 없습니다.*ENOENT/);
  });
});
