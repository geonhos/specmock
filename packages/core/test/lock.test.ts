// packages/core/test/lock.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { NPM_INSTALL, readLock, resolveInstall } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let ws: Workspace;
let out: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-lock-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  out = path.join(dir, "mock", "petstore");
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const OLD_LOCK = {
  system: "petstore", language: "ts", mockspecHash: "x", generatedAt: "2026-11-01T00:00:00.000Z",
  start: { command: "npx", args: ["tsx", "src/server.ts"] }, healthPath: "/__specmock/health", fixtureHashes: {},
};

describe("lock 호환", () => {
  it("2단계 lock(install·generator·sourceFiles 없음)을 읽고 install을 npm install로 해석한다", async () => {
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "specmock.lock.json"), JSON.stringify(OLD_LOCK));
    const lock = await readLock(out);
    expect(lock).toMatchObject({ generator: "template", sourceFiles: {} });
    expect(lock!.install).toBeUndefined();
    expect(resolveInstall(lock!)).toEqual(NPM_INSTALL);
    expect(resolveInstall({ ...lock!, install: null })).toBeNull();
  });

  it("새 TS lock은 install을 명시하고 generator template을 기록한다", async () => {
    await generate(ws, "petstore", { outDir: out });
    const lock = await readLock(out);
    expect(lock).toMatchObject({ language: "ts", generator: "template", install: NPM_INSTALL, sourceFiles: {} });
  });
});

describe("언어 결정", () => {
  it("모르는 언어는 지원 언어 목록과 함께 거부하고 아무것도 쓰지 않는다", async () => {
    await expect(generate(ws, "petstore", { outDir: out, language: "cobol" })).rejects.toThrow("'cobol' 언어는 지원하지 않습니다. 지원 언어: ts");
    expect(await readLock(out)).toBeNull();
  });

  it("lock의 언어와 다른 언어를 force 없이 요청하면 거부한다", async () => {
    await generate(ws, "petstore", { outDir: out });
    const lockPath = path.join(out, "specmock.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, language: "java" }));
    await expect(generate(ws, "petstore", { outDir: out, language: "ts" })).rejects.toThrow(
      "이 디렉터리는 java로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요",
    );
  });

  it("언어를 주지 않으면 lock의 언어를 쓴다(없으면 ts)", async () => {
    const r = await generate(ws, "petstore", { outDir: out });
    expect(r.language).toBe("ts");
  });

  it("force로 언어를 바꾸면 fixtures·contracts 밖의 파일을 지운다", async () => {
    await generate(ws, "petstore", { outDir: out });
    await writeFile(path.join(out, "stray.txt"), "x");
    const lockPath = path.join(out, "specmock.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, language: "java" }));
    await generate(ws, "petstore", { outDir: out, language: "ts", force: true });
    await expect(readFile(path.join(out, "stray.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLock(out))!.language).toBe("ts");
  });
});

describe("mockspec.language 제거", () => {
  it("select가 language를 쓰지 않고, 옛 mockspec의 language는 버려진다", async () => {
    const raw = JSON.parse(await readFile(path.join(dir, ".specmock", "petstore", "mockspec.json"), "utf8"));
    expect(raw).not.toHaveProperty("language");
    expect(MockSpecSchema.parse({ ...raw, language: "ts" })).not.toHaveProperty("language");
  });
});
