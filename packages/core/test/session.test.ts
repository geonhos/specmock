// packages/core/test/session.test.ts
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { readLock } from "../src/generate/lock.js";
import { GenerateRequestSchema } from "../src/generate/request.js";
import { finalizeGeneration, prepareGeneration, SESSION_MARKER } from "../src/generate/session.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { verifyMock } from "../src/service/verify.js";
import { MockSpecSchema } from "../src/types.js";
import { hashJson, hashText } from "../src/util/hash.js";
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
    expect(lock).toMatchObject({ language: "fake", generator: "llm", install: null, sourceFiles: { "server.mjs": hashText(src) } });
    await expect(access(path.join(out, SESSION_MARKER))).rejects.toMatchObject({ code: "ENOENT" });
    const v = await verifyMock(ws, "petstore");
    expect(v.result.failed + v.result.runtimeFailed).toBe(0);
  }, 60_000);
});
