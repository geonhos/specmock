import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { analyzeOpenApiDocument } from "../src/analyze/openapi.js";
import { inferFlows, linkField, mergeFlows, parseResourcePath, responseProperties, singular } from "../src/flow/infer.js";
import { dereferenceOpenApi } from "../src/ingest/openapi.js";
import { FLOW_ID, FlowsFileSchema, type Flow, type FlowsFile } from "../src/flow/types.js";
import type { Feature } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GITHUB = path.join(here, "fixtures", "flow", "github-issues.yaml");

/** 작은 가짜 기능. responses["201"]의 최상위 속성만 정한다. */
function feat(method: Feature["method"], p: string, props: Record<string, unknown> = {}, body: Feature["request"]["body"] = null): Feature {
  const params = Object.fromEntries([...p.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, { schema: { type: "string" }, required: true }]));
  return {
    id: `${method.toLowerCase()}${p.replace(/[^A-Za-z0-9]+/g, "_")}`, group: "g", title: "", summary: "", method, path: p,
    request: { params, query: {}, headers: {}, body }, responses: { [method === "POST" ? "201" : "200"]: { schema: { type: "object", properties: props }, examples: [] } },
    auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
  };
}

describe("parseResourcePath / singular", () => {
  it("finds the resource as the last static segment and the kind", () => {
    expect(parseResourcePath("/repos/{owner}/{repo}/issues/{issue_number}")).toEqual({ resource: "issues", kind: "item", params: ["issue_number"], prefix: "/repos/{}/{}/issues" });
    expect(parseResourcePath("/repos/{owner}/{repo}/issues")).toEqual({ resource: "issues", kind: "list", params: [], prefix: "/repos/{}/{}/issues" });
    expect(parseResourcePath("/repos/{owner}/{repo}")).toEqual({ resource: "repos", kind: "item", params: ["owner", "repo"], prefix: "/repos" });
    expect(parseResourcePath("/{id}")).toBeNull();
  });
  it("singular", () => {
    expect(singular("issues")).toBe("issue");
    expect(singular("repositories")).toBe("repository");
    expect(singular("status")).toBe("statu"); // 단순 규칙(문서화된 한계): 끝 s만 뗀다
  });
});

describe("linkField (R4, R5)", () => {
  const create = feat("POST", "/issues", { id: { type: "integer" }, node_id: { type: "string" }, number: { type: "integer" }, owner: { type: "object" } });
  it("strips the resource prefix and matches exactly one scalar field", () => {
    expect(linkField("issue_number", "issue", create)).toBe("number");
  });
  it("{id} and {<s>_id} map to id", () => {
    expect(linkField("id", "issue", create)).toBe("id");
    expect(linkField("issue_id", "issue", create)).toBe("id");
  });
  it("no candidate, object candidate, or the singular name itself → null", () => {
    expect(linkField("slug", "issue", create)).toBeNull();
    expect(linkField("owner", "issue", create)).toBeNull();
    expect(linkField("issue", "issue", create)).toBeNull();
  });
  it("two candidates after normalization → null", () => {
    const two = feat("POST", "/things", { number: { type: "integer" }, Number: { type: "string" } });
    expect(linkField("thing_number", "thing", two)).toBeNull();
  });
  it("reads candidate fields through allOf (measured: GitHub issue responses)", () => {
    const viaAllOf = feat("POST", "/issues");
    viaAllOf.responses["201"]!.schema = { type: "object", properties: {}, allOf: [
      { type: "object", properties: { id: { type: "integer" }, number: { type: "integer" } } },
      { allOf: [{ type: "object", properties: { html_url: { type: "string" } } }] },
    ] };
    expect(Object.keys(responseProperties(viaAllOf.responses["201"]!.schema))).toEqual(["id", "number", "html_url"]);
    expect(linkField("issue_number", "issue", viaAllOf)).toBe("number");
    expect(linkField("id", "issue", viaAllOf)).toBe("id");
  });
});

describe("inferFlows", () => {
  it("R2 parent before child, R3 skeleton with prep and cleanup", () => {
    const fs = [
      feat("POST", "/projects", { id: { type: "integer" } }),
      feat("DELETE", "/projects/{project_id}"),
      feat("POST", "/projects/{project_id}/cards", { id: { type: "integer" } }),
      feat("GET", "/projects/{project_id}/cards/{card_id}"),
      feat("PATCH", "/projects/{project_id}/cards/{card_id}"),
      feat("PUT", "/projects/{project_id}/cards/{card_id}"),
    ];
    const { flows } = inferFlows(fs);
    expect(flows.map((f) => f.id)).toEqual(["projects", "cards"]);
    const cards = flows[1]!;
    expect(cards.steps.map((s) => [s.id, s.role])).toEqual([
      ["create_project", "prep"], ["create_card", "main"], ["get_card", "main"], ["update_card", "main"], ["update_card_2", "main"], ["delete_project", "cleanup"],
    ]);
    expect(cards.steps[2]!.inputs).toEqual([
      { slot: "path.project_id", source: { kind: "step", step: "create_project", field: "id" }, basis: "rule", createdBy: "create_project" },
      { slot: "path.card_id", source: { kind: "step", step: "create_card", field: "id" }, basis: "rule", createdBy: "create_card" },
    ]);
    expect(cards.steps[0]!.creates).toBe("project");
  });

  it("R6 body: required fields only, example → fixed, otherwise empty", () => {
    const body = { type: "object", required: ["title", "kind"], properties: { title: { type: "string" }, kind: { type: "string", example: "bug" }, extra: { type: "string", example: "x" } } };
    const { flows } = inferFlows([feat("POST", "/tickets", { id: { type: "integer" } }, body)]);
    expect(flows[0]!.steps[0]!.inputs).toEqual([
      { slot: "body.title", source: { kind: "empty" }, basis: "rule" },
      { slot: "body.kind", source: { kind: "fixed", value: "bug" }, basis: "rule" },
    ]);
  });

  it("no create among the selection → no flows and a note", () => {
    const r = inferFlows([feat("GET", "/tickets/{id}")]);
    expect(r.flows).toEqual([]);
    expect(r.notes).toContain("tickets: 생성 기능(목록 경로의 POST)이 선택에 없어 흐름을 만들지 않았습니다.");
  });

  it("GitHub-like spec: issues flow as the spec expects (§2 '예상하는 결과')", async () => {
    // ingest와 같은 순서: dereference 뒤 analyze(analyzeOpenApiDocument는 $ref를 풀지 않는다, src/analyze/openapi.ts:17)
    const doc = await dereferenceOpenApi(GITHUB, YAML.parse(await readFile(GITHUB, "utf8")));
    const features = analyzeOpenApiDocument(doc as never);
    const at = new Map(features.map((f) => [f.id, `${f.method} ${f.path}`]));
    const { flows, notes } = inferFlows(features);
    expect(flows.map((f) => [f.id, f.name, f.resource])).toEqual([["repos", "repo 다루기", "repo"], ["issues", "issue 다루기", "issue"]]);
    const issues = flows[1]!;
    expect(issues.steps.map((s) => [s.id, s.role, at.get(s.featureId), s.creates ?? null])).toEqual([
      ["create_repo", "prep", "POST /user/repos", "repo"],
      ["create_issue", "main", "POST /repos/{owner}/{repo}/issues", "issue"],
      ["get_issue", "main", "GET /repos/{owner}/{repo}/issues/{issue_number}", null],
      ["update_issue", "main", "PATCH /repos/{owner}/{repo}/issues/{issue_number}", null],
      ["delete_repo", "cleanup", "DELETE /repos/{owner}/{repo}", null],
    ]);
    const input = (stepId: string, slot: string) => issues.steps.find((s) => s.id === stepId)!.inputs.find((i) => i.slot === slot)!;
    // issue_number: create_issue 응답이 allOf라도 number를 찾는다
    expect(input("get_issue", "path.issue_number")).toEqual({ slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" });
    // owner: 어느 단계도 만들지 않는다 → createdBy 없음, target.params가 채운다
    expect(input("create_issue", "path.owner")).toEqual({ slot: "path.owner", source: { kind: "empty" }, basis: "rule" });
    // repo: create_repo가 만든다(C6) → 후보가 하나가 아니라 empty로 두고 createdBy를 남긴다
    for (const id of ["create_issue", "get_issue", "update_issue", "delete_repo"]) {
      expect(input(id, "path.repo")).toEqual({ slot: "path.repo", source: { kind: "empty" }, basis: "rule", createdBy: "create_repo" });
    }
    expect(input("create_issue", "body.title").source).toEqual({ kind: "empty" });
    expect(input("create_repo", "body.name").source).toEqual({ kind: "empty" });
    expect(notes).toContain('issue: 삭제 기능이 없어 상위 자원 repo을(를) 지울 때 함께 지워진다고 봅니다. 상위 삭제가 실패하거나 정리를 끄면 "남은 자원"으로 알립니다.');
  });
});

const asFile = (flows: ReturnType<typeof inferFlows>["flows"]) => ({ system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows });

describe("inferFlows ids from raw path segments", () => {
  it("keeps the file valid for segments with . : @ { }", () => {
    const cases: Feature[][] = [
      [feat("POST", "/chat.postMessage", { ts: { type: "string" } })],
      [feat("POST", "/v1/{name}:cancel", { id: { type: "string" } })],
      [feat("POST", "/a/x.y", { id: { type: "string" } }), feat("POST", "/b/x.y", { id: { type: "string" } })],
    ];
    for (const features of cases) {
      const { flows } = inferFlows(features);
      expect(flows.length).toBeGreaterThan(0);
      expect(FlowsFileSchema.safeParse(asFile(flows)).success).toBe(true);
    }
  });
  it("gives distinct ids when different segments sanitize to the same id", () => {
    const { flows } = inferFlows([feat("POST", "/a/x.y", { id: { type: "string" } }), feat("POST", "/b/x_y", { id: { type: "string" } }), feat("POST", "/c/x:y", { id: { type: "string" } })]);
    const ids = flows.map((f) => f.id);
    expect(ids).toEqual(["x_y", "x_y_2", "x_y_3"]);
    for (const f of flows) expect(f.steps.map((s) => s.id)).toEqual(["create_x_y"]);
    expect(flows.map((f) => f.resource)).toEqual(["x.y", "x_y", "x:y"]); // 사람이 읽는 이름은 그대로
  });
  it("makes step ids unique within a flow after sanitizing", () => {
    const { flows } = inferFlows([
      feat("POST", "/a/{a_id}/x.y", { id: { type: "string" } }), feat("POST", "/a", { id: { type: "string" } }),
      feat("POST", "/a/{a_id}/x_y", { id: { type: "string" } }),
    ]);
    for (const f of flows) expect(new Set(f.steps.map((s) => s.id)).size).toBe(f.steps.length);
    expect(FlowsFileSchema.safeParse(asFile(flows)).success).toBe(true);
  });
  it("every flow id and step id matches FLOW_ID for odd paths", () => {
    const paths = ["/chat.postMessage", "/v1/{name}:cancel", "/@me/items", "/x.y/{id}/z.w", "/a%20b", "/{p}/ä", "/m/{id}:verb"];
    for (const p of paths) {
      const { flows } = inferFlows([feat("POST", p, { id: { type: "string" } }), feat("GET", `${p === "/m/{id}:verb" ? "/m" : p}/{id}`), feat("DELETE", `${p === "/m/{id}:verb" ? "/m" : p}/{id}`)]);
      for (const f of flows) {
        expect(f.id).toMatch(FLOW_ID);
        for (const s of f.steps) expect(s.id).toMatch(FLOW_ID);
      }
      expect(FlowsFileSchema.safeParse(asFile(flows)).success).toBe(true);
    }
  });
});

describe("mergeFlows (re-inference keeps claude/user inputs)", () => {
  it("keeps claude and user inputs by flow+step+slot, replaces rule inputs", () => {
    const next = inferFlows([feat("POST", "/tickets", { id: { type: "integer" } }, { type: "object", required: ["title"], properties: { title: { type: "string" } } })]);
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ ...next.flows[0]!, steps: [{ ...next.flows[0]!.steps[0]!, inputs: [{ slot: "body.title", source: { kind: "user", value: "hello" }, basis: "user" }] }] }] };
    const merged = mergeFlows(prev, next.flows);
    expect(merged[0]!.steps[0]!.inputs).toEqual([{ slot: "body.title", source: { kind: "user", value: "hello" }, basis: "user" }]);
    const fromRule: FlowsFile = { ...prev, flows: [{ ...prev.flows[0]!, steps: [{ ...prev.flows[0]!.steps[0]!, inputs: [{ slot: "body.title", source: { kind: "fixed", value: "old" }, basis: "rule" }] }] }] };
    expect(mergeFlows(fromRule, next.flows)[0]!.steps[0]!.inputs[0]!.source).toEqual({ kind: "empty" });
  });
  it("keeps Claude Code (basis claude) inputs and refreshes rule inputs", () => {
    const next = inferFlows([feat("POST", "/tickets", { id: { type: "integer" } }, { type: "object", required: ["title", "body"], properties: { title: { type: "string" }, body: { type: "string" } } })]);
    const step = next.flows[0]!.steps[0]!;
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ ...next.flows[0]!, steps: [{ ...step, inputs: [
      { slot: "body.title", source: { kind: "fixed", value: "from claude" }, basis: "claude" },
      { slot: "body.body", source: { kind: "fixed", value: "stale" }, basis: "rule" },
    ] }] }] };
    const inputs = mergeFlows(prev, next.flows)[0]!.steps[0]!.inputs;
    expect(inputs.find((i) => i.slot === "body.title")).toEqual({ slot: "body.title", source: { kind: "fixed", value: "from claude" }, basis: "claude" });
    expect(inputs.find((i) => i.slot === "body.body")).toEqual({ slot: "body.body", source: { kind: "empty" }, basis: "rule" });
  });
  it("drops a saved step reference whose step is gone from the new inference (#36)", () => {
    const empty = { kind: "empty" } as const;
    const prevFlow: Flow = { id: "issues", name: "n", resource: "issue", steps: [
      { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [] },
      { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
        { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" },
        { slot: "path.owner", source: { kind: "user", value: "octo" }, basis: "user" }] }] };
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [prevFlow] };
    const nextFlow: Flow = { ...prevFlow, steps: [{ id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
      { slot: "path.repo", source: empty, basis: "rule" }, { slot: "path.owner", source: empty, basis: "rule" }] }] };
    const inputs = mergeFlows(prev, [nextFlow])[0]!.steps[0]!.inputs;
    expect(inputs.find((i) => i.slot === "path.repo")).toEqual({ slot: "path.repo", source: empty, basis: "rule" });
    expect(inputs.find((i) => i.slot === "path.owner")!.source).toEqual({ kind: "user", value: "octo" }); // other kinds stay
  });
  it("keeps a saved step reference that still resolves", () => {
    const steps: Flow["steps"] = [
      { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [] },
      { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
        { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "slug" }, basis: "user", createdBy: "create_repo" }] }];
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ id: "issues", name: "n", resource: "issue", steps }] };
    const next: Flow = { id: "issues", name: "n", resource: "issue", steps: [steps[0]!, { ...steps[1]!, inputs: [{ slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "rule", createdBy: "create_repo" }] }] };
    expect(mergeFlows(prev, [next])[0]!.steps[1]!.inputs[0]!.source).toEqual({ kind: "step", step: "create_repo", field: "slug" });
  });
});
