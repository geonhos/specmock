import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { renderTsHonoFiles } from "../src/generate/tsHono.js";
import type { MockSpec } from "../src/types.js";
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
    expect(v.result).toMatchObject({ total: 4, failed: 0, runtimeFailed: 0 });
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

const JACKSON = ["jackson-databind", "jackson-core", "jackson-annotations"];
const M2_JACKSON = path.join(os.homedir(), ".m2", "repository", "com", "fasterxml", "jackson", "core");

/** 로컬 Maven 저장소에서 찾고, 없으면 fixture 프로젝트의 classpath를 mvn으로 뽑는다. */
async function jacksonClasspath(): Promise<string> {
  const jars = JACKSON.map((a) => path.join(M2_JACKSON, a, "2.19.4", `${a}-2.19.4.jar`));
  const found = await Promise.all(jars.map((j) => access(j).then(() => true, () => false)));
  if (found.every(Boolean)) return jars.join(path.delimiter);
  const outFile = path.join(await mkdtemp(path.join(os.tmpdir(), "specmock-cp-")), "cp.txt");
  await promisify(execFile)("mvn", ["-q", "-f", path.join(FIXTURE, "pom.xml"), "dependency:build-classpath", `-Dmdep.outputFile=${outFile}`]);
  return (await readFile(outFile, "utf8")).trim();
}

const FORM_INPUTS = [
  "a[b][c]=1", "a[]=1&a[]=2", "a[1]=b&a[0]=a", "a[0][b]=1&a[0][c]=2", "a[][b]=1&a[][c]=2",
  "tag=a&tag=b&tag=c", "a=1&a[b]=2", "a[0]=x&a[b]=y", "a[1000]=x", "a[1001]=x",
  "a[4294967294]=x", "a[2000000000]=x", "__proto__[x]=1", "a[constructor][x]=1", "a[prototype]=1&b=2",
  "a" + "[b]".repeat(31) + "=1", "a" + "[b]".repeat(32) + "=1",
  "name=Jenny+Rosen&memo=%ED%95%9C%EA%B8%80", "", "a", "a=", "5[0]=x", "items[5]=x",
  "line_items[0][price]=p&line_items[0][quantity]=2",
];

describe.skipIf(!javaVersion)("FormBody.java ↔ TS parseForm 동등성 (JDK 필요)", () => {
  let dir: string;
  let classes: string;
  let cp: string;
  let parseForm: (text: string) => Record<string, unknown>;

  const run = async (mode: string[], lines: string[]): Promise<{ json: string; ms: number }[]> => {
    const child = execFile("java", ["-cp", `${classes}${path.delimiter}${cp}`, "Probe", ...mode], { maxBuffer: 64 * 1024 * 1024 });
    const done = new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => { buf += d; });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error(`Probe exit ${code}`))));
    });
    child.stdin!.end(lines.join("\n") + "\n");
    const out = (await done).split("\n").slice(0, lines.length);
    return out.map((l) => { const i = l.lastIndexOf("\t"); return { json: l.slice(0, i), ms: Number(l.slice(i + 1)) }; });
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "specmock-formbody-"));
    cp = await jacksonClasspath();
    classes = path.join(dir, "classes");
    await mkdir(classes);
    await promisify(execFile)("javac", [
      "-cp", cp, "-d", classes,
      path.join(here, "..", "templates", "java", "src", "main", "java", "specmock", "runtime", "FormBody.java"),
      path.join(here, "fixtures", "formbody-probe", "Probe.java"),
    ]);
    const spec = { system: "t", features: [], notMocked: [] } as unknown as MockSpec;
    const file = renderTsHonoFiles(spec).find((f) => f.path === "src/form.ts")!;
    const js = ts.transpileModule(file.content, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    await writeFile(path.join(dir, "form.mjs"), js);
    ({ parseForm } = await import(pathToFileURL(path.join(dir, "form.mjs")).href));
  }, 300_000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("parse: 같은 입력에서 TS parseForm과 JSON 문자열이 같다", async () => {
    const java = await run([], FORM_INPUTS);
    const diffs = FORM_INPUTS.map((input, i) => ({ input, ts: JSON.stringify(parseForm(input)), java: java[i]!.json })).filter((r) => r.ts !== r.java);
    expect(diffs).toEqual([]);
    // 큰 인덱스는 배열을 만들지 않고 바로 버려야 한다.
    for (const input of ["a[4294967294]=x", "a[2000000000]=x"]) expect(java[FORM_INPUTS.indexOf(input)]!.ms).toBeLessThan(1000);
  }, 120_000);

  it("coerce: 스키마 타입에 맞춰 바꾸되 못 바꾸면 문자열을 유지한다", async () => {
    const T = (type: unknown) => JSON.stringify({ type: "object", properties: { v: { type } } });
    const rows: [string, string, unknown][] = [
      [T("integer"), "v=1", { v: 1 }],
      [T("integer"), "v=abc", { v: "abc" }],
      [T("boolean"), "v=true", { v: true }],
      [T("boolean"), "v=yes", { v: "yes" }],
      [T("number"), "v=1.5", { v: 1.5 }],
      [JSON.stringify({ type: "object", properties: { a: { type: "object", properties: { b: { type: "integer" } } } } }), "a[b]=1", { a: { b: 1 } }],
      [JSON.stringify({ type: "object", properties: { a: { type: "array", items: { type: "integer" } } } }), "a[]=1&a[]=2", { a: [1, 2] }],
      [T(["object", "integer"]), "v=5", { v: 5 }],
      [JSON.stringify({ type: "object", properties: { v: { oneOf: [{ type: "integer" }, { type: "boolean" }] } } }), "v=1", { v: "1" }],
    ];
    const java = await run(["coerce"], rows.map(([schema, form]) => `${schema}\t${form}`));
    expect(java.map((r) => JSON.parse(r.json))).toEqual(rows.map((r) => r[2]));
  }, 120_000);
});
