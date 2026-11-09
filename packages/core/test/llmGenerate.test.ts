// packages/core/test/llmGenerate.test.ts
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { EnvironmentError, GenerationFailedError } from "../src/generate/errors.js";
import { ATTEMPT_DIR, LlmGenerator } from "../src/generate/llm.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");

let dir: string;
let genDir: string;
let out: string;
let spec: MockSpec;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-llmgen-"));
  genDir = path.join(dir, "gen");
  out = path.join(dir, "mock");
  await mkdir(genDir);
  const ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
  spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const adapter = () => new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
const respond = (n: number, body: unknown) => writeFile(path.join(genDir, `${n}.json`), JSON.stringify(body));
const good = () => ({ files: [{ path: "server.mjs", content: fakeServerSource(spec) }], notes: ["가정: 페이지네이션 없음"] });
const calls = async () => Number(await readFile(path.join(genDir, "count"), "utf8"));

describe("LlmGenerator", () => {
  it("첫 시도에 통과하면 모델 파일과 notes·attempts를 돌려준다", async () => {
    await respond(1, good());
    const progress: string[] = [];
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing: null, onProgress: (e) => progress.push(`${e.stage} ${e.attempt}/${e.maxAttempts}`) });
    expect(r.attempts).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(["server.mjs"]);
    expect(r.notes).toEqual(["가정: 페이지네이션 없음"]);
    expect(r).toMatchObject({ install: null, start: { command: "node", args: ["server.mjs"] }, healthPath: "/__specmock/health" });
    expect(progress).toEqual(["generating 1/3", "building 1/3", "verifying 1/3"]);
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });   // outDir에는 아무것도 쓰지 않는다
  }, 30_000);

  it("계약 7 실패면 오류 요약을 붙여 다시 시도한다", async () => {
    await respond(1, { files: [{ path: "server.mjs", content: fakeServerSource(spec, { omit501: true }) }], notes: [] });
    await respond(2, good());
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing: null });
    expect(r.attempts).toBe(2);
    const prompt2 = await readFile(path.join(genDir, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("## 이전 시도 결과 (1번째)");
    expect(prompt2).toContain("실패 단계: contract");
    expect(prompt2).toContain("선택 안 된 기능 → 501");
  }, 30_000);

  it("응답 경로가 거부되면 응답 검증 단계로 다시 시도한다", async () => {
    await respond(1, { files: [{ path: "../evil.mjs", content: "x" }], notes: [] });
    await respond(2, good());
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing: null });
    expect(r.attempts).toBe(2);
    const prompt2 = await readFile(path.join(genDir, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("실패 단계: 응답 검증");
    expect(prompt2).toContain("경로가 outDir을 벗어납니다: ../evil.mjs");
  }, 30_000);

  it("maxAttempts를 다 쓰면 exit 5 오류와 .specmock-attempt/를 남긴다", async () => {
    const bad = { files: [{ path: "server.mjs", content: fakeServerSource(spec, { omit501: true }) }], notes: [] };
    await respond(1, bad);
    await respond(2, bad);
    const p = new LlmGenerator(fakeProfile, adapter(), { maxAttempts: 2 }).generate({ spec, outDir: out, existing: null });
    await expect(p).rejects.toBeInstanceOf(GenerationFailedError);
    await expect(p).rejects.toMatchObject({ exitCode: 5, attempts: 2, attemptDir: path.join(out, ATTEMPT_DIR) });
    expect(await readFile(path.join(out, ATTEMPT_DIR, "server.mjs"), "utf8")).toContain("createServer");
    expect(await readFile(path.join(out, ATTEMPT_DIR, "errors.md"), "utf8")).toContain("실패 단계: contract");
    expect(await calls()).toBe(2);
  }, 30_000);

  it("환경 오류(start 명령을 실행할 수 없음)는 재시도하지 않는다", async () => {
    await respond(1, good());
    await respond(2, good());
    const profile = { ...fakeProfile, start: { command: "no-such-cmd-xyz", args: [] } };
    const p = new LlmGenerator(profile, adapter()).generate({ spec, outDir: out, existing: null });
    await expect(p).rejects.toBeInstanceOf(EnvironmentError);
    await expect(p).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/^Node 22가 필요합니다: /) });
    expect(await calls()).toBe(1);
  }, 30_000);

  it("빌드 로그가 프로필의 환경 오류 패턴에 맞으면 재시도하지 않는다", async () => {
    await respond(1, good());
    const install = { command: process.execPath, args: ["-e", "console.error('Error: JAVA_HOME is not defined correctly'); process.exit(1)"] };
    const profile = { ...fakeProfile, install: () => install, environmentErrors: [/JAVA_HOME/] };
    await expect(new LlmGenerator(profile, adapter()).generate({ spec, outDir: out, existing: null })).rejects.toBeInstanceOf(EnvironmentError);
    expect(await calls()).toBe(1);
  }, 30_000);

  describe("환경 오류 패턴은 install 단계 출력에만 적용된다", () => {
    const installFailing = (log: string) => ({ command: process.execPath, args: ["-e", `console.error(${JSON.stringify(log)}); process.exit(1)`] });

    it("install 로그에 UnknownHostException과 COMPILATION ERROR가 함께 있으면 환경 오류가 아니라 재시도한다", async () => {
      await respond(1, good());
      await respond(2, good());
      const profile = { ...fakeProfile, install: () => installFailing("[ERROR] COMPILATION ERROR : java.net.UnknownHostException"), environmentErrors: [/UnknownHostException/] };
      await expect(new LlmGenerator(profile, adapter(), { maxAttempts: 2 }).generate({ spec, outDir: out, existing: null })).rejects.toBeInstanceOf(GenerationFailedError);
      expect(await calls()).toBe(2);
    }, 30_000);

    it("Could not transfer artifact만 있으면 EnvironmentError", async () => {
      await respond(1, good());
      const profile = { ...fakeProfile, install: () => installFailing("Could not transfer artifact io.javalin:javalin:pom:6.7.0"), environmentErrors: [/Could not transfer artifact/] };
      await expect(new LlmGenerator(profile, adapter()).generate({ spec, outDir: out, existing: null })).rejects.toBeInstanceOf(EnvironmentError);
      expect(await calls()).toBe(1);
    }, 30_000);

    it("기동 로그의 UnknownHostException은 환경 오류가 아니라 재시도 대상", async () => {
      await respond(1, good());
      await respond(2, good());
      const profile = {
        ...fakeProfile,
        start: { command: process.execPath, args: ["-e", "console.error('java.net.UnknownHostException: foo'); process.exit(1)"] },
        environmentErrors: [/UnknownHostException/],
      };
      await expect(new LlmGenerator(profile, adapter(), { maxAttempts: 2 }).generate({ spec, outDir: out, existing: null })).rejects.toBeInstanceOf(GenerationFailedError);
      expect(await calls()).toBe(2);
    }, 60_000);
  });

  it("증분: 응답에 없는 기존 파일은 유지하고 notes에 적는다", async () => {
    await respond(1, good());
    const existing = { files: [{ path: "lib/util.mjs", content: "export const x = 1;\n", userModified: false }] };
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing });
    expect(r.files.map((f) => f.path).sort()).toEqual(["lib/util.mjs", "server.mjs"]);
    expect(r.notes).toContain("응답에 없어 유지: lib/util.mjs");
    expect(await readFile(path.join(genDir, "prompt-1.txt"), "utf8")).toContain("## 7. 증분 생성");
  }, 30_000);

  it("writeLanguageFiles는 mode가 있는 파일에 실행 권한을 준다", async () => {
    const { writeLanguageFiles } = await import("../src/generate/scaffold.js");
    const { stat } = await import("node:fs/promises");
    await writeLanguageFiles(dir, { files: [{ path: "mvnw", content: "#!/bin/sh\n", mode: 0o755 }, { path: "plain.txt", content: "x" }], install: null, start: { command: "x", args: [] }, healthPath: "/", notes: [] }, []);
    expect((await stat(path.join(dir, "mvnw"))).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(dir, "plain.txt"))).mode & 0o111).toBe(0);
  });
});
