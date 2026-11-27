import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestedBaseUrl } from "../src/flow/baseUrl.js";
import { writeFlowRun, writeFlows } from "../src/flow/store.js";
import { flowDetail, flowSummaries } from "../src/flow/view.js";
import { MockSpecSchema, SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string; let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-view-")); ws = new Workspace(path.join(dir, ".specmock")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const flows = { system: "s", catalogHash: "h", inferredAt: "2026-11-26T00:00:00.000Z", notes: ["n"], flows: [{ id: "issues", name: "issue 다루기", resource: "issue", steps: [
  { id: "create_issue", featureId: "issues_create", role: "main" as const, creates: "issue", inputs: [
    { slot: "path.owner", source: { kind: "empty" as const }, basis: "rule" as const }, { slot: "body.title", source: { kind: "empty" as const }, basis: "rule" as const }] },
  { id: "get_issue", featureId: "issues_get", role: "main" as const, inputs: [] }] }] };
const feature = (id: string) => ({ id, group: "g", title: "", summary: "", method: "GET", path: "/x", request: { params: {}, query: {}, headers: {}, body: null }, responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], fixtures: [{ status: 200, body: null, source: "empty" }] });

describe("flow views", () => {
  it("no flows.json → inferredAt null and an empty list", async () => {
    expect(await flowSummaries(ws, "s")).toEqual({ inferredAt: null, notes: [], flows: [] });
  });
  it("summaries count empty inputs (minus target params), missing features, last outcome per target", async () => {
    await writeFlows(ws, "s", flows);
    await ws.write("s", "mockspec.json", MockSpecSchema, MockSpecSchema.parse({ system: "s", baseUrl: "", notMocked: [], assumptions: [], contracts: [], features: [feature("issues_create")] }));
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: "https://api.github.com", params: { owner: "octo" } }));
    await writeFlowRun(ws, "s", { flowId: "issues", target: "mock", startedAt: "a", finishedAt: "b", safety: true, cleanup: true, suffix: "", outcome: "diff", error: null, steps: [], leftovers: [] });
    expect(await flowSummaries(ws, "s")).toEqual({ inferredAt: "2026-11-26T00:00:00.000Z", notes: ["n"], flows: [
      { id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: ["issues_get"], last: { mock: "diff", real: null } }] });
    const d = await flowDetail(ws, "s", "issues");
    expect(d.empty).toEqual(["create_issue:body.title"]);
    expect(d.runs.mock!.outcome).toBe("diff");
    await expect(flowDetail(ws, "s", "nope")).rejects.toThrow(/알 수 없는 흐름: nope/);
  });
  it("suggestedBaseUrl reads servers[0] (v3) or scheme+host+basePath (v2) from source.json", async () => {
    const put = (content: string) => ws.write("s", "source.json", SourceSchema, { system: "s", inputs: [{ kind: "openapi", origin: "x", fetchedAt: "t", contentHash: "h", content }] });
    await put("openapi: 3.0.3\nservers: [{ url: https://api.github.com/ }]\npaths: {}\n");
    expect(await suggestedBaseUrl(ws, "s")).toBe("https://api.github.com");
    await put(JSON.stringify({ swagger: "2.0", host: "petstore.swagger.io", basePath: "/v2", schemes: ["https"], paths: {} }));
    expect(await suggestedBaseUrl(ws, "s")).toBe("https://petstore.swagger.io/v2");
    await put("openapi: 3.0.3\nservers: [{ url: /relative }]\npaths: {}\n");
    expect(await suggestedBaseUrl(ws, "s")).toBeNull();
  });
});
