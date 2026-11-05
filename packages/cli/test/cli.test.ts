import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "src", "cli.ts");
const TSX = path.resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const PETSTORE = path.resolve(here, "..", "..", "core", "test", "fixtures", "petstore.yaml");

let dir: string;
// macOS의 tmpdir는 심볼릭 링크라 자식 프로세스의 process.cwd()가 실제 경로를 돌려준다. 비교를 위해 realpath로 맞춘다.
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-cli-"))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function specmock(...args: string[]) {
  const { stdout, stderr } = await run(TSX, [CLI, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
  return { stdout, stderr };
}

describe("specmock CLI", () => {
  it("ingest → analyze → list → select → generate writes files and prints the table", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    const { stdout: table } = await specmock("list", "petstore");
    expect(table).toContain("petstore — 5개 기능");
    expect(table).toMatch(/getPet\s+GET\s+\/pets\/\{petId\}/);

    const { stdout: json } = await specmock("list", "petstore", "--json");
    expect(JSON.parse(json).features).toHaveLength(5);

    const { stdout: sel } = await specmock("select", "petstore", "getPet,createPet");
    expect(sel).toContain("선택 2개");

    const { stdout: gen } = await specmock("generate", "petstore");
    expect(gen).toContain(path.join(dir, "mock", "petstore"));
    const lock = JSON.parse(await readFile(path.join(dir, "mock", "petstore", "specmock.lock.json"), "utf8"));
    expect(lock.system).toBe("petstore");
  });

  it("list --group keeps the global numbering used by select", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    const { stdout } = await specmock("list", "petstore", "--group", "store");
    expect(stdout).toContain("petstore — 그룹 store: 1개 기능 (전체 5개)");
    expect(stdout).toMatch(/5\s+inventory\.list/);
    expect(stdout).not.toContain("listPets");

    const { stdout: json } = await specmock("list", "petstore", "--group", "store", "--json");
    const parsed = JSON.parse(json);
    expect(parsed.group).toBe("store");
    expect(parsed.order).toEqual([{ index: 5, id: "inventory.list" }]);
    expect(parsed.features).toHaveLength(5);
  });

  it("select accepts a -id exclusion as its own argument", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    const { stdout } = await specmock("select", "petstore", "all", "-listPets");
    expect(stdout).toContain("선택 4개");
    expect(stdout).not.toContain("listPets");
  });

  it("show prints a single feature", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    const { stdout } = await specmock("show", "petstore", "getPet");
    expect(stdout).toContain("GET /pets/{petId}");
    expect(stdout).toContain('"Rex"');
  });

  it("run does everything in one go for OpenAPI (verify skipped)", async () => {
    const { stdout } = await specmock("run", "petstore", PETSTORE, "--select", "all", "--no-verify");
    expect(stdout).toContain("5개 기능");
    expect(stdout).toContain("mock/petstore");
  });

  it("fails fast on an unknown feature id", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await expect(specmock("select", "petstore", "nope")).rejects.toMatchObject({ code: 1 });
  });
});

const PETS_MD = path.resolve(here, "..", "..", "core", "test", "fixtures", "docs", "pets.md");
const EXTRACTED = path.resolve(here, "..", "..", "core", "test", "fixtures", "docs", "extracted");
const FAKE_BIN = path.resolve(here, "..", "..", "core", "test", "bin");

describe("Phase 1B CLI", () => {
  it("ingest --json reports inputs and the cache", async () => {
    const { stdout } = await specmock("ingest", "pets", PETS_MD, "--json");
    const j = JSON.parse(stdout);
    expect(j.inputs[0]).toMatchObject({ kind: "markdown", cached: false });
    const again = JSON.parse((await specmock("ingest", "pets", PETS_MD, "--json")).stdout);
    expect(again.inputs[0].cached).toBe(true);
  });

  it("analyze on a document prepares chunks and tells the session what to do", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const { stdout } = await specmock("analyze", "pets");
    expect(stdout).toContain("analyze-request.json");
    expect(stdout).toContain("chunks/000.md");
    expect(stdout).toContain("specmock analyze pets --merge");
    const { stdout: json } = await specmock("analyze", "pets", "--json");
    expect(JSON.parse(json)).toMatchObject({ mode: "prepared", chunks: expect.any(Number) });
  });

  it("analyze --merge builds the catalog from extracted files and prints the table with doc badges", async () => {
    await specmock("ingest", "pets", PETS_MD);
    await specmock("analyze", "pets", "--prepare");
    await cp(EXTRACTED, path.join(dir, ".specmock", "pets", "extracted"), { recursive: true });
    const { stdout } = await specmock("analyze", "pets", "--merge");
    expect(stdout).toContain("pets — 5개 기능 (openapi 0 · 문서추출 4 · 추론 1)");
    expect(stdout).toMatch(/pets\.get\s+GET\s+\/pets\/\{petId\}\s+doc\s+1\.0\s+●/);
    expect(stdout).toContain("거절 1건");
  });

  it("analyze --merge without a prepared request fails with a hint", async () => {
    await specmock("ingest", "pets", PETS_MD);
    await expect(specmock("analyze", "pets", "--merge")).rejects.toMatchObject({ stderr: expect.stringContaining("specmock analyze") });
  });

  it("analyze --llm claude-code runs extract with the configured command", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const { stdout, stderr } = await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code"], { cwd: dir, env: { ...process.env, NO_COLOR: "1", PATH: `${FAKE_BIN}:${process.env.PATH}` } });
    expect(stderr).toMatch(/추출 1\/1/);
    expect(stdout).toContain("1개 기능");
  });

  it("analyze prints a diff against the previous catalog and select warns with counts", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "all");
    // 스펙이 바뀐 상황을 흉내 낸다: 기능 하나를 뺀 사본으로 다시 ingest
    const yaml = await readFile(PETSTORE, "utf8");
    const smaller = path.join(dir, "small.yaml");
    await writeFile(smaller, yaml.replace(/\n  \/store\/inventory:[\s\S]*$/, "\n"));
    await specmock("ingest", "petstore", smaller, "--refresh");
    const { stdout } = await specmock("analyze", "petstore");
    expect(stdout).toContain("이전 카탈로그 대비: 추가 0 · 삭제 1 (inventory.list) · 변경 0");
    const { stdout: sel } = await specmock("select", "petstore", "getPet");
    expect(sel).toContain("삭제 1");
  });

  it("run --json emits one JSON document", async () => {
    const { stdout } = await specmock("run", "petstore", PETSTORE, "--select", "getPet", "--no-verify", "--json");
    const j = JSON.parse(stdout);
    expect(j).toMatchObject({ system: "petstore", selected: ["getPet"], generate: { outDir: expect.any(String) }, verify: null, coverage: null });
  });

  // test/bin의 가짜 claude 스크립트 중 하나를 `claude`라는 이름으로 PATH 맨 앞에 둔다.
  const withClaude = async (script: string) => {
    const bin = path.join(dir, "fakebin");
    await mkdir(bin, { recursive: true });
    await symlink(path.join(FAKE_BIN, script), path.join(bin, "claude"));
    return { cwd: dir, env: { ...process.env, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` } };
  };

  it("select reports the diff against the catalog the selection was made from", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "getPet");
    const yaml = await readFile(PETSTORE, "utf8");
    const smaller = path.join(dir, "small.yaml");
    await writeFile(smaller, yaml.replace(/\n  \/store\/inventory:[\s\S]*$/, "\n"));
    await specmock("ingest", "petstore", smaller, "--refresh");
    await specmock("analyze", "petstore");
    // 다시 inventory를 포함한 스펙 → 두 번 analyze해도 선택 시점(5개) 기준으로 비교한다
    await specmock("ingest", "petstore", PETSTORE, "--refresh");
    await specmock("analyze", "petstore");
    await specmock("analyze", "petstore");
    const noop = await specmock("select", "petstore", "getPet");
    expect(noop.stdout).not.toContain("주의");
    await specmock("ingest", "petstore", smaller, "--refresh");
    await specmock("analyze", "petstore");
    const { stdout } = await specmock("select", "petstore", "getPet");
    expect(stdout).toContain("추가 0 · 삭제 1 (inventory.list)");
    expect(stdout).not.toMatch(/\.\s*\./);
  });

  it("run on a document with the fake claude emits extract and merge in --json", async () => {
    const { stdout } = await run(TSX, [CLI, "run", "pets", PETS_MD, "--llm", "claude-code", "--select", "all", "--no-verify", "--json"], await withClaude("claude"));
    const j = JSON.parse(stdout);
    expect(j.extract).toMatchObject({ total: 1, written: 1 });
    expect(j.merge.features).toBe(1);
    expect(j.catalog.features).toBe(1);
  });

  it("run with a failing claude exits 1 with the all-failed message", async () => {
    await expect(run(TSX, [CLI, "run", "pets", PETS_MD, "--llm", "claude-code", "--no-verify"], await withClaude("claude-fail"))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("LLM 추출이 모두 실패했습니다"),
    });
  });

  it("run rejects session mode", async () => {
    await expect(specmock("run", "pets", PETS_MD, "--llm", "session")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("세션 모드를 지원하지 않습니다") });
  });

  it("analyze with a failing claude exits 2 and prints the retry hint", async () => {
    await specmock("ingest", "pets", PETS_MD);
    await expect(run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code"], await withClaude("claude-fail"))).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("다음: 실패/미추출 청크만 다시 추출"),
    });
  });

  it("rejects an unknown --llm, --prepare with --merge, and --merge with other options", async () => {
    await specmock("ingest", "pets", PETS_MD);
    await expect(specmock("analyze", "pets", "--llm", "gpt")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("알 수 없는 LLM 어댑터") });
    await expect(specmock("analyze", "pets", "--prepare", "--merge")).rejects.toMatchObject({ code: 1 });
    await expect(specmock("analyze", "pets", "--merge", "--refresh")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--merge 는 다른 옵션과") });
  });

  it("session-mode analyze --refresh clears extracted/ before prepare", async () => {
    await specmock("ingest", "pets", PETS_MD);
    await specmock("analyze", "pets");
    const ex = path.join(dir, ".specmock", "pets", "extracted");
    await mkdir(ex, { recursive: true });
    await writeFile(path.join(ex, "000.json"), '{"endpoints":[]}');
    await writeFile(path.join(ex, "manifest.json"), "{}");
    const { stderr } = await specmock("analyze", "pets", "--refresh");
    expect(stderr).toContain("기존 추출 결과 1개를 지웠습니다");
    expect(await readdir(ex)).toEqual([]);
  });
});
