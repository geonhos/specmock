import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFlows } from "../src/flow/store.js";
import { readFlowRun } from "../src/flow/store.js";
import { runFlowTargets } from "../src/service/flowRun.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { startFakeTarget, type FakeTarget } from "./fakeTarget.js";

let dir: string; let ws: Workspace; let api: FakeTarget;
const spec = MockSpecSchema.parse({ system: "s", baseUrl: "http://x", notMocked: [], assumptions: [],
  features: [{ id: "t_create", group: "g", title: "", summary: "", method: "POST", path: "/tickets", request: { params: {}, query: {}, headers: {}, body: { type: "object" } }, responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], fixtures: [{ status: 201, body: { id: 1 }, source: "empty" }] }],
  contracts: [{ featureId: "t_create", name: "정상 요청", request: { method: "POST", path: "/tickets", headers: {}, query: {}, body: {} }, expect: { status: 201, schema: null } }] });
const flows = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ id: "tickets", name: "ticket 다루기", resource: "ticket", steps: [{ id: "create_ticket", featureId: "t_create", role: "main" as const, creates: "ticket", inputs: [] }] }] };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-flowrun-")); ws = new Workspace(path.join(dir, ".specmock"));
  api = await startFakeTarget(() => ({ status: 201, body: { id: 1 } }));
  await ws.write("s", "mockspec.json", MockSpecSchema, spec);
  await writeFlows(ws, "s", flows);
});
afterEach(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

describe("runFlowTargets", () => {
  it("mock uses the launcher; real uses target.json; both runs are saved", async () => {
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url, headers: { authorization: "Bearer ${TOKEN}" } }));
    let stopped = false;
    const out = await runFlowTargets(ws, "s", "tickets", {
      targets: ["mock", "real"], cleanup: true, safety: false, env: { TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123" },
      launchMock: async () => ({ baseUrl: api.url, stop: async () => { stopped = true; } }),
    });
    expect(out.runs.map((r) => [r.target, r.outcome])).toEqual([["mock", "success"], ["real", "success"]]);
    expect(stopped).toBe(true);
    expect(api.requests[1]!.headers.authorization).toBe("Bearer ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(api.requests[0]!.headers.authorization).toBeUndefined(); // mock gets no real token
    expect((await readFlowRun(ws, "s", "tickets", "real"))!.outcome).toBe("success");
  });
  it("mock launch failure fails only the mock run", async () => {
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url }));
    const out = await runFlowTargets(ws, "s", "tickets", { targets: ["mock", "real"], cleanup: true, safety: false, env: {}, launchMock: async () => { throw new Error("npm install failed"); } });
    expect(out.runs[0]).toMatchObject({ target: "mock", outcome: "failed", error: expect.stringContaining("mock을 먼저 만드세요") });
    expect(out.runs[1]!.outcome).toBe("success");
  });
  it("real without a token fails only the real run", async () => {
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url, headers: { authorization: "Bearer ${TOKEN}" } }));
    const out = await runFlowTargets(ws, "s", "tickets", { targets: ["real"], cleanup: true, safety: false, env: {} });
    expect(out.runs[0]).toMatchObject({ target: "real", outcome: "failed", error: expect.stringContaining("TOKEN") });
  });
  it("unknown flow and missing features throw", async () => {
    await expect(runFlowTargets(ws, "s", "nope", { targets: ["mock"], cleanup: true, safety: true, env: {} })).rejects.toThrow(/알 수 없는 흐름/);
    await ws.write("s", "mockspec.json", MockSpecSchema, { ...spec, features: [], contracts: [] });
    await expect(runFlowTargets(ws, "s", "tickets", { targets: ["mock"], cleanup: true, safety: true, env: {} })).rejects.toThrow(/기능 없음: t_create/);
  });
});
