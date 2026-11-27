import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptySlots, FLOWS_FILE, missingFeatures, readFlows, setInput, writeFlows } from "../src/flow/store.js";
import type { Flow, FlowsFile } from "../src/flow/types.js";
import { Workspace } from "../src/workspace.js";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { inferFlowsForSystem } from "../src/service/flow.js";
import { fileURLToPath } from "node:url";

let dir: string; let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-flow-")); ws = new Workspace(path.join(dir, ".specmock")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const empty = { kind: "empty" } as const;
const flow: Flow = { id: "issues", name: "issue 다루기", resource: "issue", steps: [
  { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [
    { slot: "body.name", source: empty, basis: "rule" },
  ] },
  { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
    { slot: "path.owner", source: empty, basis: "rule" },
    { slot: "path.repo", source: empty, basis: "rule", createdBy: "create_repo" },
    { slot: "body.title", source: empty, basis: "rule" },
  ] },
  { id: "get_issue", featureId: "issues_get", role: "main", inputs: [
    { slot: "path.owner", source: empty, basis: "rule" },
    { slot: "path.repo", source: empty, basis: "rule", createdBy: "create_repo" },
    { slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" },
  ] },
] };
const file: FlowsFile = { system: "gh", catalogHash: "h", inferredAt: "2026-11-26T00:00:00.000Z", flows: [flow], notes: [] };
const inputOf = (f: FlowsFile, stepId: string, slot: string) => f.flows[0]!.steps.find((s) => s.id === stepId)!.inputs.find((i) => i.slot === slot);

describe("flow store", () => {
  it("writes and reads flows.json", async () => {
    expect(await readFlows(ws, "gh")).toBeNull();
    await writeFlows(ws, "gh", file);
    expect(await readFlows(ws, "gh")).toEqual(file);
    expect(JSON.parse(await readFile(ws.file("gh", FLOWS_FILE), "utf8")).flows[0].id).toBe("issues");
  });
  it("setInput replaces one slot with the given basis; unknown ids throw", () => {
    const next = setInput(file, "issues", "create_issue", "body.title", { kind: "user", value: "flow test" }, "user");
    expect(inputOf(next, "create_issue", "body.title")).toEqual({ slot: "body.title", source: { kind: "user", value: "flow test" }, basis: "user" });
    expect(inputOf(file, "create_issue", "body.title")!.source).toEqual({ kind: "empty" }); // 원본 불변
    expect(() => setInput(file, "nope", "create_issue", "body.title", { kind: "empty" }, "user")).toThrow(/알 수 없는 흐름: nope/);
    expect(() => setInput(file, "issues", "x", "body.title", { kind: "empty" }, "user")).toThrow(/알 수 없는 단계: x/);
    expect(() => setInput(file, "issues", "create_issue", "body.nope", { kind: "empty" }, "user")).toThrow(/알 수 없는 입력 자리: body.nope/);
    expect(() => setInput(file, "issues", "get_issue", "path.issue_number", { kind: "step", step: "get_issue", field: "id" }, "user")).toThrow(/앞 단계만 고를 수 있습니다/);
  });
  it("emptySlots: target params cover only path variables no step of the flow creates (C6)", () => {
    expect(emptySlots(flow, {})).toEqual([
      "create_repo:body.name", "create_issue:path.owner", "create_issue:path.repo", "create_issue:body.title", "get_issue:path.owner", "get_issue:path.repo",
    ]);
    // repo는 params에 있어도 create_repo가 이 흐름에서 만드므로 계속 빈 자리로 센다
    expect(emptySlots(flow, { owner: "octo", repo: "prod-repo" })).toEqual(["create_repo:body.name", "create_issue:path.repo", "create_issue:body.title", "get_issue:path.repo"]);
  });
  it("linking a created parent once fills the same slot in the other steps that are still empty", () => {
    const link = { kind: "step", step: "create_repo", field: "name" } as const;
    const next = setInput(file, "issues", "create_issue", "path.repo", link, "user");
    for (const id of ["create_issue", "get_issue"]) expect(inputOf(next, id, "path.repo")).toEqual({ slot: "path.repo", source: link, basis: "user", createdBy: "create_repo" });
    expect(emptySlots(next.flows[0]!, { owner: "octo" })).toEqual(["create_repo:body.name", "create_issue:body.title"]);
    // 이미 채운 자리는 덮지 않고, 사용자 값은 퍼뜨리지 않는다
    const manual = setInput(file, "issues", "get_issue", "path.repo", { kind: "user", value: "other" }, "user");
    expect(inputOf(setInput(manual, "issues", "create_issue", "path.repo", link, "claude"), "get_issue", "path.repo")!.source).toEqual({ kind: "user", value: "other" });
    expect(inputOf(setInput(file, "issues", "create_issue", "path.repo", { kind: "user", value: "x" }, "user"), "get_issue", "path.repo")!.source).toEqual(empty);
  });
  it("propagation needs the same creating step: same slot name with another createdBy stays empty", () => {
    const nested: Flow = { id: "cards", name: "card 다루기", resource: "card", steps: [
      { id: "create_project", featureId: "p_create", role: "prep", creates: "project", inputs: [] },
      { id: "get_project", featureId: "p_get", role: "prep", inputs: [{ slot: "path.id", source: empty, basis: "rule", createdBy: "create_project" }] },
      { id: "create_card", featureId: "c_create", role: "main", creates: "card", inputs: [] },
      { id: "get_card", featureId: "c_get", role: "main", inputs: [{ slot: "path.id", source: empty, basis: "rule", createdBy: "create_card" }] },
      { id: "update_card", featureId: "c_update", role: "main", inputs: [{ slot: "path.id", source: empty, basis: "rule", createdBy: "create_card" }] },
    ] };
    const f: FlowsFile = { ...file, flows: [nested] };
    const link = { kind: "step", step: "create_card", field: "id" } as const;
    const next = setInput(f, "cards", "get_card", "path.id", link, "user");
    const at = (id: string) => next.flows[0]!.steps.find((s) => s.id === id)!.inputs[0]!;
    expect(at("update_card").source).toEqual(link);
    expect(at("get_project").source).toEqual(empty);
  });
  it("missingFeatures lists feature ids absent from the selection", () => {
    expect(missingFeatures(flow, new Set(["issues_create"]))).toEqual(["repos_create", "issues_get"]);
  });
});

const GITHUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "flow", "github-issues.yaml");

describe("inferFlowsForSystem", () => {
  it("infers from the selected features only and keeps user inputs on re-infer", async () => {
    await ingest(ws, "gh", [GITHUB]);
    await analyze(ws, "gh");
    await select(ws, "gh", ["issues_*"]); // glob over ids; operationId `issues/create` → `issues_create`
    const first = await inferFlowsForSystem(ws, "gh");
    expect(first.flows.map((f) => f.id)).toEqual(["issues"]);
    expect(first.flows[0]!.steps.some((s) => s.role === "prep")).toBe(false); // repos 기능은 고르지 않음
    await writeFlows(ws, "gh", setInput(first, "issues", "create_issue", "body.title", { kind: "user", value: "t" }, "user"));
    const again = await inferFlowsForSystem(ws, "gh");
    expect(again.flows[0]!.steps[0]!.inputs.find((i) => i.slot === "body.title")!.source).toEqual({ kind: "user", value: "t" });
  });
  it("throws a fix-it message before selection", async () => {
    await ingest(ws, "gh", [GITHUB]);
    await analyze(ws, "gh");
    await expect(inferFlowsForSystem(ws, "gh")).rejects.toThrow(/먼저 기능을 고르세요/);
  });
});
