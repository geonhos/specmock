import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_LEFT, CLEANUP_OFF, FLOW_AUTH_HINT, NOT_CREATED, SAFETY_SKIP, runFlow, type FlowTarget } from "../src/flow/run.js";
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
  contracts: [contract(F[0]!, 201), contract(F[1]!, 201), contract(F[2]!, 200), contract(F[3]!, 204)] } as unknown as MockSpec;

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

const serve = async (h: (r: FakeReq) => FakeRes | undefined) => { await t.close(); t = await startFakeTarget((r) => h(r) ?? github(r)); };

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

  it("DELETE whose last path input points at a non-creating step is refused (no request)", async () => {
    const bad: Flow = { ...flow, steps: [...flow.steps.filter((s) => s.role !== "cleanup"), { id: "bad_delete", featureId: "repos_delete", role: "main", inputs: [
      { slot: "path.owner", source: { kind: "empty" }, basis: "rule" }, { slot: "path.repo", source: { kind: "step", step: "get_issue", field: "number" }, basis: "rule" }] }] };
    const run = await runFlow(bad, spec, target(), { safety: false, cleanup: true, now: NOW });
    const del = run.steps.find((s) => s.stepId === "bad_delete")!;
    expect(run.steps.find((s) => s.stepId === "get_issue")!.state).toBe("success");
    expect(del.state).toBe("skipped-safety");
    expect(del.reason).toBe(NOT_CREATED);
    expect(t.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("DELETE pointing at a creating step that has not produced a resource is refused (no request)", async () => {
    const early: Flow = { ...flow, steps: [{ id: "early_delete", featureId: "repos_delete", role: "main", inputs: [
      { slot: "path.owner", source: { kind: "empty" }, basis: "rule" }, { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "rule" }] },
      flow.steps[0]!] };
    const run = await runFlow(early, spec, target(), { safety: false, cleanup: false, now: NOW });
    expect(run.steps[0]!.state).toBe("skipped-safety");
    expect(run.steps[0]!.reason).toBe(NOT_CREATED);
    expect(t.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("a failed create halts the run, so a later DELETE on it never reaches the target", async () => {
    fail["POST /user/repos"] = 500;
    const run = await runFlow({ ...flow, steps: [flow.steps[0]!, { ...flow.steps[3]!, role: "main" }] }, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "pending"]);
    expect(t.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("safety check comes before the empty-input check (user decision 14)", async () => {
    const solo: Flow = { ...flow, steps: [{ ...flow.steps[1]!, inputs: flow.steps[1]!.inputs.map((i) =>
      i.slot === "path.repo" ? { slot: "path.repo", source: { kind: "user", value: "prod-repo" }, basis: "user" } : i) }] };
    const run = await runFlow(solo, spec, target({ params: {} }), { safety: true, cleanup: true, now: NOW });
    expect(run.steps[0]!.state).toBe("skipped-safety");
    expect(run.steps[0]!.reason).toBe(SAFETY_SKIP);
    expect(run.steps[0]!.missing).toEqual([]);
    const all = await runFlow(flow, spec, target({ params: {} }), { safety: true, cleanup: true, now: NOW });
    expect(all.steps.map((s) => s.state)).toEqual(["skipped-safety", "skipped-safety", "skipped-safety", "skipped-safety"]);
    expect(all.steps.every((s) => s.missing.length === 0)).toBe(true);
    expect(all.outcome).toBe("stopped");
    expect(t.requests).toEqual([]);
  });

  describe("secrets never reach the result", () => {
    const TOK1 = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const TOK2 = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
    const secrets = [TOK1, TOK2];
    const tokenFlow: Flow = { ...flow, steps: flow.steps.map((s) => s.id !== "create_repo" ? s : { ...s, inputs: [{ slot: "body.name", source: { kind: "user", value: `flowtest-${TOK1}` }, basis: "user" }] }) };
    const echoing = (r: FakeReq): FakeRes | undefined => {
      const key = `${r.method} ${r.path.replace(/\/repos\/[^/]+\/[^/]+/, "/repos/R")}`;
      const base = github(r);
      if (key === "POST /user/repos") return { status: 201, body: { ...(base.body as object), note: `${TOK1} and ${TOK2}`, nested: [{ t: TOK2 }] } };
      if (key === "POST /repos/R/issues") return { status: 201, body: { ...(base.body as object), echo: `Bearer ${TOK2}` } };
      return undefined;
    };

    it("masks values, request, response bodies, URLs and leftovers (JSON and raw failures)", async () => {
      await serve((r) => r.method === "GET" ? { status: 401, raw: `denied ${TOK2} / ${TOK1}`, contentType: "text/plain" } : echoing(r));
      const run = await runFlow(tokenFlow, spec, target({ secrets }), { safety: false, cleanup: false, now: NOW });
      const text = JSON.stringify(run);
      expect(t.requests[0]!.body).toContain(TOK1); // the target really received it
      for (const tok of secrets) expect(text).not.toContain(tok);
      expect(run.steps[0]!.values["body.name"]).toContain("***");
      expect(JSON.stringify(run.steps[0]!.request!.body)).not.toContain(TOK1);
      expect(JSON.stringify(run.steps[0]!.response!.body)).toContain("***");
      expect(run.steps[2]!.state).toBe("failed");
      expect(JSON.stringify(run.steps[2]!.response!.body)).toContain("***");
      expect(run.leftovers.length).toBe(2);
    });

    it("masks JSON error bodies and the failure reason (token in the base URL userinfo)", async () => {
      await serve((r) => r.method === "POST" && r.path.endsWith("/issues") ? { status: 401, body: { message: `Bad credentials ${TOK2}`, token: TOK1 } } : echoing(r));
      const bad = await runFlow(tokenFlow, spec, target({ secrets }), { safety: false, cleanup: true, now: NOW });
      expect(bad.steps[1]!.state).toBe("failed");
      expect(JSON.stringify(bad.steps[1]!.response!.body)).not.toMatch(/ghp_|github_pat_/);
      for (const tok of secrets) expect(JSON.stringify(bad)).not.toContain(tok);
      const u = new URL(t.url); u.username = "user"; u.password = TOK1;
      const net = await runFlow(tokenFlow, spec, target({ secrets, baseUrl: u.toString().replace(/\/$/, "") }), { safety: false, cleanup: true, now: NOW });
      expect(net.steps[0]!.state).toBe("failed");
      expect(net.steps[0]!.reason).toContain("***");
      expect(JSON.stringify(net)).not.toContain(TOK1);
      expect(net.steps[0]!.request!.url).toContain("***");
    });
  });

  it("a schema mismatch is a diff, not a failure: later steps still run and the outcome is diff", async () => {
    const strict: MockSpec = { ...spec, contracts: spec.contracts.map((c) => c.featureId === "issues_create" ? { ...c, expect: { status: 201, schema: { type: "object", required: ["nope"] } } } : c) };
    const run = await runFlow(flow, strict, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.steps.map((s) => s.state)).toEqual(["success", "diff", "success", "cleaned"]);
    expect(run.steps[1]!.schemaErrors.length).toBeGreaterThan(0);
    expect(run.outcome).toBe("diff");
    expect(t.requests.map((r) => r.method)).toEqual(["POST", "POST", "GET", "DELETE"]);
  });

  it("tears down in reverse creation order: the issue before its repo", async () => {
    const del = feature("issues_delete", "DELETE", "/repos/{owner}/{repo}/issues/{issue_number}");
    const spec2: MockSpec = { ...spec, features: [...F, del], contracts: [...spec.contracts, contract(del, 204)] } as unknown as MockSpec;
    const issueDelete: Flow["steps"][number] = { id: "delete_issue", featureId: "issues_delete", role: "cleanup", inputs: [
      { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
      { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "rule", createdBy: "create_repo" },
      { slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" }] };
    const two: Flow = { ...flow, steps: [...flow.steps, issueDelete] }; // delete_repo is listed before delete_issue on purpose
    await serve((r) => r.method === "DELETE" && r.path.endsWith("/issues/7") ? { status: 204 } : undefined);
    const run = await runFlow(two, spec2, target(), { safety: false, cleanup: true, now: NOW });
    expect(t.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
      "/repos/octo/flowtest-20261126010203/issues/7", "/repos/octo/flowtest-20261126010203"]);
    expect(run.steps.map((s) => s.state)).toEqual(["success", "success", "success", "cleaned", "cleaned"]);
    expect(run.leftovers).toEqual([]);
  });

  it("network failure marks the step failed and never throws", async () => {
    const run = await runFlow(flow, spec, target({ baseUrl: "http://127.0.0.1:1" }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[0]!.state).toBe("failed");
    expect(run.outcome).toBe("failed");
  });
  describe("cancel (user decision 17: clean up and save)", () => {
    const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const issueDelete: Flow["steps"][number] = { id: "delete_issue", featureId: "issues_delete", role: "cleanup", inputs: [
      { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
      { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "rule", createdBy: "create_repo" },
      { slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" }] };
    const del = feature("issues_delete", "DELETE", "/repos/{owner}/{repo}/issues/{issue_number}");
    const spec2: MockSpec = { ...spec, features: [...F, del], contracts: [...spec.contracts, contract(del, 204)] } as unknown as MockSpec;
    const two: Flow = { ...flow, steps: [...flow.steps, issueDelete] };
    const methods = () => t.requests.map((r) => `${r.method} ${r.path.replace(/flowtest-\d+/, "R")}`);

    afterEach(() => { vi.restoreAllMocks(); });

    it("cancel between two steps: no later step is sent, the created repo is deleted, the run is returned", async () => {
      const ac = new AbortController();
      const orig = globalThis.fetch; let calls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...a: Parameters<typeof fetch>) => {
        const res = await orig(...a);
        if (++calls !== 1) return res;
        const buf = await res.arrayBuffer(); ac.abort(); // the first response is fully read, then the cancel arrives
        return new Response(buf, { status: res.status, headers: res.headers });
      });
      const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW, signal: ac.signal });
      expect(methods()).toEqual(["POST /user/repos", "DELETE /repos/octo/R"]);
      expect(run.outcome).toBe("cancelled");
      expect(run.steps.map((s) => s.state)).toEqual(["success", "pending", "pending", "cleaned"]);
      expect(run.leftovers).toEqual([]);
    });

    it("cancel while a request is in flight: that step is failed 'cancelled', earlier resources are deleted", async () => {
      const ac = new AbortController();
      await serve((r) => r.method === "POST" && r.path.endsWith("/issues") ? (setTimeout(() => ac.abort(), 30), { status: 201, body: { number: 7 }, delayMs: 3_000 }) : undefined);
      const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW, signal: ac.signal });
      expect(methods()).toEqual(["POST /user/repos", "POST /repos/octo/R/issues", "DELETE /repos/octo/R"]);
      expect(run.outcome).toBe("cancelled");
      expect(run.steps.map((s) => s.state)).toEqual(["success", "failed", "pending", "cleaned"]);
      expect(run.steps[1]!.reason).toContain("취소");
      expect(run.steps[1]!.reason).toContain("만들어졌는지 알 수 없어"); // create response unknown: noted, no invented id
      expect(run.steps[2]!.reason).toContain("취소");
      expect(run.leftovers).toEqual([]);
    });

    it("cleanup off + cancel: nothing is deleted, the created repo is a leftover", async () => {
      const ac = new AbortController();
      await serve((r) => r.method === "POST" && r.path.endsWith("/issues") ? (setTimeout(() => ac.abort(), 30), { status: 201, body: { number: 7 }, delayMs: 3_000 }) : undefined);
      const run = await runFlow(flow, spec, target(), { safety: false, cleanup: false, now: NOW, signal: ac.signal });
      expect(t.requests.some((r) => r.method === "DELETE")).toBe(false);
      expect(run.outcome).toBe("cancelled");
      expect(run.leftovers.map((l) => [l.resource, l.reason])).toEqual([["repo", CLEANUP_OFF]]);
    });

    it("cancel during cleanup: the remaining resources are leftovers, the run is still returned", async () => {
      const ac = new AbortController();
      await serve((r) => r.method === "DELETE" && r.path.endsWith("/issues/7") ? (setTimeout(() => ac.abort(), 5), { status: 204, delayMs: 40 }) : undefined);
      const run = await runFlow(two, spec2, target(), { safety: false, cleanup: true, now: NOW, signal: ac.signal });
      expect(t.requests.filter((r) => r.method === "DELETE").map((r) => r.path.replace(/flowtest-\d+/, "R"))).toEqual(["/repos/octo/R/issues/7"]);
      expect(run.outcome).toBe("cancelled");
      expect(run.steps.map((s) => s.state)).toEqual(["success", "success", "success", "leftover", "cleaned"]);
      expect(run.leftovers.map((l) => [l.resource, l.reason])).toEqual([["repo", CANCELLED_LEFT]]);
    });

    it("the result of a cancelled run holds no token", async () => {
      const ac = new AbortController();
      await serve((r) => r.method === "POST" && r.path.endsWith("/issues") ? (setTimeout(() => ac.abort(), 30), { status: 201, delayMs: 3_000 }) : undefined);
      const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW, signal: ac.signal });
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    });
  });
});
