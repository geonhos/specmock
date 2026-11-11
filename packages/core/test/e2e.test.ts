import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock, writeLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { renderCoverage } from "../src/verify/coverage.js";
import { verify, verifyFailed } from "../src/verify/index.js";
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
    expect(result.total).toBeGreaterThanOrEqual(7); // 5 정상 + createPet 필수 누락 + createPet 폼 바디 요청

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
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const rt = await verify(out, { runtime: { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) } });
    expect(rt.runtime.map((c) => [c.id, c.passed]), JSON.stringify(rt.runtime, null, 2)).toEqual([["not_mocked", true], ["unknown_path", true]]);
    expect(rt.runtimeFailed).toBe(0);
    expect(rt.total).toBe(1);
  });

  it("501을 내지 않는 서버는 verify()에서 런타임 계약 실패가 되고 contract 결과는 따로 센다", async () => {
    await select(ws, "petstore", ["getPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();
    // 모든 경로 200(헬스 포함), /pets/* 는 fixture를 그대로 준다. 501·404는 절대 내지 않는다.
    await writeFile(path.join(out, "always200.mjs"), `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const fx = readFileSync("fixtures/getPet/200.json", "utf8");
createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url.startsWith("/pets/") ? fx : "{}"); }).listen(Number(process.env.PORT), "127.0.0.1");
`);
    const lock = (await readLock(out))!;
    await writeLock(out, { ...lock, start: { command: process.execPath, args: ["always200.mjs"] } });
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const result = await verify(out, { runtime: { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) } });
    expect(result.failed, JSON.stringify(result.results, null, 2)).toBe(0);
    expect(result.runtimeFailed).toBeGreaterThan(0);
    expect(result.runtime.filter((c) => !c.passed).map((c) => c.id)).toContain("unknown_path");
    expect(verifyFailed(result)).toBe(true);
  });

  it("fails fast with a clear message when the start command cannot be spawned", async () => {
    await select(ws, "petstore", ["getPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();
    const lock = (await readLock(out))!;
    await expect(startMock(out, { ...lock, start: { command: "definitely-not-a-command-xyz", args: [] } }, { timeoutMs: 5000 }))
      .rejects.toThrow(/시작할 수 없습니다.*ENOENT/);
  });

  it("생성 mock이 form-encoded 요청을 읽고 검증한다", async () => {
    await select(ws, "petstore", ["createPet"]);
    await generate(ws, "petstore", { outDir: out });
    await linkNodeModules();
    const server = await startMock(out, (await readLock(out))!);
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`http://127.0.0.1:${server.port}/pets`, { method: "POST", headers, body });
    try {
      const form = "application/x-www-form-urlencoded";
      expect((await post({ "content-type": form }, "name=rex&tag=dog")).status).toBe(201);
      expect((await post({ "content-type": `${form}; charset=utf-8` }, "name=rex")).status).toBe(201);
      // 필수 name이 없으면 400. form 본문이 읽혔다는 증거는 위 두 건의 201이다(읽히지 않으면 body 없음으로 400).
      expect((await post({ "content-type": form }, "tag=dog")).status).toBe(400);
      // multipart는 지원하지 않아 본문 없음으로 취급한다(기존 동작).
      expect((await post({ "content-type": "multipart/form-data; boundary=x" }, "--x--")).status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});
