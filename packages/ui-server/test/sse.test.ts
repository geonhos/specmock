import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const BIN = path.join(REPO, "packages", "core", "test", "bin");
const PETS_MD = path.join(REPO, "examples", "docs-sample", "pets-api.md");
const PETSTORE = path.join(REPO, "packages", "core", "test", "fixtures", "petstore.yaml");
const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-sse-")); });
afterEach(async () => { delete process.env.PID_FILE; await rm(root, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(claude = "claude") {
  const made = createApp({ root, webDir: path.join(root, "web"), port: () => 4310, claudeCommand: path.join(BIN, claude) });
  const call = async (method: string, p: string, b?: unknown) => {
    const r = await made.app.request(`/api${p}`, { method, headers: HOST, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
    return { status: r.status, body: await r.json() as any };
  };
  return { ...made, get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b) };
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("until 시간 초과"); await sleep(25); }
}

it("A4: ready 다음 작업 이벤트가 순서대로 온다 (app.request의 SSE body를 조각으로 읽는다)", async () => {
  const { app, bus } = make();
  const res = await app.request("/api/events", { headers: HOST });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: string[] = [];
  const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; for (const m of value.matchAll(/^event: (.+)$/gm)) events.push(m[1]!); if (events.includes("job-done")) return; } })();
  await sleep(20);
  bus.publish("job-started", { id: "1" }); bus.publish("job-done", { id: "1" });
  await pump; await reader.cancel();
  expect(events).toEqual(["ready", "job-started", "job-done"]);
});

it("연결을 끊으면 구독이 해제된다", async () => {
  const { app, bus } = make();
  const res = await app.request("/api/events", { headers: HOST });
  const reader = res.body!.getReader();
  await reader.read();
  expect(bus.size).toBe(1);
  await reader.cancel();
  await until(async () => bus.size === 0);
});

it("추출 작업: 202 → /jobs에서 done, catalog에 GET /pets/{petId}", async () => {
  const c = make();
  await c.post("/systems", { system: "pets", origins: [PETS_MD] });
  expect((await c.post("/systems/pets/analyze")).body.data.mode).toBe("prepared");
  const start = await c.post("/systems/pets/extract");
  expect(start.status).toBe(202);
  expect(typeof start.body.data.jobId).toBe("string");
  const done = await until(async () => (await c.get("/jobs")).body.data.recent[0]);
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({ mode: "catalog", via: "llm" });
  const rows = (await c.get("/systems/pets/features")).body.data.rows;
  expect(rows.some((r: { method: string; path: string }) => r.method === "GET" && r.path === "/pets/{petId}")).toBe(true);
});

it("취소: 자식 프로세스가 사라지고 cancelled, 다시 시작 가능, 같은 시스템 중복 시작은 409+jobId", async () => {
  const pidFile = path.join(root, "pid");
  process.env.PID_FILE = pidFile;
  const c = make("claude-pid");
  await c.post("/systems", { system: "pets", origins: [PETS_MD] });
  await c.post("/systems/pets/analyze");
  const { jobId } = (await c.post("/systems/pets/extract")).body.data;
  const pid = Number(await until(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim() || undefined));
  const dup = await c.post("/systems/pets/extract");
  expect(dup.status).toBe(409);
  expect(dup.body).toMatchObject({ ok: false, error: { code: "busy" }, jobId });
  expect((await c.get("/jobs")).body.data.running.map((j: { id: string }) => j.id)).toEqual([jobId]);
  expect((await c.post(`/jobs/${jobId}/cancel`)).body).toEqual({ ok: true, data: { state: "running" } });
  const job = await until(async () => { const j = (await c.get("/jobs")).body.data.recent[0]; return j; });
  expect(job).toMatchObject({ id: jobId, state: "cancelled", error: { code: "cancelled" } });
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
  await rm(pidFile);
  expect((await c.post("/systems/pets/extract")).status).toBe(202);
  c.jobs.cancelAll();
  await until(async () => (await c.get("/jobs")).body.data.running.length === 0);
  const pid2 = Number((await readFile(pidFile, "utf8").catch(() => "0")).trim());
  if (pid2) await until(async () => { try { process.kill(pid2, 0); return false; } catch { return true; } });
});

it("cancel: 없는 id 404, 끝난 작업은 state만 돌려준다", async () => {
  const c = make();
  expect((await c.post("/jobs/nope/cancel")).status).toBe(404);
  await c.post("/systems", { system: "pets", origins: [PETS_MD] });
  await c.post("/systems/pets/analyze");
  const { jobId } = (await c.post("/systems/pets/extract")).body.data;
  await until(async () => (await c.get("/jobs")).body.data.recent[0]);
  expect((await c.post(`/jobs/${jobId}/cancel`)).body).toEqual({ ok: true, data: { state: "done" } });
});

it("없는 시스템에서 시작 → 404, 작업은 남지 않는다", async () => {
  const c = make();
  for (const p of ["extract", "generate", "verify"]) {
    const r = await c.post(`/systems/ghost/${p}`);
    expect(r.status, p).toBe(404);
  }
  expect((await c.get("/jobs")).body.data).toEqual({ running: [], recent: [] });
});

it("OpenAPI 시스템: 생성 작업 → done, 같은 곳에 덮어쓰기 거부는 overwrite-required", async () => {
  const c = make();
  await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
  await c.post("/systems/petstore/analyze");
  const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
  await c.post("/systems/petstore/selection", { ids: [id] });
  const outDir = path.join(root, "out");
  expect((await c.post("/systems/petstore/generate", { outDir })).status).toBe(202);
  const j1 = await until(async () => (await c.get("/jobs")).body.data.recent.find((j: { kind: string }) => j.kind === "generate"));
  expect(j1.state).toBe("done");
  expect(j1.result).toMatchObject({ language: "ts", attempts: 0, notes: [], userModified: [], skipped: false, launch: `cd ${outDir} && npm install && npm start` });
  expect((await c.get("/systems/petstore")).body.data.defaultOutDir).toBe(outDir); // 마지막 생성 위치
  // root는 비어 있지 않고 specmock 표식이 없다
  expect((await c.post("/systems/petstore/generate", { outDir: root })).status).toBe(202);
  const j2 = await until(async () => { const j = (await c.get("/jobs")).body.data.recent.find((x: { kind: string }) => x.kind === "generate"); return j && j.id !== j1.id ? j : undefined; });
  expect(j2).toMatchObject({ state: "failed", error: { code: "overwrite-required" } });
});

it("generate 작업에 cancel → 200, 이미 끝났으면 상태만. cancellable: true", async () => {
  const c = make();
  await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
  await c.post("/systems/petstore/analyze");
  const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
  await c.post("/systems/petstore/selection", { ids: [id] });
  const { jobId } = (await c.post("/systems/petstore/generate", { outDir: path.join(root, "out") })).body.data;
  const r = await c.post(`/jobs/${jobId}/cancel`);
  expect(r.status).toBe(200);
  const j = await until(async () => (await c.get("/jobs")).body.data.recent[0]);
  expect(j).toMatchObject({ kind: "generate", cancellable: true });
  expect(["done", "cancelled"]).toContain(j.state);
});

it("SSE 큐 상한: 넘치면 오래된 job-progress부터 버리고 job-done은 남는다", async () => {
  const made = createApp({ root, webDir: path.join(root, "web"), port: () => 4310, sseQueueLimit: 5 });
  const res = await made.app.request("/api/events", { headers: HOST });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  await sleep(20);
  // 소비자가 못 따라가는 상황: 한 틱 안에서 몰아서 발행
  made.bus.publish("workspace-changed", { system: "a", files: [] });
  for (let i = 0; i < 50; i++) made.bus.publish("job-progress", { n: i });
  made.bus.publish("job-done", { id: "1" });
  let text = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; text += value; if (text.includes("job-done")) break; }
  await reader.cancel();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  expect(events).toContain("workspace-changed");
  expect(events.at(-1)).toBe("job-done");
  expect(events.filter((e) => e === "job-progress").length).toBeLessThan(50);
  const last = [...text.matchAll(/"n":(\d+)/g)].map((m) => Number(m[1]));
  expect(last.at(-1)).toBe(49); // 최신 진행은 남는다
});

it("java 생성: 진행이 job-progress(시도 n/max)로 오고, 시도를 다 쓰면 failed와 마지막 attempt 위치", async () => {
  const c = make("claude-fail");
  await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
  await c.post("/systems/petstore/analyze");
  const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
  await c.post("/systems/petstore/selection", { ids: [id] });
  const progress: unknown[] = [];
  c.bus.subscribe((e) => {
    const d = e.data as { kind?: string; progress?: unknown };
    if (e.event === "job-progress" && d.kind === "generate") progress.push(d.progress);
  });
  const outDir = path.join(root, "out-java");
  expect((await c.post("/systems/petstore/generate", { outDir, language: "java" })).status).toBe(202);
  const j = await until(async () => (await c.get("/jobs")).body.data.recent.find((x: { kind: string }) => x.kind === "generate"), 20_000);
  expect(j).toMatchObject({ state: "failed", input: { outDir, language: "java" }, error: { message: expect.stringContaining("3번 시도했지만 검증을 통과하는 mock을 만들지 못했습니다") } });
  expect(progress).toContainEqual({ message: "코드 생성 중 (1/3)", stage: "generating", done: 1, total: 3 });
  expect(progress.at(-1)).toEqual({ message: "코드 생성 중 (3/3)", stage: "generating", done: 3, total: 3 });
  await expect(readFile(path.join(outDir, "specmock.lock.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
