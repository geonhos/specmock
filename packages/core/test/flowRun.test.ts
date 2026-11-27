import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLOW_AUTH_HINT, NOT_CREATED, runFlow, type FlowTarget } from "../src/flow/run.js";
import type { Flow } from "../src/flow/types.js";
import type { Contract, Feature, MockSpec } from "../src/types.js";
import { startFakeTarget, type FakeReq, type FakeRes, type FakeTarget } from "./fakeTarget.js";

function feature(id: string, method: Feature["method"], p: string): Feature {
  return { id, group: "g", title: id, summary: "", method, path: p, request: { params: {}, query: {}, headers: {}, body: method === "POST" ? { type: "object" } : null },
    responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [] };
}
const contract = (f: Feature, status: number): Contract => ({ featureId: f.id, name: "정상 요청", request: { method: f.method, path: f.path, headers: {}, query: {}, body: f.request.body ? {} : null }, expect: { status, schema: null } });
const F = [
  feature("repos_create", "POST", "/user/repos"), feature("issues_create", "POST", "/repos/{owner}/{repo}/issues"),
  feature("issues_get", "GET", "/repos/{owner}/{repo}/issues/{issue_number}"), feature("repos_delete", "DELETE", "/repos/{owner}/{repo}"),
];
const spec: MockSpec = { system: "gh", baseUrl: "http://x", features: F, notMocked: [], assumptions: [],
  contracts: [contract(F[0]!, 201), contract(F[1]!, 201), contract(F[2]!, 200), contract(F[3]!, 204)] } as MockSpec;

const flow: Flow = { id: "issues", name: "issue 다루기", resource: "issue", steps: [
  { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [{ slot: "body.name", source: { kind: "user", value: "flowtest" }, basis: "user" }] },
  { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
    { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
    { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" },
    { slot: "body.title", source: { kind: "fixed", value: "hello" }, basis: "rule" }] },
  { id: "get_issue", featureId: "issues_get", role: "main", inputs: [
    { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
    { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" },
    { slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" }] },
  { id: "delete_repo", featureId: "repos_delete", role: "cleanup", inputs: [
    { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
    { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" }] },
] };

let t: FakeTarget; let fail: Partial<Record<string, number>> = {};
const NOW = () => new Date("2026-11-26T01:02:03.000Z");
function github(r: FakeReq): FakeRes {
  const key = `${r.method} ${r.path.replace(/\/repos\/[^/]+\/[^/]+/, "/repos/R")}`;
  if (fail[key]) return { status: fail[key]!, body: { message: "Bad credentials" } };
  if (key === "POST /user/repos") { const b = JSON.parse(r.body); return { status: 201, body: { id: 1, name: b.name, url: `https://api.github.test/repos/octo/${b.name}` } }; }
  if (key === "POST /repos/R/issues") return { status: 201, body: { id: 9, number: 7, title: JSON.parse(r.body).title, url: "https://api.github.test/issues/7" } };
  if (key === "GET /repos/R/issues/7") return { status: 200, body: { number: 7 } };
  if (key === "DELETE /repos/R") return { status: 204 };
  return { status: 404, body: { message: "Not Found" } };
}
const target = (over: Partial<FlowTarget> = {}): FlowTarget => ({ name: "real", baseUrl: t.url, headers: { authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123" }, params: { owner: "octo" }, timeoutMs: 5_000, secrets: ["ghp_abcdefghijklmnopqrstuvwxyz0123"], ...over });

beforeEach(async () => { fail = {}; t = await startFakeTarget(github); });
afterEach(async () => { await t.close(); });

describe("runFlow", () => {
  it("passes values between steps, suffixes names, tears down; the issue goes with its repo", async () => {
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.outcome).toBe("success");
    expect(run.suffix).toBe("-20261126010203");
    expect(t.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /user/repos", "POST /repos/octo/flowtest-20261126010203/issues", "GET /repos/octo/flowtest-20261126010203/issues/7", "DELETE /repos/octo/flowtest-20261126010203",
    ]);
    expect(JSON.parse(t.requests[1]!.body)).toEqual({ title: "hello-20261126010203" });
    expect(run.steps.map((s) => s.state)).toEqual(["success", "success", "success", "cleaned"]);
    expect(run.steps[2]!.values).toEqual({ "path.owner": "octo", "path.repo": "flowtest-20261126010203", "path.issue_number": 7 });
    expect(run.leftovers).toEqual([]); // repo를 지우면 그 안의 issue도 지워진다(C6)
    expect(JSON.stringify(run)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(run.steps[0]!.request!.headers.authorization).toBe("***");
  });

  it("safety on (real): non-GET skipped, dependents skipped, nothing deleted", async () => {
    const run = await runFlow(flow, spec, target(), { safety: true, cleanup: true, now: NOW });
    expect(t.requests).toEqual([]);
    expect(run.steps.map((s) => s.state)).toEqual(["skipped-safety", "skipped-safety", "skipped-safety", "skipped-safety"]);
    expect(run.outcome).toBe("stopped");
  });

  it("mock target ignores safety", async () => {
    const run = await runFlow(flow, spec, target({ name: "mock", headers: {}, secrets: [] }), { safety: true, cleanup: true, now: NOW });
    expect(run.steps.map((s) => s.state)).toEqual(["success", "success", "success", "cleaned"]);
  });

  it("401 stops with the token hint, then tears down what was created", async () => {
    fail["POST /repos/R/issues"] = 401;
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.outcome).toBe("failed");
    expect(run.steps.map((s) => s.state)).toEqual(["success", "failed", "pending", "cleaned"]);
    expect(run.steps[1]!.reason).toContain(FLOW_AUTH_HINT);
    expect(t.requests.at(-1)!.method).toBe("DELETE");
  });

  it("cleanup off keeps everything and lists leftovers", async () => {
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: false, now: NOW });
    expect(run.steps[3]!.state).toBe("pending");
    expect(run.leftovers.map((l) => l.stepId)).toEqual(["create_issue", "create_repo"]);
    expect(t.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("failed parent delete: the repo and its issue are both leftovers", async () => {
    fail["DELETE /repos/R"] = 403;
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[3]!.state).toBe("leftover");
    expect(run.leftovers.map((l) => l.stepId)).toEqual(["create_issue", "create_repo"]);
  });

  it("a parent created in this flow is never taken from target params (C6)", async () => {
    const unlinked: Flow = { ...flow, steps: flow.steps.map((s) => s.id !== "create_issue" ? s : { ...s, inputs: s.inputs.map((i) =>
      i.slot === "path.repo" ? { slot: "path.repo", source: { kind: "empty" }, basis: "rule", createdBy: "create_repo" } : i) }) };
    const run = await runFlow(unlinked, spec, target({ params: { owner: "octo", repo: "prod-repo" } }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[1]!.state).toBe("stopped-empty");
    expect(run.steps[1]!.missing).toEqual(["path.repo"]);
    expect(t.requests.some((r) => r.path.includes("prod-repo"))).toBe(false);
    expect(run.steps[3]!.state).toBe("cleaned"); // 만든 repo는 그대로 지운다
  });

  it("DELETE of a resource this run did not create is refused even with safety off", async () => {
    const foreign: Flow = { ...flow, steps: [{ ...flow.steps[3]!, role: "main", inputs: [
      { slot: "path.owner", source: { kind: "empty" }, basis: "rule" }, { slot: "path.repo", source: { kind: "user", value: "prod-repo" }, basis: "user" }] }] };
    const run = await runFlow(foreign, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[0]!.state).toBe("skipped-safety");
    expect(run.steps[0]!.reason).toBe(NOT_CREATED);
    expect(t.requests).toEqual([]);
  });

  it("empty input stops the run and lists the slot", async () => {
    const run = await runFlow(flow, spec, target({ params: {} }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[1]!.state).toBe("stopped-empty");
    expect(run.steps[1]!.missing).toEqual(["path.owner"]);
    expect(run.outcome).toBe("stopped");
    expect(run.steps[3]!.state).toBe("leftover"); // delete_repo also needs owner → cannot tear down
  });

  it("network failure marks the step failed and never throws", async () => {
    const run = await runFlow(flow, spec, target({ baseUrl: "http://127.0.0.1:1" }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[0]!.state).toBe("failed");
    expect(run.outcome).toBe("failed");
  });
});
