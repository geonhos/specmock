import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

  it("select --interactive refuses without a TTY, with expressions, and --group without --interactive", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await expect(specmock("select", "petstore", "--interactive")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("터미널에서만") });
    await expect(specmock("select", "petstore", "--interactive", "--add")).rejects.toMatchObject({ code: 1 });
    await expect(specmock("select", "petstore", "all", "--group", "pets")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--interactive와 함께만") });
    await expect(specmock("select", "petstore")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--interactive를 쓰세요") });
  });
});

describe("Phase 3A CLI", () => {
  const withClaude = async (script: string) => {
    const bin = path.join(dir, "fakebin");
    await mkdir(bin, { recursive: true });
    await symlink(path.join(FAKE_BIN, script), path.join(bin, "claude"));
    return { cwd: dir, env: { ...process.env, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` } };
  };
  async function selected() {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "getPet,createPet");
  }

  it("generate --lang cobol은 지원 언어 목록과 함께 종료 코드 1", async () => {
    await selected();
    await expect(specmock("generate", "petstore", "--lang", "cobol")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("'cobol' 언어는 지원하지 않습니다. 지원 언어: ts, java"),
    });
  });

  it("generate는 모르는 --llm과 잘못된 --max-attempts를 거부한다", async () => {
    await selected();
    await expect(specmock("generate", "petstore", "--lang", "java", "--llm", "gpt")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("알 수 없는 LLM 어댑터: gpt (claude-code, session)") });
    await expect(specmock("generate", "petstore", "--lang", "java", "--max-attempts", "0")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--max-attempts는 1 이상의 정수") });
  });

  it("generate --lang java가 maxAttempts 안에 통과하지 못하면 종료 코드 5와 attempt 위치를 알린다", async () => {
    await selected();
    const env = await withClaude("claude-fail");
    await expect(run(TSX, [CLI, "generate", "petstore", "--lang", "java", "--max-attempts", "2"], env)).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringMatching(/코드 생성 중 \(1\/2\)[\s\S]*코드 생성 중 \(2\/2\)[\s\S]*2번 시도했지만 검증을 통과하는 mock을 만들지 못했습니다\. 마지막 시도: .*\.specmock-attempt/),
    });
    await expect(readFile(path.join(dir, "mock", "petstore", "specmock.lock.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("generate --lang java --llm session은 지시서를 쓰고 다음 단계를 안내한다. --json은 같은 정보", async () => {
    await selected();
    const { stdout } = await specmock("generate", "petstore", "--lang", "java", "--llm", "session");
    expect(stdout).toContain(path.join(dir, ".specmock", "petstore", "generate-request.json"));
    expect(stdout).toContain("specmock generate petstore --finalize");
    const j = JSON.parse((await specmock("generate", "petstore", "--lang", "java", "--llm", "session", "--json")).stdout);
    expect(j).toMatchObject({ mode: "session", language: "java", reused: true, outDir: path.join(dir, "mock", "petstore") });
  });

  it("generate --finalize는 지시서가 없으면 reason과 함께 종료 코드 1", async () => {
    await selected();
    await expect(specmock("generate", "petstore", "--finalize")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("확정 거부(no-request)") });
  });

  it("generate(ts) --json은 attempts·notes·userModified·skipped·launch를 싣는다. ts는 같은 mockspec이어도 건너뛰지 않는다", async () => {
    await selected();
    const first = JSON.parse((await specmock("generate", "petstore", "--json")).stdout);
    expect(first).toMatchObject({ language: "ts", attempts: 0, notes: [], userModified: [], skipped: false, launch: `cd ${path.join(dir, "mock", "petstore")} && npm install && npm start` });
    const { stdout } = await specmock("generate", "petstore");
    expect(stdout).toContain("생성 완료");
    expect(stdout).not.toContain("변경 없음");
  });

  it("run --lang cobol은 파이프라인 전에 종료 코드 1", async () => {
    await expect(specmock("run", "petstore", PETSTORE, "--lang", "cobol", "--no-verify")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("지원 언어: ts, java") });
    await expect(readdir(path.join(dir, ".specmock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Phase 3B CLI (record)", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });
  /** getPet 응답 바디를 주는 실제 시스템 대역. */
  async function realSystem(body: unknown): Promise<string> {
    server = createServer((req, res) => {
      const ok = req.method === "GET" && /^\/pets\/[^/]+$/.test(req.url!.split("?")[0]!);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? body : { message: "no" }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  async function selected(target?: object) {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "getPet,createPet");
    if (target) await writeFile(path.join(dir, ".specmock", "petstore", "target.json"), JSON.stringify(target));
  }

  it("전부 일치하면 종료 코드 0, 요약과 drift 경로를 출력한다", async () => {
    await selected({ baseUrl: await realSystem({ id: 1, name: "Real" }) });
    const { stdout } = await specmock("record", "petstore");
    expect(stdout).toContain("녹화: 요청 2 · 일치 1 · 스펙과 다름 0 · 상태 불일치 0 · 건너뜀 1 · 실패 0");
    expect(stdout).toContain(`drift: ${path.join(dir, ".specmock", "petstore", "drift.md")}`);
    expect(stdout).toContain("- generate를 실행하면 반영됩니다");
  });

  it("--json은 RecordResult에 notes를 더해 출력한다", async () => {
    await selected({ baseUrl: await realSystem({ id: 1, name: "Real" }) });
    const { stdout } = await specmock("record", "petstore", "--json", "--no-apply");
    const j = JSON.parse(stdout);
    expect(j).toMatchObject({ system: "petstore", matched: ["getPet"], recorded: ["getPet"], applied: null });
    expect(j.skipped).toEqual([{ featureId: "createPet", reason: "mutating" }]);
    expect(j.notes).toEqual([]);
  });

  it("--json에도 반영 안내·반영 실패 notes가 실린다", async () => {
    await selected({ baseUrl: await realSystem({ id: 1, name: "Real" }) });
    const later = JSON.parse((await specmock("record", "petstore", "--json")).stdout);
    expect(later.notes).toEqual(["generate를 실행하면 반영됩니다"]);
    const selPath = path.join(dir, ".specmock", "petstore", "selection.json");
    const sel = JSON.parse(await readFile(selPath, "utf8"));
    await writeFile(selPath, JSON.stringify({ ...sel, selected: ["getPet", "gonePet"] }));
    const err = await specmock("record", "petstore", "--json", "--feature", "getPet").catch((e: { code: number; stdout: string }) => e) as { code: number; stdout: string };
    expect(err.code).toBe(2);
    expect(JSON.parse(err.stdout).notes[0]).toMatch(/^반영 실패: /);
  });

  it("스펙과 다르면 종료 코드 2", async () => {
    await selected({ baseUrl: await realSystem({ id: "p-1", name: "Real" }) });
    await expect(specmock("record", "petstore", "--feature", "getPet")).rejects.toMatchObject({
      code: 2, stdout: expect.stringContaining("✗ getPet 스펙과 다름:"),
    });
  });

  it("실패(timeout)만 있어도 종료 코드 2", async () => {
    server = createServer(() => { /* 응답하지 않는다 */ });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    server.on("connection", (s) => s.unref());
    await selected({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 200 });
    await expect(specmock("record", "petstore", "--feature", "getPet", "--no-apply")).rejects.toMatchObject({
      code: 2, stdout: expect.stringContaining("✗ getPet 실패: 시간 초과(200ms)"),
    });
  });

  it("상태 불일치(401)만 있어도 종료 코드 2", async () => {
    server = createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    await selected({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    await expect(specmock("record", "petstore", "--feature", "getPet", "--no-apply")).rejects.toMatchObject({
      code: 2, stdout: expect.stringContaining("✗ getPet 상태 불일치: 기대 200, 실제 401"),
    });
  });

  it("반영 실패는 결과를 출력하고 종료 코드 2", async () => {
    await selected({ baseUrl: await realSystem({ id: 1, name: "Real" }) });
    const selPath = path.join(dir, ".specmock", "petstore", "selection.json");
    const sel = JSON.parse(await readFile(selPath, "utf8"));
    await writeFile(selPath, JSON.stringify({ ...sel, selected: ["getPet", "gonePet"] }));
    await expect(specmock("record", "petstore", "--feature", "getPet")).rejects.toMatchObject({
      code: 2, stdout: expect.stringContaining("- 반영 실패: "),
    });
  });

  it("target.json이 없으면 예시와 함께 종료 코드 1", async () => {
    await selected();
    await expect(specmock("record", "petstore")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('"baseUrl": "https://api.example.com/v2"'),
    });
  });

  it("환경변수가 없으면 변수 이름만 보여 준다", async () => {
    await selected({ baseUrl: "http://127.0.0.1:9", headers: { Authorization: "Bearer ${SPECMOCK_CLI_TOKEN}" } });
    const err = await specmock("record", "petstore").catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 1, stderr: expect.stringContaining("환경변수 SPECMOCK_CLI_TOKEN이 없습니다") });
    expect((err as { stderr: string }).stderr).not.toContain("Bearer");
  });
});

describe("LLM 사용량 기록", () => {
  const withClaude = async (script: string, extraEnv: Record<string, string> = {}) => {
    const bin = path.join(dir, "fakebin");
    await mkdir(bin, { recursive: true });
    await symlink(path.join(FAKE_BIN, script), path.join(bin, "claude"));
    return { cwd: dir, env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "", PATH: `${bin}:${process.env.PATH}`, ...extraEnv } };
  };

  it("analyze --llm claude-code: 어댑터 → extract → jsonl → stderr 합계 · --json usage까지 지난다", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const env = await withClaude("claude-usage");
    const { stdout, stderr } = await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code", "--json"], env);
    const rows = (await readFile(path.join(dir, ".specmock", "pets", "llm-usage.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "extract", ok: true, model: "claude-sonnet-4-5", inputTokens: 1842, costUsd: 0.0219, billing: "subscription" });
    expect(rows[0].detail).toMatch(/^chunk 000 · /);
    expect(rows[0]).not.toHaveProperty("prompt");
    expect(stderr).toContain("LLM 호출 1회(실패 0) · 입력 1,842 · 출력 611 · 캐시 읽기 12 · API 환산 $0.02 (구독: 실제 청구 아님) · ");
    const j = JSON.parse(stdout);
    expect(j.usage).toEqual({
      calls: 1, failed: 0, inputTokens: 1842, outputTokens: 611, cacheReadTokens: 12, cacheCreationTokens: 3977,
      costUsd: 0.0219, costBasis: "list", billing: "subscription", durationMs: rows[0].durationMs,
    });
  });

  it("합계는 이번 실행분만: 두 번째 실행(재추출 없음)은 줄이 없고 usage는 null", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const env = await withClaude("claude-usage");
    await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code"], env);
    const second = await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code", "--json"], env);
    expect(second.stderr).not.toContain("LLM 호출");
    expect(JSON.parse(second.stdout).usage).toBeNull();
    const third = await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code", "--refresh"], env);
    expect(third.stderr).toContain("LLM 호출 1회");   // 파일에는 2줄이 쌓였지만 이번 실행분만 센다
  });

  it("api-key로 과금되면 괄호가 (API 키 청구)", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const env = await withClaude("claude-usage", { ANTHROPIC_API_KEY: "sk-test" });
    const { stderr } = await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code"], env);
    expect(stderr).toContain("(API 키 청구)");
  });

  it("세션 모드 · merge · TS 생성은 usage null, 합계 줄 없음", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const prepared = await specmock("analyze", "pets", "--prepare", "--json");
    expect(JSON.parse(prepared.stdout).usage).toBeNull();
    expect(prepared.stderr).not.toContain("LLM 호출");
    await specmock("ingest", "petstore", PETSTORE);
    const a = await specmock("analyze", "petstore", "--json");
    expect(JSON.parse(a.stdout).usage).toBeNull();
    await specmock("select", "petstore", "getPet");
    const g = await specmock("generate", "petstore", "--json");
    expect(JSON.parse(g.stdout).usage).toBeNull();
    expect(g.stderr).not.toContain("LLM 호출");
  });

  it("generate --lang java가 실패해도 시도 합계가 stderr에 남는다", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "getPet");
    const env = await withClaude("claude-fail");
    await expect(run(TSX, [CLI, "generate", "petstore", "--lang", "java", "--max-attempts", "2"], env)).rejects.toMatchObject({
      code: 5, stderr: expect.stringContaining("LLM 호출 2회(시도 2/2) · 입력 0 · 출력 0 · 캐시 읽기 0 · "),
    });
    const rows = (await readFile(path.join(dir, ".specmock", "petstore", "llm-usage.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.stage, r.detail, r.ok])).toEqual([["generate", "java attempt 1/2", false], ["generate", "java attempt 2/2", false]]);
  });
});
