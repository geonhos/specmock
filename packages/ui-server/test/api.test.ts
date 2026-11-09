import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const PETSTORE = path.join(REPO, "packages", "core", "test", "fixtures", "petstore.yaml");
const PETS_MD = path.join(REPO, "examples", "docs-sample", "pets-api.md");
const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-api-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function client() {
  const { app } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310 });
  return {
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
    expect(o.summary.stale).toEqual({ select: false, generate: false, verify: false });
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
    expect(s.stale).toEqual({ select: false, generate: false, verify: false });
    expect(s.steps).toMatchObject({ generated: true, verified: true });
    expect((await c.get("/systems/petstore")).body.data.defaultOutDir).toBe("/tmp/elsewhere");
    await utimes(path.join(dir, "catalog.json"), t(0), t(0));
    await utimes(path.join(dir, "selection.json"), t(-5), t(-5));
    await utimes(path.join(dir, "generate.json"), t(-25), t(-25));
    await utimes(path.join(dir, "coverage.md"), t(-35), t(-35));
    s = (await c.get("/systems")).body.data[0];
    expect(s.stale).toEqual({ select: true, generate: true, verify: true });
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
});
