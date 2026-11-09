import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { readLock } from "../src/generate/lock.js";
import { startMock } from "../src/verify/server.js";
import { verifyMock } from "../src/service/verify.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const FIXTURE = path.join(here, "fixtures", "java-petstore");
const MAIN = "src/main/java/specmock/petstore/Main.java";

const javaVersion = await promisify(execFile)("java", ["-version"]).then((r) => r.stderr.split("\n")[0]!.trim(), () => null);
if (!javaVersion) console.warn("[java.test] skip: `java -version` 실패 — JDK 17 이상이 PATH에 없습니다.");
else console.info(`[java.test] ${javaVersion}`);

describe.skipIf(!javaVersion)("Java 생성 (JDK·네트워크 필요)", () => {
  let dir: string;
  let genDir: string;
  let out: string;
  let ws: Workspace;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "specmock-java-"));
    genDir = path.join(dir, "gen");
    out = path.join(dir, "mock", "petstore");
    await mkdir(genDir);
    ws = new Workspace(path.join(dir, ".specmock"));
    await ingest(ws, "petstore", [PETSTORE]);
    await analyze(ws, "petstore");
    await select(ws, "petstore", ["getPet", "createPet"]);
    const files = [
      { path: "pom.xml", content: await readFile(path.join(FIXTURE, "pom.xml"), "utf8") },
      { path: MAIN, content: await readFile(path.join(FIXTURE, MAIN), "utf8") },
    ];
    await writeFile(path.join(genDir, "1.json"), JSON.stringify({ files, notes: ["참조 mock"] }));
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("참조 소스로 generate(java)가 한 번에 통과하고 verify도 통과한다", async () => {
    const progress: string[] = [];
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
    const r = await generate(ws, "petstore", {
      outDir: out, language: "java", adapter,
      onProgress: (e) => progress.push(`${e.stage} ${e.attempt}/${e.maxAttempts}`),
    });
    expect(r).toMatchObject({ language: "java", attempts: 1, skipped: false, notes: ["참조 mock"] });
    expect(r.launch).toBe(`cd ${out} && ./mvnw -q -DskipTests package && java -jar target/mock.jar`);
    expect(progress).toEqual(["generating 1/3", "building 1/3", "verifying 1/3"]);
    for (const f of ["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties", "pom.xml", MAIN, "fixtures/getPet/200.json", "specmock.lock.json"]) {
      await access(path.join(out, f));
    }

    const v = await verifyMock(ws, "petstore");
    expect(v.result).toMatchObject({ total: 3, failed: 0, runtimeFailed: 0 });
    expect(v.result.runtime.map((c) => [c.id, c.passed, c.skipped])).toEqual([["not_mocked", true, false], ["unknown_path", true, false]]);
  }, 900_000);

  it("mockspec이 같으면 다시 부르지 않고 건너뛴다", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
    const r = await generate(ws, "petstore", { outDir: out, language: "java", adapter });
    expect(r).toMatchObject({ skipped: true, attempts: 0 });
    expect(await readFile(path.join(genDir, "count"), "utf8")).toBe("1");
  }, 900_000);

  it("정수 path 파라미터는 숫자로 바꿔 검증하고, 바꿀 수 없으면 400 validation_failed", async () => {
    // 선택한 기능(getPet, createPet)에 integer query가 없어 정수 path 파라미터(/pets/{petId})로 확인한다.
    const lock = (await readLock(out))!;
    const mock = await startMock(out, lock);
    try {
      const ok = await fetch(`http://127.0.0.1:${mock.port}/pets/1`, { headers: { "X-API-Key": "k" } });
      expect(ok.status).toBe(200);
      const bad = await fetch(`http://127.0.0.1:${mock.port}/pets/abc`, { headers: { "X-API-Key": "k" } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("validation_failed");
    } finally {
      await mock.stop();
    }
  }, 300_000);
});
