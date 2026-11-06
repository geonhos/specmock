import { mkdtemp, readdir, rm } from "node:fs/promises";
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
