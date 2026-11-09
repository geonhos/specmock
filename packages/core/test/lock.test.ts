// packages/core/test/lock.test.ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { NPM_INSTALL, launchCommand, launchHint, readLock, resolveInstall } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { registerLanguageForTest } from "../src/generate/profiles/index.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let ws: Workspace;
let out: string;
let unregister: () => void;
beforeEach(async () => {
  unregister = registerLanguageForTest({ language: "java", artifacts: ["target"], installCheck: "target/mock.jar", profile: null });
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-lock-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  out = path.join(dir, "mock", "petstore");
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet"]);
});
afterEach(async () => { unregister(); await rm(dir, { recursive: true, force: true }); });

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
    expect(lock).toMatchObject({ language: "ts", generator: "template", install: NPM_INSTALL, installCheck: "node_modules" });
    expect(Object.keys(lock!.sourceFiles)).toContain("src/server.ts");
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
    expect((await generate(ws, "petstore", { outDir: out })).language).toBe("ts");   // lock ts + --lang 없음
  });

  it("lock의 language가 등록표에 없으면 거부하고 파일을 바꾸지 않는다", async () => {
    await generate(ws, "petstore", { outDir: out });
    const lockPath = path.join(out, "specmock.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, language: "cobol" }));
    const before = await readFile(path.join(out, "src", "server.ts"), "utf8");
    await writeFile(path.join(out, "src", "server.ts"), "// edited");
    await expect(generate(ws, "petstore", { outDir: out, force: true })).rejects.toThrow("이 디렉터리는 'cobol' 언어로 생성됐지만 지원하지 않습니다. 지원 언어: ts");
    expect(await readFile(path.join(out, "src", "server.ts"), "utf8")).toBe("// edited");
    expect(before).not.toBe("// edited");
  });

  describe("force 언어 변경", () => {
    const exists = (rel: string) => stat(path.join(out, rel)).then(() => true, () => false);
    /** 생성 뒤 lock을 다른 언어(java)의 것으로 바꿔 둔다. sourceFiles에는 이전 언어 소스 하나를 더한다. */
    async function asJava() {
      await generate(ws, "petstore", { outDir: out });
      const lockPath = path.join(out, "specmock.lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, JSON.stringify({ ...lock, language: "java", sourceFiles: { ...lock.sourceFiles, "old/Legacy.java": "h" } }));
      await mkdir(path.join(out, "old"));
      await writeFile(path.join(out, "old", "Legacy.java"), "class A {}");
    }

    it("sourceFiles·이전 언어 산출물·마커만 지우고 나머지는 둔다", async () => {
      await asJava();
      await writeFile(path.join(out, "stray.txt"), "x");
      await mkdir(path.join(out, "target"));
      await mkdir(path.join(out, "node_modules"));
      await writeFile(path.join(out, ".specmock-installed"), "k");
      unregister();
      unregister = registerLanguageForTest({ language: "java", artifacts: ["target", "node_modules"], installCheck: null, profile: null });
      await generate(ws, "petstore", { outDir: out, language: "ts", force: true });
      expect(await readFile(path.join(out, "stray.txt"), "utf8")).toBe("x");
      expect(await exists("old")).toBe(false);   // 소스 삭제 뒤 비게 된 디렉터리까지
      expect(await exists("target")).toBe(false);
      expect(await exists("node_modules")).toBe(false);
      expect(await exists(".specmock-installed")).toBe(false);
      expect(await exists("src/server.ts")).toBe(true);   // ts로 다시 생성됨
      expect((await readLock(out))!.language).toBe("ts");
    });

    it(".git이나 .specmock이 있으면 거부하고 아무것도 지우지 않는다", async () => {
      for (const marker of [".git", ".specmock"]) {
        await rm(out, { recursive: true, force: true });
        await asJava();
        await mkdir(path.join(out, marker));
        await expect(generate(ws, "petstore", { outDir: out, language: "ts", force: true })).rejects.toThrow(`${out}에 .git 또는 .specmock이 있어 언어를 바꿀 수 없습니다. --out으로 다른 디렉터리를 지정하세요`);
        expect(await exists("old/Legacy.java")).toBe(true);
      }
    });

    it("옛 ts lock(sourceFiles 없음)에서 다른 언어로 바꾸면 ts 산출물을 지우고 사용자 파일은 둔다", async () => {
      await generate(ws, "petstore", { outDir: out });
      const lockPath = path.join(out, "specmock.lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, JSON.stringify({ ...lock, sourceFiles: {} }));
      await mkdir(path.join(out, "node_modules"));
      await writeFile(path.join(out, "package-lock.json"), "{}");
      await writeFile(path.join(out, "stray.txt"), "x");
      await generate(ws, "petstore", { outDir: out, language: "java", force: true });   // java 생성기는 아직 없어 ts 파일이 다시 쓰인다
      expect(await exists("node_modules")).toBe(false);
      expect(await exists("package-lock.json")).toBe(false);
      expect(await readFile(path.join(out, "stray.txt"), "utf8")).toBe("x");
    });
  });
});

describe("mockspec.language 제거", () => {
  it("select가 language를 쓰지 않고, 옛 mockspec의 language는 버려진다", async () => {
    const raw = JSON.parse(await readFile(path.join(dir, ".specmock", "petstore", "mockspec.json"), "utf8"));
    expect(raw).not.toHaveProperty("language");
    expect(MockSpecSchema.parse({ ...raw, language: "ts" })).not.toHaveProperty("language");
  });
});

describe("실행 안내", () => {
  const base = { system: "s", generator: "template" as const, mockspecHash: "h", generatedAt: "t", healthPath: "/h", fixtureHashes: {}, sourceFiles: {} };
  it("ts는 package.json 스크립트 문구를 쓴다", () => {
    const lock = { ...base, language: "ts", install: NPM_INSTALL, start: { command: "npx", args: ["tsx", "src/server.ts"] } };
    expect(launchCommand(lock)).toBe("npm install && npm start");
    expect(launchHint("/r/mock/s", lock)).toBe("cd /r/mock/s && npm install && npm start");
  });
  it("그 밖의 언어는 install·start argv를 잇는다", () => {
    const lock = { ...base, language: "java", install: { command: "./mvnw", args: ["-q", "-DskipTests", "package"] }, start: { command: "java", args: ["-jar", "target/mock.jar"] } };
    expect(launchHint("mock/petstore", lock)).toBe("cd mock/petstore && ./mvnw -q -DskipTests package && java -jar target/mock.jar");
  });
  it("install이 null이면 start만", () => {
    expect(launchCommand({ ...base, language: "fake", install: null, start: { command: "node", args: ["server.mjs"] } })).toBe("node server.mjs");
  });
  it("generate 결과의 launch는 lock에서 조합한다", async () => {
    const r = await generate(ws, "petstore", { outDir: out });
    expect(r.launch).toBe(`cd ${out} && npm install && npm start`);
  });
});
