import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockSpecSchema, SourceSchema, writeFlows } from "@specmock/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

interface FakeTarget { url: string; requests: { method: string; path: string }[]; close: () => Promise<void> }
/** 요청을 기록하는 가짜 실제 서버. handler가 응답과 지연을 정한다. */
async function startFakeTarget(handler: (r: { method: string; path: string }) => { status: number; body: unknown; delayMs?: number }): Promise<FakeTarget> {
  const requests: { method: string; path: string }[] = [];
  const server: Server = createServer((req, res) => {
    const r = { method: req.method ?? "GET", path: new URL(req.url ?? "/", "http://x").pathname };
    requests.push(r);
    req.resume();
    const out = handler(r);
    setTimeout(() => { res.writeHead(out.status, { "content-type": "application/json" }); res.end(JSON.stringify(out.body)); }, out.delayMs ?? 0);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, requests,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };
let root: string; let api: FakeTarget;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-flowrun-ui-")); });
afterEach(async () => { await api?.close(); await rm(root, { recursive: true, force: true }); });

const feature = (id: string, method: string, p: string) => ({ id, group: "g", title: "", summary: "", method, path: p, request: { params: {}, query: {}, headers: {}, body: method === "POST" ? { type: "object" } : null }, responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], fixtures: [{ status: 200, body: { id: 1 }, source: "empty" }] });
const spec = MockSpecSchema.parse({ system: "s", baseUrl: "http://x", notMocked: [], assumptions: [], features: [feature("t_create", "POST", "/tickets"), feature("t_get", "GET", "/tickets/{id}"), feature("t_list", "GET", "/tickets")],
  contracts: [{ featureId: "t_create", name: "ok", request: { method: "POST", path: "/tickets", headers: {}, query: {}, body: {} }, expect: { status: 201, schema: null } }, { featureId: "t_get", name: "ok", request: { method: "GET", path: "/tickets/1", headers: {}, query: {}, body: null }, expect: { status: 200, schema: null } }, { featureId: "t_list", name: "ok", request: { method: "GET", path: "/tickets", headers: {}, query: {}, body: null }, expect: { status: 200, schema: null } }] });
const flows = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ id: "tickets", name: "ticket", resource: "ticket", steps: [
  { id: "create_ticket", featureId: "t_create", role: "main" as const, creates: "ticket", inputs: [] },
  { id: "get_ticket", featureId: "t_get", role: "main" as const, inputs: [{ slot: "path.id", source: { kind: "step" as const, step: "create_ticket", field: "id" }, basis: "rule" as const }] },
  { id: "list_tickets", featureId: "t_list", role: "main" as const, inputs: [] }] }] };

async function setup(handler: Parameters<typeof startFakeTarget>[0], launch?: boolean) {
  api = await startFakeTarget(handler);
  const calls: string[] = [];
  const { app, ws, jobs } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310,
    ...(launch ? { launchMock: async () => { calls.push("mock"); return { baseUrl: api.url, stop: async () => { calls.push("stop"); } }; } } : {}) });
  await ws.write("s", "source.json", SourceSchema, { system: "s", inputs: [{ kind: "openapi", origin: "x", fetchedAt: "t", contentHash: "h", content: "openapi: 3.0.3\npaths: {}\n" }] });
  await ws.write("s", "mockspec.json", MockSpecSchema, spec);
  await writeFlows(ws, "s", flows);
  await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url }));
  const req = async (method: string, p: string, b?: unknown) => { const r = await app.request(`/api${p}`, { method, headers: HOST, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }); return { status: r.status, body: await r.json() }; };
  const run = async (b: unknown) => { const r = await req("POST", "/systems/s/flows/tickets/run", b); expect(r.status).toBe(202); await jobs.whenIdle(10_000); return jobs.get(r.body.data.jobId)!; };
  return { req, run, jobs, calls };
}
const methods = () => api.requests.map((r) => r.method);

describe("flow run route", () => {
  it("safety on (default): the real run sends only GET; the result carries runs and notRun", async () => {
    const c = await setup(() => ({ status: 200, body: { id: 1 } }));
    const job = await c.run({ targets: ["real"] });
    expect(job).toMatchObject({ kind: "flow", state: "done", cancellable: true });
    expect(job.result).toMatchObject({ runs: [{ target: "real", safety: true }], notRun: [] });
    expect(methods()).toContain("GET"); // 독립 GET 단계(list_tickets)는 실제로 보낸다
    expect(methods().filter((m) => m !== "GET")).toEqual([]);
  });

  it("safety off: the real run sends POST too; the body cannot override the server's switch", async () => {
    const c = await setup(() => ({ status: 201, body: { id: 1 } }));
    await c.req("POST", "/systems/s/safety", { on: false });
    // 화면이 safety:true를 보내도 서버 값(off)을 쓴다. 모르는 키는 무시된다.
    const job = await c.run({ targets: ["real"], safety: true, cleanup: false });
    expect(job.result).toMatchObject({ runs: [{ safety: false, cleanup: false }] });
    expect(methods()).toContain("POST");
  });

  it("safety on: a body with safety:false cannot make the real run send a non-GET", async () => {
    const c = await setup(() => ({ status: 200, body: { id: 1 } }));
    const job = await c.run({ targets: ["real"], safety: false });
    expect(job.result).toMatchObject({ runs: [{ safety: true }] });
    expect(methods()).toContain("GET");
    expect(methods().filter((m) => m !== "GET")).toEqual([]);
  });

  it("mock target uses the launcher and stops it; safety does not apply to mock", async () => {
    const c = await setup(() => ({ status: 201, body: { id: 1 } }), true);
    const job = await c.run({ targets: ["mock"] });
    expect(job.result).toMatchObject({ runs: [{ target: "mock", safety: true }], notRun: [] });
    expect(c.calls).toEqual(["mock", "stop"]);
    expect(methods()).toContain("POST");
  });

  it("cancel: the running target is saved as cancelled and the rest are in notRun", async () => {
    let c!: Awaited<ReturnType<typeof setup>>;
    c = await setup(() => ({ status: 200, body: { id: 1 }, delayMs: 3_000 }), true);
    await c.req("POST", "/systems/s/safety", { on: false }); // 안전장치가 켜져 있으면 POST를 보내지 않아 느린 응답에 걸리지 않는다
    const started = await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["real", "mock"] });
    expect(started.status).toBe(202);
    await vi.waitFor(() => expect(api.requests.length).toBeGreaterThan(0));
    expect((await c.req("POST", `/jobs/${started.body.data.jobId}/cancel`)).status).toBe(200);
    await c.jobs.whenIdle(10_000);
    const job = c.jobs.get(started.body.data.jobId)!;
    expect(job.result).toMatchObject({ runs: [{ target: "real", outcome: "cancelled" }], notRun: ["mock"] });
    expect(c.calls).toEqual([]);
  });

  it("a second run while one is running is 409 busy", async () => {
    const c = await setup(() => ({ status: 200, body: { id: 1 }, delayMs: 2_000 }));
    await c.req("POST", "/systems/s/safety", { on: false });
    const a = await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["real"] });
    await vi.waitFor(() => expect(api.requests.length).toBeGreaterThan(0)); // 첫 요청이 느린 응답에 걸려 있는 동안
    expect(await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["real"] })).toMatchObject({ status: 409, body: { error: { code: "busy" } } });
    await c.req("POST", `/jobs/${a.body.data.jobId}/cancel`);
    await c.jobs.whenIdle(10_000);
  });

  it("request errors: duplicate targets, unknown target, unknown flow, unknown system, empty real base URL", async () => {
    const c = await setup(() => ({ status: 200, body: {} }));
    expect(await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["mock", "mock"] })).toMatchObject({ status: 400, body: { error: { code: "invalid" } } });
    expect((await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["nope"] })).status).toBe(400);
    expect((await c.req("POST", "/systems/s/flows/tickets/run", {})).status).toBe(400);
    expect((await c.req("POST", "/systems/s/flows/nope/run", { targets: ["mock"] })).status).toBe(404);
    expect((await c.req("POST", "/systems/zzz/flows/tickets/run", { targets: ["mock"] })).status).toBeGreaterThanOrEqual(400);
    await writeFile(path.join(root, ".specmock", "s", "target.json"), JSON.stringify({ baseUrl: "" }));
    expect(await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["real"] })).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining("mock 실행은 할 수 있어요") } } });
    expect(api.requests).toHaveLength(0);
  });

  it("run: a flowDetail error that is not 'unknown flow' is not mapped to 404", async () => {
    const c = await setup(() => ({ status: 200, body: {} }));
    await writeFile(path.join(root, ".specmock", "s", "flows.json"), "{ not json");
    const r = await c.req("POST", "/systems/s/flows/tickets/run", { targets: ["mock"] });
    expect(r.status).not.toBe(404);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("other routes: POST-only guard and error responses", async () => {
    const c = await setup(() => ({ status: 200, body: {} }));
    expect((await c.req("GET", "/systems/s/flows/tickets/inputs")).status).toBe(405);
    expect((await c.req("GET", "/systems/s/flows/infer")).status).toBe(405);
    expect((await c.req("POST", "/systems/s/safety", { on: "yes" })).status).toBe(400);
    expect((await c.req("POST", "/systems/zzz/safety", { on: true })).status).toBeGreaterThanOrEqual(400);
    expect((await c.req("GET", "/systems/zzz/flows")).status).toBeGreaterThanOrEqual(400);
    expect((await c.req("POST", "/systems/s/flows/tickets/inputs", { stepId: "x" })).status).toBe(400);
    expect((await c.req("POST", "/systems/s/flows/tickets/inputs", { stepId: "get_ticket", slot: "path.nope", source: { kind: "empty" } })).status).toBe(400);
    expect((await c.req("POST", "/systems/s/flows/nope/inputs", { stepId: "get_ticket", slot: "path.id", source: { kind: "empty" } })).status).toBe(404);
  });
});
