import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Session } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GITHUB = path.resolve(here, "..", "..", "core", "test", "fixtures", "flow", "github-issues.yaml");
let dir: string; let s: Session;
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-mcp-flow-"))); s = await connect(dir); });
afterEach(async () => { await s.close(); await rm(dir, { recursive: true, force: true }); });

describe("flow tools", () => {
  it("list_flows shows the flows; fill_flow sets an input with basis claude", async () => {
    await s.ok("ingest_spec", { system: "gh", origins: [GITHUB] });
    await s.ok("analyze_spec", { system: "gh" });
    await s.ok("select_features", { system: "gh", exprs: ["all"] });
    expect(await s.err("list_flows", { system: "gh", flowId: "issues" })).toMatch(/알 수 없는 흐름/);
    const list = await s.ok("list_flows", { system: "gh", infer: true });
    expect(list.flows.map((f: { id: string }) => f.id)).toEqual(["repos", "issues"]);
    await s.ok("fill_flow", { system: "gh", flowId: "issues", stepId: "create_issue", slot: "body.title", source: { kind: "user", value: "from claude" } });
    const d = await s.ok("list_flows", { system: "gh", flowId: "issues" });
    const input = d.flow.steps.find((x: { id: string }) => x.id === "create_issue").inputs.find((i: { slot: string }) => i.slot === "body.title");
    expect(input).toEqual({ slot: "body.title", source: { kind: "user", value: "from claude" }, basis: "claude" });
    expect(await s.err("fill_flow", { system: "gh", flowId: "issues", stepId: "create_issue", slot: "body.nope", source: { kind: "empty" } })).toMatch(/알 수 없는 입력 자리/);
  });

  it("without flows: list_flows is empty and fill_flow says to infer first", async () => {
    await s.ok("ingest_spec", { system: "gh", origins: [GITHUB] });
    const empty = await s.ok("list_flows", { system: "gh" });
    expect(empty).toEqual({ inferredAt: null, notes: [], flows: [] });
    expect(await s.err("fill_flow", { system: "gh", flowId: "issues", stepId: "create_issue", slot: "body.title", source: { kind: "empty" } })).toMatch(/흐름이 없습니다/);
    expect(await s.err("list_flows", { system: "gh", infer: true })).toMatch(/먼저 기능을 고르세요/);
  });

  it("fill_flow rejects an unknown flow or step, a forward step source and a malformed source", async () => {
    await s.ok("ingest_spec", { system: "gh", origins: [GITHUB] });
    await s.ok("analyze_spec", { system: "gh" });
    await s.ok("select_features", { system: "gh", exprs: ["all"] });
    await s.ok("list_flows", { system: "gh", infer: true });
    const base = { system: "gh", slot: "body.title", source: { kind: "empty" } };
    expect(await s.err("fill_flow", { ...base, flowId: "nope", stepId: "create_issue" })).toMatch(/알 수 없는 흐름: nope/);
    expect(await s.err("fill_flow", { ...base, flowId: "issues", stepId: "nope" })).toMatch(/알 수 없는 단계: nope/);
    expect(await s.err("fill_flow", { ...base, flowId: "issues", stepId: "create_issue", source: { kind: "step", step: "create_issue", field: "x" } })).toMatch(/앞 단계만/);
    expect(await s.err("fill_flow", { ...base, flowId: "issues", stepId: "create_issue", source: { kind: "bogus" } })).toBeTruthy();
    // 거부된 호출은 flows.json을 바꾸지 않는다
    const d = await s.ok("list_flows", { system: "gh", flowId: "issues" });
    const input = d.flow.steps.find((x: { id: string }) => x.id === "create_issue").inputs.find((i: { slot: string }) => i.slot === "body.title");
    expect(input.basis).toBe("rule");
  });
});
