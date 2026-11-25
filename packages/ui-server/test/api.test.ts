import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetSchema } from "@specmock/core";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const PETSTORE = path.join(REPO, "packages", "core", "test", "fixtures", "petstore.yaml");
const PETS_MD = path.join(REPO, "examples", "docs-sample", "pets-api.md");
const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-api-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// 실제 claude를 부르지 않도록 느린 가짜를 쓴다(core/test/bin).
const FAKE_CLAUDE = path.join(REPO, "packages", "core", "test", "bin", "claude-slow");
function client() {
  const { app } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310, claudeCommand: FAKE_CLAUDE });
  return {
    app,
    put: async (p: string, b: unknown) => { const r = await app.request(`/api${p}`, { method: "PUT", headers: HOST, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; },
    get: async (p: string) => { const r = await app.request(`/api${p}`, { headers: HOST }); return { status: r.status, body: await r.json() }; },
    post: async (p: string, b: unknown = {}) => { const r = await app.request(`/api${p}`, { method: "POST", headers: HOST, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; },
  };
}

describe("OpenAPI 경로", () => {
  it("등록 → 분석 → 기능 목록 → 상세 → 선택 저장 → 시스템 단계", async () => {
    const c = client();
    expect((await c.get("/systems")).body).toEqual({ ok: true, data: [] });
    const reg = await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    expect(reg.body).toMatchObject({ ok: true, data: { system: "petstore", inputs: [{ kind: "openapi" }] } });
    const an = await c.post("/systems/petstore/analyze");
    expect(an.body).toMatchObject({ ok: true, data: { mode: "catalog", via: "openapi" } });
    const list = await c.get("/systems/petstore/features");
    expect(list.body.data.rows.length).toBeGreaterThan(0);
    expect(list.body.data.groups.length).toBeGreaterThan(0);
    // 행에는 화면용 summary(문자열)와 응답 코드 목록이 붙는다.
    for (const r of list.body.data.rows) { expect(typeof r.summary).toBe("string"); expect(Array.isArray(r.codes)).toBe(true); }
    expect(list.body.data.rows.some((r: { codes: string[] }) => r.codes.includes("200"))).toBe(true);
    const id = list.body.data.rows[0].id;
    expect((await c.get(`/systems/petstore/features/${encodeURIComponent(id)}`)).body.data.id).toBe(id);
    const sel = await c.post("/systems/petstore/selection", { ids: [id] });
    expect(sel.body).toMatchObject({ ok: true, data: { selected: [id] } });
    const systems = (await c.get("/systems")).body.data;
    expect(systems[0]).toMatchObject({ name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: false } });
  });

  it("모르는 그룹 필터는 빈 rows (Task 1)", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    expect((await c.get("/systems/petstore/features?group=nope")).body.data.rows).toEqual([]);
  });
});

describe("Task 4 리뷰 수정", () => {
  it("없는 파일·디렉터리 경로 등록 → 400 invalid, 읽기 쉬운 메시지, 시스템 디렉터리 없음", async () => {
    const c = client();
    const missing = await c.post("/systems", { system: "x", origins: [path.join(root, "nope.yaml")] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "invalid", message: `파일을 찾을 수 없어요: ${path.join(root, "nope.yaml")}` });
    const dir = await c.post("/systems", { system: "x", origins: [root] });
    expect(dir.status).toBe(400);
    expect(dir.body.error.message).toBe(`파일이 아니라 디렉터리예요: ${root}`);
    expect((await c.get("/systems")).body.data).toEqual([]);
  });
  it("접속할 수 없는 URL 등록 → 400 invalid", async () => {
    const r = await client().post("/systems", { system: "x", origins: ["http://127.0.0.1:1/spec.yaml"] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid");
  });
  it("없는 기능 id 상세 → 404 not-found", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const r = await c.get("/systems/petstore/features/nope.get");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not-found");
  });
  it("선택에 모르는 id → 여전히 400 invalid", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    expect((await c.post("/systems/petstore/selection", { ids: ["nope.get"] })).status).toBe(400);
  });
  it("상대 경로 origin은 root 기준 → source.json엔 절대 경로", async () => {
    const { copyFile, readFile } = await import("node:fs/promises");
    await copyFile(PETSTORE, path.join(root, "spec.yaml"));
    const c = client();
    expect((await c.post("/systems", { system: "rel", origins: ["spec.yaml"] })).status).toBe(200);
    const src = JSON.parse(await readFile(path.join(root, ".specmock", "rel", "source.json"), "utf8"));
    expect(src.inputs[0].origin).toBe(path.join(root, "spec.yaml"));
    expect((await c.get("/systems/rel")).body.data.source[0].origin).toBe(path.join(root, "spec.yaml"));
  });
  it("빈 group 쿼리는 필터 없음", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const all = (await c.get("/systems/petstore/features")).body.data;
    const empty = (await c.get("/systems/petstore/features?group=")).body.data;
    expect(empty.rows).toEqual(all.rows);
    expect(empty.groups).toEqual(all.groups);
  });
  it("작업 공간 파일 손상 → 500 failed (요청 본문 오류는 400)", async () => {
    const { writeFile } = await import("node:fs/promises");
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    await writeFile(path.join(root, ".specmock", "petstore", "catalog.json"), "{ not json");
    const r = await c.get("/systems/petstore/features");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("failed");
    expect((await c.post("/systems", { system: "x" })).status).toBe(400);
  });
});

describe("문서 경로", () => {
  it("분석은 prepared + 청크 표(done=false)", async () => {
    const c = client();
    await c.post("/systems", { system: "pets", origins: [PETS_MD] });
    expect((await c.post("/systems/pets/analyze")).body.data.mode).toBe("prepared");
    const chunks = (await c.get("/systems/pets/chunks")).body.data;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((x: { done: boolean }) => !x.done)).toBe(true);
  });
});

describe("오류 형식", () => {
  it("분석 전 기능 목록 → 404 not-found, hint는 화면 동작 이름", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    const r = await c.get("/systems/petstore/features");
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: "not-found", hint: "먼저 ② 분석을 진행해 주세요." });
  });
  it("잘못된 시스템 이름 → 400 invalid", async () => {
    expect((await client().post("/systems", { system: "a b", origins: [PETSTORE] })).body.error.code).toBe("invalid");
  });
  it("본문 형식 오류 → 400 invalid", async () => {
    expect((await client().post("/systems", { system: "x" })).body.error.code).toBe("invalid");
  });
  it("빈 선택 → 400 invalid (결정 2)", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    expect((await c.post("/systems/petstore/selection", { ids: [] })).body.error.code).toBe("invalid");
  });
});

describe("없는 시스템", () => {
  it("읽기·변경 요청이 .specmock 아래 유령 디렉터리를 만들지 않고, 목록에도 나오지 않는다", async () => {
    const c = client();
    const results = [
      await c.get("/systems/ghost"),
      await c.get("/systems/ghost/features"),
      await c.get("/systems/ghost/chunks"),
      await c.get("/systems/ghost/selection"),
      await c.post("/systems/ghost/analyze"),
      await c.post("/systems/ghost/selection", { ids: ["x"] }),
    ];
    for (const r of results) expect(r.status).toBe(404);
    const ws = path.join(root, ".specmock");
    const names = await readdir(ws).catch(() => [] as string[]);
    expect(names).toEqual([]);
    expect((await c.get("/systems")).body).toEqual({ ok: true, data: [] });
  });
  it("빈 디렉터리·등록 안 된 디렉터리는 목록에서 뺀다", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, ".specmock", "empty"), { recursive: true });
    expect((await client().get("/systems")).body.data).toEqual([]);
  });
});

describe("시스템 개요", () => {
  it("등록 직후: 단계·기본 출력 경로·mock/<system>", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    const o = (await c.get("/systems/petstore")).body.data;
    expect(o.defaultOutDir).toBe(path.join(root, "mock", "petstore"));
    expect(o).toMatchObject({ analyze: "none", catalogTotal: 0, selection: null, generate: null, coverage: null });
    expect(o.summary.steps).toMatchObject({ registered: true, analyzed: false });
    expect(o.source).toHaveLength(1);
  });
  it("분석 후 catalog, 선택 조회, 선택 뒤 catalog가 바뀌면 stale.select", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    expect((await c.get("/systems/petstore/selection")).body).toEqual({ ok: true, data: null });
    const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
    await c.post("/systems/petstore/selection", { ids: [id] });
    const o = (await c.get("/systems/petstore")).body.data;
    expect(o.analyze).toBe("catalog");
    expect(o.catalogTotal).toBeGreaterThan(0);
    expect(o.selection.selected).toEqual([id]);
    expect((await c.get("/systems/petstore/selection")).body.data.selected).toEqual([id]);
    expect(o.summary.stale).toEqual({ select: false, generate: false, verify: false, record: false });
  });
  it("mtime 비교로 stale 판정", async () => {
    const { utimes, writeFile } = await import("node:fs/promises");
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
    await c.post("/systems/petstore/selection", { ids: [id] });
    const dir = path.join(root, ".specmock", "petstore");
    await writeFile(path.join(dir, "generate.json"), JSON.stringify({ outDir: "/tmp/elsewhere", generatedAt: "x" }));
    await writeFile(path.join(dir, "coverage.md"), "# c");
    const t = (s: number) => new Date(Date.now() + s * 1000);
    await utimes(path.join(dir, "catalog.json"), t(-40), t(-40));
    await utimes(path.join(dir, "selection.json"), t(-30), t(-30));
    await utimes(path.join(dir, "generate.json"), t(-20), t(-20));
    await utimes(path.join(dir, "coverage.md"), t(-10), t(-10));
    let s = (await c.get("/systems")).body.data[0];
    expect(s.stale).toEqual({ select: false, generate: false, verify: false, record: false });
    expect(s.steps).toMatchObject({ generated: true, verified: true });
    expect((await c.get("/systems/petstore")).body.data.defaultOutDir).toBe("/tmp/elsewhere");
    await utimes(path.join(dir, "catalog.json"), t(0), t(0));
    await utimes(path.join(dir, "selection.json"), t(-5), t(-5));
    await utimes(path.join(dir, "generate.json"), t(-25), t(-25));
    await utimes(path.join(dir, "coverage.md"), t(-35), t(-35));
    s = (await c.get("/systems")).body.data[0];
    expect(s.stale).toEqual({ select: true, generate: true, verify: true, record: false });
  });
  it("문서 시스템은 chunks 개수를 낸다", async () => {
    const c = client();
    await c.post("/systems", { system: "pets", origins: [PETS_MD] });
    await c.post("/systems/pets/analyze");
    const s = (await c.get("/systems")).body.data[0];
    expect(s).toMatchObject({ name: "pets", kind: "markdown", chunks: { done: 0 } });
    expect(s.chunks.total).toBeGreaterThan(0);
    expect((await c.get("/systems/pets")).body.data.analyze).toBe("prepared");
  });
});

describe("종료 중", () => {
  it("jobs.shutdown 뒤 작업 POST는 503 shutting-down", async () => {
    const { app, jobs } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310 });
    const post = (p: string, b: unknown = {}) => app.request(`/api${p}`, { method: "POST", headers: HOST, body: JSON.stringify(b) });
    await post("/systems", { system: "petstore", origins: [PETSTORE] });
    await post("/systems/petstore/analyze");
    jobs.shutdown();
    const r = await post("/systems/petstore/verify");
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "shutting-down", message: "서버를 끄는 중이에요" } });
  });
});

describe("Task 9 리뷰 수정", () => {
  it("행 설명은 summary || title || id (상세와 같은 규칙)", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const file = path.join(root, ".specmock", "petstore", "catalog.json");
    const cat = JSON.parse(await readFile(file, "utf8"));
    cat.features[0].summary = ""; cat.features[0].title = "제목만 있어요";
    cat.features[1].summary = ""; cat.features[1].title = "";
    await writeFile(file, JSON.stringify(cat));
    const rows = (await c.get("/systems/petstore/features")).body.data.rows as { id: string; summary: string }[];
    expect(rows.find((r) => r.id === cat.features[0].id)!.summary).toBe("제목만 있어요");
    expect(rows.find((r) => r.id === cat.features[1].id)!.summary).toBe(cat.features[1].id);
  });

  it("generate 작업은 입력(outDir)을 job에 싣는다", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const out = path.join(root, "out-x");
    const r = await c.post("/systems/petstore/generate", { outDir: out });
    const list = (await c.get("/jobs")).body.data as { running: { id: string; input?: unknown }[]; recent: { id: string; input?: unknown }[] };
    const j = [...list.running, ...list.recent].find((x) => x.id === r.body.data.jobId)!;
    expect(j.input).toEqual({ outDir: out });
  });

  it("generate body의 language는 job 입력에 실리고, 모르는 언어는 400 invalid", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const bad = await c.post("/systems/petstore/generate", { outDir: path.join(root, "o"), language: "cobol" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "invalid", message: expect.stringContaining("지원 언어: ts, java") });
    expect((await c.get("/jobs")).body.data).toEqual({ running: [], recent: [] });
    const out = path.join(root, "out-ts");
    const r = await c.post("/systems/petstore/generate", { outDir: out, language: "ts" });
    const list = (await c.get("/jobs")).body.data as { running: { id: string; input?: unknown }[]; recent: { id: string; input?: unknown }[] };
    expect([...list.running, ...list.recent].find((x) => x.id === r.body.data.jobId)!.input).toEqual({ outDir: out, language: "ts" });
  });

  it("언어를 바꾸는 generate는 force 없이 409 language-change-required, 작업은 만들지 않는다. force면 202", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
    await c.post("/systems/petstore/selection", { ids: [id] });
    const out = path.join(root, "out-lang");
    await c.post("/systems/petstore/generate", { outDir: out, language: "ts" });
    await vi.waitFor(async () => expect((await c.get("/jobs")).body.data.recent).toHaveLength(1));
    const r = await c.post("/systems/petstore/generate", { outDir: out, language: "java" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: { code: "language-change-required", from: "ts", to: "java", message: expect.stringMatching(/ts.*java/) } });
    expect((await c.get("/jobs")).body.data.recent).toHaveLength(1);
    const forced = await c.post("/systems/petstore/generate", { outDir: out, language: "java", force: true });
    expect(forced.status).toBe(202);
    await c.post(`/jobs/${forced.body.data.jobId}/cancel`); // 실제 claude를 부르지 않게 끊고, 정리 전에 끝나길 기다린다
    await vi.waitFor(async () => expect((await c.get("/jobs")).body.data.running).toHaveLength(0), { timeout: 10_000 });
  });
});

async function app(_c: unknown, method: string, p: string, b: unknown) {
  const { app: a } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310, claudeCommand: FAKE_CLAUDE });
  const r = await a.request(`/api${p}`, { method, headers: HOST, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json() };
}

describe("record (3B)", () => {
  let real: Server | undefined;
  afterEach(async () => { real?.closeAllConnections(); await new Promise<void>((r) => (real ? real.close(() => r()) : r())); real = undefined; });
  /** hang이면 응답하지 않는다(취소 테스트용). */
  async function realSystem(hang = false): Promise<string> {
    real = createServer((req, res) => {
      if (hang) return;
      const ok = req.method === "GET" && /^\/pets\/[^/?]+/.test(req.url!);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { id: 1, name: "Real" } : {}));
    });
    await new Promise<void>((r) => real!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(real!.address() as AddressInfo).port}`;
  }
  async function prepare(c: ReturnType<typeof client>, target?: unknown) {
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    await c.post("/systems/petstore/selection", { ids: ["getPet"] });
    if (target) {
      await mkdir(path.join(root, ".specmock", "petstore"), { recursive: true });
      await writeFile(path.join(root, ".specmock", "petstore", "target.json"), JSON.stringify(target));
    }
  }
  const finished = async (c: ReturnType<typeof client>) => {
    await vi.waitFor(async () => expect((await c.get("/jobs")).body.data.running).toHaveLength(0), { timeout: 10_000 });
    return (await c.get("/jobs")).body.data.recent[0] as { kind: string; state: string; cancellable: boolean; result?: { result: { matched: string[] }; driftMarkdown: string } };
  };

  it("GET target: 없으면 exists false와 예시", async () => {
    const c = client();
    await prepare(c);
    const r = await c.get("/systems/petstore/target");
    expect(r.body).toEqual({ ok: true, data: { exists: false, example: expect.stringContaining("https://api.example.com/v2") } });
  });

  it("GET target: 헤더의 직접 적은 값만 ***로 가리고 공통·기능별 값은 원문, env 상태를 싣는다", async () => {
    const c = client();
    vi.stubEnv("UI_FROM_PROCESS", "x");
    await prepare(c, { baseUrl: "https://real.example.com/v2/", headers: { Authorization: "Bearer ${UI_SECRET_TOKEN}", "X-Ref": "${UI_FROM_PROCESS}" }, params: { petId: "777", mix: "a-${UI_CUS}" }, features: { getPet: { id: "${UI_CUS}", q: "limit=5" } } });
    await c.post("/systems/petstore/env", { values: { UI_CUS: "cus_zzz", UI_FROM_PROCESS: "typed" } });   // 화면 입력이 process보다 우선
    const r = await c.get("/systems/petstore/target");
    expect(r.body.data).toMatchObject({
      exists: true, baseUrl: "https://real.example.com/v2",
      target: {
        baseUrl: "https://real.example.com/v2", timeoutMs: 15000,
        headers: [{ name: "Authorization", value: "***", literal: true }, { name: "X-Ref", value: "${UI_FROM_PROCESS}", literal: false }],
        params: [{ name: "petId", value: "777", literal: true }, { name: "mix", value: "a-${UI_CUS}", literal: true }],
        features: { getPet: [{ name: "id", value: "${UI_CUS}", literal: false }, { name: "q", value: "limit=5", literal: true }] },
      },
      env: [{ name: "UI_SECRET_TOKEN", status: "missing" }, { name: "UI_FROM_PROCESS", status: "session" }, { name: "UI_CUS", status: "session" }],
    });
    expect(JSON.stringify(r.body.data.target)).not.toMatch(/cus_zzz|Bearer/);
    vi.unstubAllEnvs();
  });

  it("PUT target: keep은 기존 값을 그대로 두고, 빈 기능 묶음은 쓰지 않는다", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://a.example.com", headers: { Authorization: "Bearer real-token" }, params: { q: "1" } });
    const put = async (b: unknown) => { const r = await app(c, "PUT", "/systems/petstore/target", b); return r; };
    const r = await put({ baseUrl: "https://b.example.com", headers: [{ name: "Authorization", keep: true }, { name: "X-Id", value: "${UI_ID}" }], params: [], features: { getPet: [{ name: "petId", value: "5" }] } });
    expect(r.status).toBe(200);
    expect(r.body.data.target.features).toEqual({ getPet: [{ name: "petId", value: "5", literal: true }] });
    const file = JSON.parse(await readFile(path.join(root, ".specmock", "petstore", "target.json"), "utf8"));
    expect(file).toEqual({ baseUrl: "https://b.example.com", headers: { Authorization: "Bearer real-token", "X-Id": "${UI_ID}" }, features: { getPet: { petId: "5" } } });
  });

  it("PUT target: 본문에 없는 기능 id의 기존 값은 파일에 남고, 본문에 있는 id는 본문이 전부다", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://a.example.com", features: { other: { id: "9" }, getPet: { old: "1" } } });
    const r = await app(c, "PUT", "/systems/petstore/target", { baseUrl: "https://a.example.com", headers: [], params: [], features: { getPet: [{ name: "petId", value: "5" }] } });
    expect(r.status).toBe(200);
    const file = JSON.parse(await readFile(path.join(root, ".specmock", "petstore", "target.json"), "utf8"));
    expect(file.features).toEqual({ other: { id: "9" }, getPet: { petId: "5" } });
  });

  it("PUT target: 없는 이름을 keep하면 400, 형식 오류도 400(값은 싣지 않는다)", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://a.example.com" });
    const keep = await app(c, "PUT", "/systems/petstore/target", { baseUrl: "https://a.example.com", headers: [{ name: "Nope", keep: true }], params: [], features: {} });
    expect(keep.status).toBe(400);
    const bad = await app(c, "PUT", "/systems/petstore/target", { baseUrl: "ftp://SECRET_VALUE", headers: [], params: [], features: {} });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("SECRET_VALUE");
    expect(JSON.parse(await readFile(path.join(root, ".specmock", "petstore", "target.json"), "utf8"))).toEqual({ baseUrl: "https://a.example.com" });
  });

  it("PUT target: 비어 있는 기능 묶음은 파일에 쓰지 않는다", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://a.example.com" });
    expect((await c.put("/systems/petstore/target", { baseUrl: "https://a.example.com", headers: [], params: [], features: { getPet: [] } })).status).toBe(200);
    expect(JSON.parse(await readFile(path.join(root, ".specmock", "petstore", "target.json"), "utf8"))).toEqual({ baseUrl: "https://a.example.com" });
  });

  it("PUT target: 파일이 없으면 새로 만든다", async () => {
    const c = client();
    await prepare(c);
    const r = await c.put("/systems/petstore/target", { baseUrl: "https://new.example.com", headers: [{ name: "Authorization", value: "Bearer ${UI_T}" }], params: [], features: {} });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ exists: true, target: { baseUrl: "https://new.example.com" } });
    const file = JSON.parse(await readFile(path.join(root, ".specmock", "petstore", "target.json"), "utf8"));
    expect(TargetSchema.safeParse(file).success).toBe(true);
  });

  it("PUT target: 헤더·값 이름 형식이 틀리면 400", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://a.example.com" });
    const base = { baseUrl: "https://a.example.com", headers: [], params: [], features: {} };
    expect((await c.put("/systems/petstore/target", { ...base, headers: [{ name: "Bad Header", value: "v" }] })).status).toBe(400);
    expect((await c.put("/systems/petstore/target", { ...base, params: [{ name: "1bad", value: "v" }] })).status).toBe(400);
    expect((await c.put("/systems/petstore/target", { ...base, features: { getPet: [{ name: "a b", value: "v" }] } })).status).toBe(400);
    expect((await c.put("/systems/petstore/target", { ...base, headers: [{ name: "X-Ok_1", value: "v" }] })).status).toBe(200);
  });

  it("PUT target: 모르는 기능 id는 400(id 이름만), mockspec.json이 없으면 대조하지 않는다", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://a.example.com" });
    const body = (id: string) => ({ baseUrl: "https://a.example.com", headers: [], params: [], features: { [id]: [{ name: "petId", value: "SECRET_V" }] } });
    const bad = await c.put("/systems/petstore/target", body("customers.gte"));
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("알 수 없는 기능 id: customers.gte");
    expect(JSON.stringify(bad.body)).not.toContain("SECRET_V");
    expect((await c.put("/systems/petstore/target", body("getPet"))).status).toBe(200);
    await rm(path.join(root, ".specmock", "petstore", "mockspec.json"));
    expect((await c.put("/systems/petstore/target", body("anything"))).status).toBe(200);
  });

  it("POST env: 이름만 돌려주고, 값은 record 결과 어디에도 남지 않는다", async () => {
    const c = client();
    const secret = "sk_live_ENVLEAK_9876";
    const direct = "direct-header-LEAK-4321";
    await prepare(c, { baseUrl: await realSystem(), headers: { "X-Key": "${UI_ENV_KEY}", "X-Direct": direct } });
    const e = await c.post("/systems/petstore/env", { values: { UI_ENV_KEY: secret } });
    expect(e.body).toEqual({ ok: true, data: { names: ["UI_ENV_KEY"] } });
    expect(JSON.stringify(e.body)).not.toContain(secret);
    const sse = await c.app.request("/api/events", { headers: HOST });
    const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
    let stream = "";
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; stream += value; if (stream.includes("event: job-done")) return; } })();
    await c.post("/systems/petstore/record");
    const j = await finished(c);
    expect(j.state).toBe("done");
    await pump; await reader.cancel();
    expect(stream).toContain("event: job-started");
    expect(stream).not.toContain(secret);
    expect(stream).not.toContain(direct);
    const dir = path.join(root, ".specmock", "petstore");
    const texts = [JSON.stringify(await c.get("/jobs")), (await c.get("/systems/petstore/record/last")).body, await readFile(path.join(dir, "drift.md"), "utf8")].map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    for (const f of await readdir(path.join(dir, "recorded"))) texts.push(await readFile(path.join(dir, "recorded", f), "utf8"));
    for (const t of texts) { expect(t).not.toContain(secret); expect(t).not.toContain(direct); }
  });

  it("POST env: 잘못된 이름은 400, GET은 405", async () => {
    const c = client();
    await prepare(c);
    const bad = await c.post("/systems/petstore/env", { values: { "1BAD": "v" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('"v"');
    expect((await c.get("/systems/petstore/env")).status).toBe(405);
  });

  it("POST record: apply false면 applied가 null, 모르는 기능 id는 400", async () => {
    const c = client();
    await prepare(c, { baseUrl: await realSystem() });
    const unknown = await c.post("/systems/petstore/record", { features: ["nope"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain("nope");
    const r = await c.post("/systems/petstore/record", { features: ["getPet"], apply: false });
    expect(r.status).toBe(202);
    const j = await finished(c);
    expect(j.state).toBe("done");
    expect((j.result as unknown as { result: { applied: unknown } }).result.applied).toBeNull();
  });

  it("GET record/last: drift 원문과 기능별 상태·시각, 응답 본문은 없다. steps·stale.record", async () => {
    const c = client();
    await prepare(c, { baseUrl: await realSystem() });
    expect((await c.get("/systems/petstore/record/last")).body.data).toEqual({ exists: false, recorded: [] });
    expect((await c.get("/systems")).body.data[0].steps.record).toBe(false);
    await c.post("/systems/petstore/record");
    await finished(c);
    const last = (await c.get("/systems/petstore/record/last")).body.data;
    expect(last.exists).toBe(true);
    expect(last.driftMarkdown).toContain("# petstore 실제 시스템 대조 (");
    expect(last.recorded).toEqual([{ featureId: "getPet", status: 200, at: expect.any(String) }]);
    expect(JSON.stringify(last)).not.toContain("Real");   // 가짜 시스템이 돌려준 본문(name: Real)
    const sys = (await c.get("/systems")).body.data[0];
    expect(sys.steps.record).toBe(true);
    expect(sys.stale.record).toBe(false);
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(root, ".specmock", "petstore", "mockspec.json"), future, future);
    expect((await c.get("/systems")).body.data[0].stale.record).toBe(true);
  });

  it("GET target: 형식 오류는 exists true + error(필드 이름)", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://x.example.com", header: {} });
    expect((await c.get("/systems/petstore/target")).body.data).toMatchObject({ exists: true, error: expect.stringContaining("header") });
  });

  it("POST record → job kind record(취소 가능), 끝나면 결과와 drift 본문", async () => {
    const c = client();
    await prepare(c, { baseUrl: await realSystem() });
    const r = await c.post("/systems/petstore/record", { allowMutating: false });
    expect(r.status).toBe(202);
    const j = await finished(c);
    expect(j).toMatchObject({ kind: "record", state: "done", cancellable: true });
    expect(j.result!.result.matched).toEqual(["getPet"]);
    expect(j.result!.driftMarkdown).toContain("# petstore 실제 시스템 대조 (");
    expect(await readdir(path.join(root, ".specmock", "petstore", "recorded"))).toEqual(["getPet.json"]);
  });

  it("record 진행 중 두 번째 POST는 409 busy, 취소하면 cancelled", async () => {
    const c = client();
    await prepare(c, { baseUrl: await realSystem(true), timeoutMs: 30_000 });
    const first = await c.post("/systems/petstore/record");
    const second = await c.post("/systems/petstore/record");
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ ok: false, error: { code: "busy" }, jobId: first.body.data.jobId });
    await c.post(`/jobs/${first.body.data.jobId}/cancel`);
    expect((await finished(c)).state).toBe("cancelled");
  });

  it("GET /record는 405", async () => {
    const c = client();
    await prepare(c);
    expect((await c.get("/systems/petstore/record")).status).toBe(405);
  });
});
