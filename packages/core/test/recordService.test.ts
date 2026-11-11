// packages/core/test/recordService.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { LockSchema, readLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { forbiddenLlmAdapter } from "../src/llm/forbidden.js";
import { LlmForbiddenError } from "../src/generate/errors.js";
import { select } from "../src/select/index.js";
import { CatalogSchema, SelectionSchema } from "../src/types.js";
import { recordResponses } from "../src/service/record.js";
import { MockSpecSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { startFakeTarget, type FakeTarget } from "./fakeTarget.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const SYS = "petstore";
const REAL = { id: 1, name: "Real" };

let dir: string;
let genDir: string;
let out: string;
let ws: Workspace;
let t: FakeTarget;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-recsvc-"));
  genDir = path.join(dir, "gen");
  out = path.join(dir, "mock");
  await mkdir(genDir);
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, SYS, [PETSTORE]);
  await analyze(ws, SYS);
  await select(ws, SYS, ["getPet", "createPet"]);
  t = await startFakeTarget((q) => (q.path.startsWith("/pets/") ? { status: 200, body: REAL } : { status: 404 }));
  await ws.writeText(SYS, "target.json", JSON.stringify({ baseUrl: t.url }));
});
afterEach(async () => { await t.close(); await rm(dir, { recursive: true, force: true }); });

const adapter = () => new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
const calls = async () => Number(await readFile(path.join(genDir, "count"), "utf8"));
const specNow = () => ws.read(SYS, "mockspec.json", MockSpecSchema);
const answer = (spec: MockSpec) => ({ files: [{ path: "server.mjs", content: fakeServerSource(spec) }], notes: [] });
const fixture = async () => JSON.parse(await readFile(path.join(out, "fixtures/getPet/200.json"), "utf8"));
async function generateFake(): Promise<void> {
  await writeFile(path.join(genDir, "1.json"), JSON.stringify(answer(await specNow())));
  await generate(ws, SYS, { outDir: out, profile: fakeProfile, adapter: adapter() });
}

describe("recordResponses", () => {
  it("LLM 목(fake 프로필): 녹화 바디가 fixture 파일이 되고 LLM은 다시 부르지 않는다", async () => {
    await generateFake();
    const r = await recordResponses(ws, SYS, { profile: fakeProfile });
    expect(r.result.matched).toEqual(["getPet"]);
    expect(r.result.skipped).toEqual([{ featureId: "createPet", reason: "mutating" }]);
    expect(r.result.applied).toMatchObject({ selected: 2, generate: { skipped: false, attempts: 0 } });
    expect(r.notes).toEqual([]);
    expect(await fixture()).toEqual(REAL);
    expect(await calls()).toBe(1);
    expect(r.driftMarkdown).toContain("# petstore 실제 시스템 대조 (");
    expect(r.driftPath).toBe(r.result.driftPath);
  }, 60_000);

  it("TS 템플릿 목도 fixture가 바뀐다", async () => {
    await generate(ws, SYS, { outDir: out });
    const r = await recordResponses(ws, SYS);
    expect(r.result.applied?.generate?.language).toBe("ts");
    expect(await fixture()).toEqual(REAL);
  }, 60_000);

  it("사용자가 고친 fixture는 보존하고 메모로 알린다", async () => {
    await generateFake();
    await writeFile(path.join(out, "fixtures/getPet/200.json"), JSON.stringify({ mine: true }));
    const r = await recordResponses(ws, SYS, { profile: fakeProfile });
    expect(await fixture()).toEqual({ mine: true });
    expect(r.notes).toEqual(["fixtures/getPet/200.json: 보존됨 — 녹화가 반영되지 않음"]);
  }, 60_000);

  it("generate.json이 없으면 select만 하고 generate는 안내만 한다", async () => {
    const r = await recordResponses(ws, SYS);
    expect(r.result.applied).toEqual({ selected: 2, generate: null });
    expect(r.notes).toEqual(["generate를 실행하면 반영됩니다"]);
    expect((await specNow()).features.find((f) => f.id === "getPet")!.fixtures[0]).toEqual({ status: 200, body: REAL, source: "recorded" });
  });

  it("옛 LLM lock(inputHash 없음)은 generate를 건너뛴다", async () => {
    await generateFake();
    const { inputHash: _drop, ...old } = (await readLock(out))!;
    await writeFile(path.join(out, "specmock.lock.json"), JSON.stringify(LockSchema.parse(old), null, 2));
    const before = await fixture();
    const r = await recordResponses(ws, SYS, { profile: fakeProfile });
    expect(r.result.applied).toEqual({ selected: 2, generate: null });
    expect(r.notes).toEqual(["generate를 실행하면 반영됩니다(LLM 재생성 필요)"]);
    expect(await fixture()).toEqual(before);
    expect(await calls()).toBe(1);
  }, 60_000);

  it("apply: false면 select도 하지 않는다", async () => {
    const before = await specNow();
    const r = await recordResponses(ws, SYS, { apply: false });
    expect(r.result.applied).toBeNull();
    expect(r.notes).toEqual([]);
    expect(await specNow()).toEqual(before);
  });

  it("literal로 고른 id(`all` 등)는 apply에서도 그 기능 하나만 유지한다", async () => {
    const cat = await ws.read(SYS, "catalog.json", CatalogSchema);
    const get = cat.features.find((f) => f.id === "getPet")!;
    await ws.write(SYS, "catalog.json", CatalogSchema, { ...cat, features: cat.features.map((f) => (f.id === "getPet" ? { ...get, id: "all" } : f)) });
    await select(ws, SYS, ["all"], { literalIds: true });
    const r = await recordResponses(ws, SYS, { features: ["all"] });
    expect(r.result.applied).toMatchObject({ selected: 1 });
    expect((await specNow()).features.map((f) => f.id)).toEqual(["all"]);
    expect((await ws.read(SYS, "selection.json", SelectionSchema)).resolved).toEqual(["all"]);
  });

  it("반영 중 select가 던지면 결과를 돌려주고 notes에 반영 실패를 싣는다", async () => {
    const sel = await ws.read(SYS, "selection.json", SelectionSchema);
    await ws.write(SYS, "selection.json", SelectionSchema, { ...sel, selected: ["getPet", "gonePet"] });
    const r = await recordResponses(ws, SYS);
    expect(r.result.applied).toBeNull();
    expect(r.result.matched).toEqual(["getPet"]);
    expect(r.notes).toEqual([expect.stringMatching(/^반영 실패: .*알 수 없는 기능 id|^반영 실패: .*gonePet/)]);
    expect(await ws.exists(SYS, "drift.md")).toBe(true);
  });

  it("표현식 `all` 선택은 카탈로그에 id `all`이 있어도 apply 뒤 전체 선택을 유지한다(literal: false 저장)", async () => {
    const cat = await ws.read(SYS, "catalog.json", CatalogSchema);
    const get = cat.features.find((f) => f.id === "getPet")!;
    await ws.write(SYS, "catalog.json", CatalogSchema, { ...cat, features: cat.features.map((f) => (f.id === "getPet" ? { ...get, id: "all" } : f)) });
    await select(ws, SYS, ["all"]);
    const before = await ws.read(SYS, "selection.json", SelectionSchema);
    expect(before.literal).toBe(false);
    expect(before.resolved.length).toBe(cat.features.length);
    await recordResponses(ws, SYS, { features: ["all"] });
    const after = await ws.read(SYS, "selection.json", SelectionSchema);
    expect(after.resolved).toEqual(before.resolved);
    expect(after.literal).toBe(false);
  });

  it("literalIds로 저장하면 literal: true, literal이 없는 옛 파일은 추정한다", async () => {
    await select(ws, SYS, ["getPet"], { literalIds: true });
    const sel = await ws.read(SYS, "selection.json", SelectionSchema);
    expect(sel.literal).toBe(true);
    const { literal: _l, ...old } = sel;
    await ws.write(SYS, "selection.json", SelectionSchema, old);
    await recordResponses(ws, SYS);
    expect((await ws.read(SYS, "selection.json", SelectionSchema)).resolved).toEqual(["getPet"]);
  });

  it("프로그래밍 오류(TypeError)는 삼키지 않고 다시 던진다", async () => {
    await generateFake();
    const onEvent = (e: { message: string }) => { if (e.message.startsWith("generate")) (null as unknown as { x: number }).x; };
    await expect(recordResponses(ws, SYS, { profile: fakeProfile, onEvent })).rejects.toBeInstanceOf(TypeError);
  });

  it("잠금 밖 검사 뒤 mockspec이 바뀌어 generate가 LLM 경로로 가도 어댑터는 부르지 않고 안내만 한다", async () => {
    await generateFake();
    const file = ws.file(SYS, "mockspec.json");
    const onEvent = (e: { message: string }) => {
      if (!e.message.startsWith("generate")) return;
      const j = JSON.parse(readFileSync(file, "utf8"));
      j.baseUrl = "http://changed.example";
      writeFileSync(file, JSON.stringify(j));
    };
    const r = await recordResponses(ws, SYS, { profile: fakeProfile, onEvent });
    expect(r.result.applied).toEqual({ selected: 2, generate: null });
    expect(r.notes).toEqual(["generate를 실행하면 반영됩니다(LLM 재생성 필요)"]);
    expect(await calls()).toBe(1);
  }, 60_000);

  it("forbiddenLlmAdapter는 호출되면 안내와 함께 던진다", async () => {
    await expect(forbiddenLlmAdapter().complete({ prompt: "x", schema: {} })).rejects.toBeInstanceOf(LlmForbiddenError);
    await expect(forbiddenLlmAdapter().complete({ prompt: "x", schema: {} })).rejects.toThrow("specmock generate <system>");
  });

  it("select 뒤 generate가 실패하면 mock은 아직이라고 안내한다", async () => {
    await generateFake();
    // fixtures 자리에 파일을 두어 generate의 쓰기를 실패시킨다.
    await rm(path.join(out, "fixtures"), { recursive: true, force: true });
    await writeFile(path.join(out, "fixtures"), "x");
    const r = await recordResponses(ws, SYS, { profile: fakeProfile });
    expect(r.result.applied).toBeNull();
    expect(r.notes).toEqual([expect.stringMatching(/^반영 실패: .*mockspec은 갱신됐고 mock은 아직/)]);
  });
});
