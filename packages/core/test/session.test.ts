// packages/core/test/session.test.ts
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock } from "../src/generate/lock.js";
import { GenerateRequestSchema } from "../src/generate/request.js";
import { finalizeGeneration, prepareGeneration, SESSION_MARKER } from "../src/generate/session.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { verifyMock } from "../src/service/verify.js";
import { MockSpecSchema } from "../src/types.js";
import { hashJson, hashText } from "../src/util/hash.js";
import { specInputHash } from "../src/util/specHash.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let out: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-session-"));
  out = path.join(dir, "mock");
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const prep = () => prepareGeneration(ws, "petstore", { outDir: out, profile: fakeProfile });
const fin = () => finalizeGeneration(ws, "petstore", { profile: fakeProfile });
const spec = () => ws.read("petstore", "mockspec.json", MockSpecSchema);
const put = async (rel: string, content: string) => { await mkdir(path.dirname(path.join(out, rel)), { recursive: true }); await writeFile(path.join(out, rel), content); };

describe("prepareGeneration", () => {
  it("지시서와 진행 표식을 쓰고 다음 할 일을 돌려준다", async () => {
    const r = await prep();
    expect(r).toMatchObject({ mode: "session", outDir: out, language: "fake", reused: false });
    expect(r.requestPath).toBe(ws.file("petstore", "generate-request.json"));
    expect(r.nextSteps.join("\n")).toContain("finalize");
    const req = await ws.read("petstore", "generate-request.json", GenerateRequestSchema);
    expect(req).toMatchObject({ language: "fake", outDir: out, mockspecHash: hashJson(await spec()), protectedHashes: {} });
    expect(JSON.parse(await readFile(path.join(out, SESSION_MARKER), "utf8"))).toEqual({ system: "petstore", language: "fake", mockspecHash: req.mockspecHash });
  });

  it("같은 mockspec이면 지시서를 다시 쓰지 않는다. 진행 표식이 있는 outDir은 force 없이 통과", async () => {
    await prep();
    const before = (await stat(ws.file("petstore", "generate-request.json"))).mtimeMs;
    await put("server.mjs", "// 작성 중\n");
    const r = await prep();
    expect(r.reused).toBe(true);
    expect((await stat(ws.file("petstore", "generate-request.json"))).mtimeMs).toBe(before);
  });
});

describe("finalizeGeneration", () => {
  it("지시서 없음 → no-request", async () => {
    expect(await fin()).toMatchObject({ ok: false, reason: "no-request" });
  });

  it("select가 바뀌면 stale-request", async () => {
    await prep();
    await select(ws, "petstore", ["getPet"]);
    expect(await fin()).toMatchObject({ ok: false, reason: "stale-request", errors: ["select가 바뀌었습니다. generate_mock을 다시 호출하세요"] });
  });

  it("보호 경로에 파일이 생기면 protected-path-modified", async () => {
    await prep();
    await put("server.mjs", fakeServerSource(await spec()));
    await put("fixtures/getPet/200.json", "{}");
    expect(await fin()).toMatchObject({ ok: false, reason: "protected-path-modified", errors: ["fixtures/getPet/200.json"] });
  });

  it("sourceGlobs 안에 파일이 없으면 no-sources", async () => {
    await prep();
    expect(await fin()).toMatchObject({ ok: false, reason: "no-sources" });
  });

  it("파일 수가 maxFiles를 넘으면 too-many-files", async () => {
    await prep();
    await put("server.mjs", "x");
    for (let i = 0; i < 5; i++) await put(`lib/m${i}.mjs`, "x");
    const r = await fin();
    expect(r).toMatchObject({ ok: false, reason: "too-many-files" });
    expect(r.ok === false && r.errors[0]).toBe("파일 6개 > 최대 5개");
  });

  it("성공: scaffold·lock(sourceFiles)을 쓰고 표식을 지우며 verify가 통과한다", async () => {
    await prep();
    const src = fakeServerSource(await spec());
    await put("server.mjs", src);
    const r = await fin();
    expect(r).toMatchObject({ ok: true, outDir: out, warnings: [] });
    expect(r.ok && r.written).toEqual(expect.arrayContaining(["fixtures/getPet/200.json", "contracts/getPet.json"]));
    const lock = (await readLock(out))!;
    expect(lock.inputHash).toBe(specInputHash(await spec()));
    expect(lock).toMatchObject({ language: "fake", generator: "llm", install: null, sourceFiles: { "server.mjs": hashText(src) } });
    await expect(access(path.join(out, SESSION_MARKER))).rejects.toMatchObject({ code: "ENOENT" });
    const v = await verifyMock(ws, "petstore");
    expect(v.result.failed + v.result.runtimeFailed).toBe(0);
  }, 60_000);
});

describe("재finalize와 언어 변경", () => {
  it("finalize 뒤 verify가 마커·산출물을 만들고 소스를 고쳐도 재finalize가 통과한다. 지시서를 재사용해도 마찬가지", async () => {
    const profile = { ...fakeProfile, artifacts: ["build"], protectedPaths: [...fakeProfile.protectedPaths, "build/**"] };
    const prepP = () => prepareGeneration(ws, "petstore", { outDir: out, profile });
    const finP = () => finalizeGeneration(ws, "petstore", { profile });
    await prepP();
    await put("server.mjs", fakeServerSource(await spec()));
    expect(await finP()).toMatchObject({ ok: true });
    await put(".specmock-installed", "key");   // verify가 만드는 설치 마커 흉내
    await put("build/out.bin", "x");            // 프로필 산출물
    await put("server.mjs", fakeServerSource(await spec()) + "// 수정\n");
    expect(await finP()).toMatchObject({ ok: true });
    expect(await prepP()).toMatchObject({ reused: true });
    await put("lib/a.mjs", "export {};\n");
    expect(await finP()).toMatchObject({ ok: true });
  }, 60_000);

  it("finalize 뒤 지시서의 protectedHashes가 낡아도 prepare(reused)가 갱신해 finalize가 ok", async () => {
    await prep();
    await put("server.mjs", fakeServerSource(await spec()));
    expect(await fin()).toMatchObject({ ok: true });
    const stale = await ws.read("petstore", "generate-request.json", GenerateRequestSchema);
    await ws.write("petstore", "generate-request.json", GenerateRequestSchema, { ...stale, protectedHashes: { ...stale.protectedHashes, "fixtures/getPet/200.json": "0".repeat(64) } });
    expect(await prep()).toMatchObject({ reused: true });
    const fresh = await ws.read("petstore", "generate-request.json", GenerateRequestSchema);
    expect(fresh.protectedHashes).toEqual(stale.protectedHashes);
    await put("lib/a.mjs", "export {};\n");
    expect(await fin()).toMatchObject({ ok: true });
  }, 60_000);

  it("세션 진행 중 prepare(reused)는 protectedHashes를 갱신하지 않는다: 변조 뒤 재prepare해도 finalize는 거부", async () => {
    await prep();
    await put("server.mjs", fakeServerSource(await spec()));
    await put("fixtures/getPet/200.json", "{\"edited\":true}");
    expect(await fin()).toMatchObject({ ok: false, reason: "protected-path-modified", errors: ["fixtures/getPet/200.json"] });
    expect(await prep()).toMatchObject({ reused: true });
    expect(await fin()).toMatchObject({ ok: false, reason: "protected-path-modified", errors: ["fixtures/getPet/200.json"] });
  }, 60_000);

  it("--force 언어 변경 세션: 사용자가 고친 fixture는 보존하고 경고한다", async () => {
    await generate(ws, "petstore", { outDir: out });
    const edited = "{\"mine\":true}\n";
    await writeFile(path.join(out, "fixtures", "getPet", "200.json"), edited);
    await prepareGeneration(ws, "petstore", { outDir: out, profile: fakeProfile, force: true });
    await put("server.mjs", fakeServerSource(await spec()));
    const r = await fin();
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.warnings.join("\n")).toContain("fixtures/getPet/200.json");
    expect(await readFile(path.join(out, "fixtures", "getPet", "200.json"), "utf8")).toBe(edited);
    expect(await access(path.join(out, "src", "server.ts")).then(() => true, () => false)).toBe(false);
  }, 60_000);

  it("finalize 사이에 사용자가 fixture를 고치면 여전히 protected-path-modified", async () => {
    await prep();
    await put("server.mjs", fakeServerSource(await spec()));
    expect(await fin()).toMatchObject({ ok: true });
    await put("fixtures/getPet/200.json", "{\"edited\":true}");
    expect(await fin()).toMatchObject({ ok: false, reason: "protected-path-modified", errors: ["fixtures/getPet/200.json"] });
  }, 60_000);

  it("ts mock 위에 --force prepare(fake) → finalize: TS 소스·node_modules는 지우고 fixtures·contracts는 유지", async () => {
    await generate(ws, "petstore", { outDir: out });
    await mkdir(path.join(out, "node_modules"));
    await writeFile(path.join(out, "node_modules", "x"), "x");
    const fixture = await readFile(path.join(out, "fixtures", "getPet", "200.json"), "utf8");
    const r = await prepareGeneration(ws, "petstore", { outDir: out, profile: fakeProfile, force: true });
    expect(r.language).toBe("fake");
    expect(JSON.parse(await readFile(path.join(out, SESSION_MARKER), "utf8")).previous.language).toBe("ts");
    await put("server.mjs", fakeServerSource(await spec()));
    expect(await access(path.join(out, "src", "server.ts")).then(() => true, () => false)).toBe(true);   // finalize 전에는 그대로
    expect(await finalizeGeneration(ws, "petstore", { profile: fakeProfile })).toMatchObject({ ok: true });
    for (const gone of ["src/server.ts", "package.json", "node_modules"]) {
      expect(await access(path.join(out, gone)).then(() => true, () => false), gone).toBe(false);
    }
    expect(await readFile(path.join(out, "fixtures", "getPet", "200.json"), "utf8")).toBe(fixture);
    await access(path.join(out, "contracts", "getPet.json"));
    expect((await readLock(out))!.language).toBe("fake");
  }, 60_000);

  it("finalize가 실패하면(no-sources) 이전 언어 소스를 지우지 않는다", async () => {
    await generate(ws, "petstore", { outDir: out });
    await prepareGeneration(ws, "petstore", { outDir: out, profile: fakeProfile, force: true });
    expect(await fin()).toMatchObject({ ok: false, reason: "no-sources" });
    await access(path.join(out, "src", "server.ts"));
  }, 60_000);
});
