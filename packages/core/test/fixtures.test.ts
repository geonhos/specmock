import { describe, expect, it } from "vitest";
import { buildFixtures } from "../src/select/fixtures.js";
import type { Feature, Recorded } from "../src/types.js";

function f(responses: Feature["responses"]): Feature {
  return {
    id: "x.get", group: "x", title: "x", summary: "", method: "GET", path: "/x",
    request: { params: {}, query: {}, headers: {}, body: null },
    responses, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
  };
}

describe("buildFixtures", () => {
  it("prefers spec examples", () => {
    const { fixtures, assumptions } = buildFixtures(f({ "200": { schema: { type: "object" }, examples: [{ source: "spec-example", body: { a: 1 } }] } }));
    expect(fixtures).toEqual([{ status: 200, body: { a: 1 }, source: "spec-example" }]);
    expect(assumptions).toEqual([]);
  });

  it("generates from schema deterministically", () => {
    const schema = { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } };
    const a = buildFixtures(f({ "200": { schema, examples: [] } }));
    const b = buildFixtures(f({ "200": { schema, examples: [] } }));
    expect(a.fixtures[0].source).toBe("schema-generated");
    expect(a.fixtures[0].body).toEqual(b.fixtures[0].body);
    expect(typeof (a.fixtures[0].body as { id: unknown }).id).toBe("number");
  });

  it("falls back to empty with an assumption, and keeps 204 body null", () => {
    const r = buildFixtures(f({ "200": { schema: null, examples: [] }, "204": { schema: null, examples: [] } }));
    expect(r.fixtures).toEqual([
      { status: 200, body: {}, source: "empty" },
      { status: 204, body: null, source: "empty" },
    ]);
    expect(r.assumptions[0]).toMatch(/x\.get: 200 응답 스키마 없음/);
  });

  it("only builds fixtures for 2xx and listed 4xx", () => {
    const r = buildFixtures(f({ "201": { schema: null, examples: [] }, "404": { schema: null, examples: [] }, "500": { schema: null, examples: [] } }));
    expect(r.fixtures.map((x) => x.status)).toEqual([201, 404]);
  });

  it("adds an empty 200 when the feature defines only 4xx responses", () => {
    const r = buildFixtures(f({ "400": { schema: null, examples: [] } }));
    expect(r.fixtures.map((x) => x.status)).toEqual([200, 400]);
    expect(r.fixtures.find((x) => x.status === 200)).toEqual({ status: 200, body: {}, source: "empty" });
    expect(r.assumptions).toContain("x.get: 2xx 응답 정의 없음. 200 빈 객체를 반환한다.");
  });

  it("adds an empty 200 when the feature defines no responses at all", () => {
    const r = buildFixtures(f({}));
    expect(r.fixtures).toEqual([{ status: 200, body: {}, source: "empty" }]);
    expect(r.assumptions).toEqual(["x.get: 2xx 응답 정의 없음. 200 빈 객체를 반환한다."]);
  });

  it("replaces circular markers with null instead of random values", () => {
    const schema = { type: "object", required: ["children"], properties: { children: { type: "array", minItems: 1, items: { "x-specmock-circular": true } } } };
    const { fixtures } = buildFixtures(f({ "200": { schema, examples: [] } }));
    const body = fixtures[0].body as { children: unknown[] };
    expect(body.children.length).toBeGreaterThan(0);
    expect(body.children.every((c) => c === null)).toBe(true);
  });
});

function rec(status: number, over: Partial<Recorded["response"]> = {}): Recorded {
  return {
    featureId: "x.get", recordedAt: "2026-11-09T00:00:00.000Z", mockspecHash: "h",
    request: { method: "GET", path: "/x", query: {}, headers: {} },
    response: { status, kind: "json", headers: {}, body: { real: true }, bytes: 13, ...over },
    contract: { expectedStatus: 200, statusMatch: status === 200, schemaErrors: [] },
  };
}
const R = { "200": { schema: { type: "object" }, examples: [] }, "404": { schema: { type: "object" }, examples: [] } };

describe("buildFixtures with recording", () => {
  it("기본 2xx와 status가 같은 JSON 녹화는 recorded fixture가 된다", () => {
    const { fixtures, assumptions } = buildFixtures(f(R), rec(200));
    expect(fixtures[0]).toEqual({ status: 200, body: { real: true }, source: "recorded" });
    expect(fixtures[1].source).toBe("schema-generated");
    expect(assumptions).toEqual([]);
  });

  it("status 다름·truncated·비JSON은 무시하고 사유를 남긴다", () => {
    expect(buildFixtures(f(R), rec(404)).assumptions).toEqual(["x.get: 녹화 응답이 404라 사용하지 않음(추측 fixture 사용)"]);
    expect(buildFixtures(f(R), rec(200, { kind: "truncated", body: undefined, truncated: true })).assumptions)
      .toEqual(["x.get: 녹화 응답이 1MB를 넘어 사용하지 않음(추측 fixture 사용)"]);
    const raw = buildFixtures(f(R), rec(200, { kind: "raw", body: { raw: "<html>", contentType: "text/html" } }));
    expect(raw.assumptions).toEqual(["x.get: 녹화 응답 바디가 JSON이 아니라 사용하지 않음(추측 fixture 사용)"]);
    expect(raw.fixtures[0].source).toBe("schema-generated");
  });

  it("204 빈 녹화는 바꿀 것이 없어 조용히 넘어간다", () => {
    const { fixtures, assumptions } = buildFixtures(f({ "204": { schema: null, examples: [] } }), rec(204, { kind: "empty", body: null }));
    expect(fixtures).toEqual([{ status: 204, body: null, source: "empty" }]);
    expect(assumptions).toEqual([]);
  });

  it("빈 바디 녹화(200)는 비어 있다는 사유로 쓰지 않는다", () => {
    const { fixtures, assumptions } = buildFixtures(f({ "200": { schema: null, examples: [] } }), rec(200, { kind: "empty", body: null }));
    expect(fixtures.every((x) => x.source !== "recorded")).toBe(true);
    expect(assumptions.some((a) => a.includes("녹화 응답 바디가 비어 있어"))).toBe(true);
    expect(assumptions.some((a) => a.includes("JSON이 아니라"))).toBe(false);
  });
});
