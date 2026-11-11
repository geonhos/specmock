// packages/core/test/generateLlm.test.ts
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock } from "../src/generate/lock.js";
import { readUsage } from "../src/llm/usageLog.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { verifyMock } from "../src/service/verify.js";
import { GenerateInfoSchema, MockSpecSchema, type MockSpec } from "../src/types.js";
import { hashJson, hashText } from "../src/util/hash.js";
import { specInputHash } from "../src/util/specHash.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");

let dir: string;
let genDir: string;
let out: string;
let ws: Workspace;
const specNow = () => ws.read("petstore", "mockspec.json", MockSpecSchema);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-genllm-"));
  genDir = path.join(dir, "gen");
  out = path.join(dir, "mock");
  await mkdir(genDir);
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const adapter = () => new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
const respond = (n: number, body: unknown) => writeFile(path.join(genDir, `${n}.json`), JSON.stringify(body));
const calls = async () => Number(await readFile(path.join(genDir, "count"), "utf8"));
const opts = () => ({ outDir: out, profile: fakeProfile, adapter: adapter() });
const answer = (spec: MockSpec, extra: { path: string; content: string | null }[] = []) => ({ files: [{ path: "server.mjs", content: fakeServerSource(spec) }, ...extra], notes: ["가정: 인증 없음"] });

describe("generate (LLM 생성기)", () => {
  it("시도마다 llm-usage.jsonl에 stage·detail과 함께 한 줄씩 남긴다(실패 시도 포함)", async () => {
    const spec = await specNow();
    await respond(1, { files: [{ path: "../evil.mjs", content: "x" }], notes: [] });
    await respond(2, answer(spec));
    await generate(ws, "petstore", opts());
    const rows = await readUsage(ws.dir("petstore"));
    expect(rows.map((r) => [r.stage, r.detail, r.ok])).toEqual([["generate", "fake attempt 1/3", true], ["generate", "fake attempt 2/3", true]]);
    expect(rows[0]).toMatchObject({ inputTokens: null, billing: expect.any(String) });
    expect(JSON.stringify(rows)).not.toContain("evil.mjs");   // 응답 본문은 남기지 않는다
  }, 60_000);

  it("파일·scaffold·lock·generate.json을 쓰고 verify가 통과한다", async () => {
    await respond(1, answer(await specNow()));
    const r = await generate(ws, "petstore", opts());
    expect(r).toMatchObject({ language: "fake", attempts: 1, notes: ["가정: 인증 없음"], skipped: false, userModified: [] });
    expect(r.written).toEqual(expect.arrayContaining(["server.mjs", "fixtures/getPet/200.json", "contracts/getPet.json"]));
    expect(r.launch).toBe(`cd ${out} && node server.mjs`);
    const lock = (await readLock(out))!;
    expect(lock).toMatchObject({ language: "fake", generator: "llm", install: null, startTimeoutMs: 10_000, installTimeoutMs: 10_000 });
    expect(lock.sourceFiles).toEqual({ "server.mjs": hashText(await readFile(path.join(out, "server.mjs"), "utf8")) });
    expect(await ws.read("petstore", "generate.json", GenerateInfoSchema)).toMatchObject({ outDir: out, language: "fake", notes: ["가정: 인증 없음"], attempts: 1 });
    const v = await verifyMock(ws, "petstore");
    expect(v.result.failed + v.result.runtimeFailed).toBe(0);
    expect(v.coverageMarkdown).toContain("## 생성 메모\n\n- 가정: 인증 없음");
  }, 60_000);

  it("mockspec이 같으면 LLM을 부르지 않는다(skipped)", async () => {
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    const r = await generate(ws, "petstore", opts());
    expect(r).toMatchObject({ skipped: true, written: [], attempts: 0, launch: `cd ${out} && node server.mjs` });
    expect(await calls()).toBe(1);
  }, 60_000);

  it("--force면 같은 mockspec이어도 다시 생성한다", async () => {
    const spec = await specNow();
    await respond(1, answer(spec));
    await respond(2, answer(spec));
    await generate(ws, "petstore", opts());
    const r = await generate(ws, "petstore", { ...opts(), force: true });
    expect(r.skipped).toBe(false);
    expect(await calls()).toBe(2);
  }, 60_000);

  it("fixture만 바뀌면 LLM 없이 scaffold만 다시 쓴다", async () => {
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    expect((await readLock(out))!.inputHash).toBe(specInputHash(await specNow()));
    const spec = await specNow();
    const changed: MockSpec = {
      ...spec,
      features: spec.features.map((f) => f.id !== "getPet" ? f : { ...f, fixtures: f.fixtures.map((x) => x.status === 200 ? { status: 200, body: { id: 9, name: "Real" }, source: "recorded" as const } : x) }),
    };
    await ws.write("petstore", "mockspec.json", MockSpecSchema, changed);
    const r = await generate(ws, "petstore", opts());
    expect(r).toMatchObject({ skipped: false, attempts: 0, notes: ["fixture만 바뀌어 LLM을 다시 부르지 않았습니다"], userModified: [] });
    expect(r.written).toContain("fixtures/getPet/200.json");
    expect(await calls()).toBe(1);
    expect(JSON.parse(await readFile(path.join(out, "fixtures/getPet/200.json"), "utf8"))).toEqual({ id: 9, name: "Real" });
    const lock = (await readLock(out))!;
    expect(lock.mockspecHash).toBe(hashJson(changed));
    expect(lock.sourceFiles).toEqual({ "server.mjs": hashText(await readFile(path.join(out, "server.mjs"), "utf8")) });
    expect((await ws.read("petstore", "generate.json", GenerateInfoSchema)).notes).toEqual(["가정: 인증 없음"]);
    // 같은 내용으로 한 번 더: 이제는 mockspecHash가 같아 skipped
    expect((await generate(ws, "petstore", opts())).skipped).toBe(true);
  }, 60_000);

  it("inputHash가 같으면 LLM을 부르지 않고, 기능 정의가 바뀌어 inputHash가 달라지면 다시 부른다", async () => {
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    const spec = await specNow();
    const mapGetPet = (fn: (f: MockSpec["features"][number]) => MockSpec["features"][number]): MockSpec => ({ ...spec, features: spec.features.map((f) => (f.id === "getPet" ? fn(f) : f)) });
    // (a) fixture만 바뀜: inputHash 동일 → 지름길, LLM 미호출
    const fixtureOnly = mapGetPet((f) => ({ ...f, fixtures: f.fixtures.map((x) => (x.status === 200 ? { status: 200, body: { id: 9, name: "Real" }, source: "recorded" as const } : x)) }));
    expect(specInputHash(fixtureOnly)).toBe(specInputHash(spec));
    await ws.write("petstore", "mockspec.json", MockSpecSchema, fixtureOnly);
    expect((await generate(ws, "petstore", opts())).attempts).toBe(0);
    expect(await calls()).toBe(1);
    // (b) 기능 정의(summary)가 바뀜: inputHash 다름 → 지름길 불가, LLM 호출
    const moved = mapGetPet((f) => ({ ...f, summary: `${f.summary} (정의 변경)` }));
    expect(specInputHash(moved)).not.toBe(specInputHash(spec));
    await ws.write("petstore", "mockspec.json", MockSpecSchema, moved);
    await respond(2, answer(await specNow()));
    expect((await generate(ws, "petstore", opts())).attempts).toBe(1);
    expect(await calls()).toBe(2);
  }, 60_000);

  it("증분: 기존 소스·사용자 수정을 지시서에 넣고 content:null은 지운다", async () => {
    await respond(1, answer(await specNow(), [{ path: "lib/old.mjs", content: "export {};\n" }]));
    await generate(ws, "petstore", opts());
    await appendFile(path.join(out, "server.mjs"), "// 사용자 메모\n");
    await select(ws, "petstore", ["getPet", "createPet", "listPets"]);
    await respond(2, answer(await specNow(), [{ path: "lib/old.mjs", content: null }]));
    const r = await generate(ws, "petstore", opts());
    const prompt2 = await readFile(path.join(genDir, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("## 7. 증분 생성");
    expect(prompt2).toContain("### server.mjs (사용자 수정)");
    expect(prompt2).toContain("### lib/old.mjs");
    await expect(access(path.join(out, "lib/old.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(r.userModified).toEqual(["server.mjs"]);
    expect(Object.keys((await readLock(out))!.sourceFiles)).toEqual(["server.mjs"]);
  }, 60_000);

  it(".specmock-attempt/만 있는 디렉터리는 specmock 디렉터리로 보고, 시작할 때 지운다", async () => {
    await mkdir(path.join(out, ".specmock-attempt"), { recursive: true });
    await writeFile(path.join(out, ".specmock-attempt", "errors.md"), "x");
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    await expect(access(path.join(out, ".specmock-attempt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("--max-attempts가 1 미만이면 옵션 단계에서 거부한다", async () => {
    for (const n of [0, -1, 1.5]) {
      await expect(generate(ws, "petstore", { ...opts(), maxAttempts: n })).rejects.toThrow("--max-attempts는 1 이상");
    }
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("--force 언어 변경은 생성 성공 뒤에만 지운다", () => {
    const exists = (rel: string) => access(path.join(out, rel)).then(() => true, () => false);
    async function tsMock() {
      await generate(ws, "petstore", { outDir: out });
      await mkdir(path.join(out, "node_modules"));
      await writeFile(path.join(out, "node_modules", "x"), "x");
    }

    it("생성이 실패하면 TS 소스·lock이 그대로이고 .specmock-attempt/만 생긴다", async () => {
      await tsMock();
      const lockBefore = await readFile(path.join(out, "specmock.lock.json"), "utf8");
      const bad = { files: [{ path: "server.mjs", content: fakeServerSource(await specNow(), { omit501: true }) }], notes: [] };
      await respond(1, bad);
      await respond(2, bad);
      await expect(generate(ws, "petstore", { ...opts(), force: true, maxAttempts: 2 })).rejects.toMatchObject({ exitCode: 5 });
      expect(await exists("src/server.ts")).toBe(true);
      expect(await exists("node_modules/x")).toBe(true);
      expect(await readFile(path.join(out, "specmock.lock.json"), "utf8")).toBe(lockBefore);
      expect(await exists(".specmock-attempt/errors.md")).toBe(true);
      expect(await exists("server.mjs")).toBe(false);
    }, 60_000);

    it("성공하면 TS 소스·node_modules가 지워지고 fake 파일과 새 lock이 생긴다", async () => {
      await tsMock();
      await respond(1, answer(await specNow()));
      await generate(ws, "petstore", { ...opts(), force: true });
      expect(await exists("src/server.ts")).toBe(false);
      expect(await exists("package.json")).toBe(false);
      expect(await exists("node_modules")).toBe(false);
      expect(await exists("server.mjs")).toBe(true);
      expect((await readLock(out))!.language).toBe("fake");
    }, 60_000);

    it("언어 변경 --force는 사용자가 고친 fixture를 보존한다(같은 언어 --force는 덮어쓴다)", async () => {
      await tsMock();
      const fx = path.join(out, "fixtures", "getPet", "200.json");
      const mine = JSON.stringify(JSON.parse(await readFile(fx, "utf8"))) + "\n";   // 같은 내용, 다른 서식 = 사용자 수정
      await writeFile(fx, mine);
      await respond(1, answer(await specNow()));
      const r = await generate(ws, "petstore", { ...opts(), force: true });
      expect(r.preserved).toContain("fixtures/getPet/200.json");
      expect(await readFile(fx, "utf8")).toBe(mine);
      expect(await exists("src/server.ts")).toBe(false);
      await respond(2, answer(await specNow()));
      await generate(ws, "petstore", { ...opts(), force: true });
      expect(await readFile(fx, "utf8")).not.toBe(mine);
    }, 60_000);

    it("옛 ts lock(sourceFiles 없음)에서 바꾸면 ts 산출물을 지우고 사용자 파일은 둔다", async () => {
      await tsMock();
      const lockPath = path.join(out, "specmock.lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, JSON.stringify({ ...lock, sourceFiles: {} }));
      await writeFile(path.join(out, "package-lock.json"), "{}");
      await writeFile(path.join(out, "stray.txt"), "x");
      await respond(1, answer(await specNow()));
      await generate(ws, "petstore", { ...opts(), force: true });
      expect(await exists("package-lock.json")).toBe(false);
      expect(await exists("node_modules")).toBe(false);
      expect(await exists("src/server.ts")).toBe(false);
      expect(await readFile(path.join(out, "stray.txt"), "utf8")).toBe("x");
    }, 60_000);
  });
});
