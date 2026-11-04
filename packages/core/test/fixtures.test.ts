import { describe, expect, it } from "vitest";
import { buildFixtures } from "../src/select/fixtures.js";
import type { Feature } from "../src/types.js";

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

  it("replaces circular markers with null instead of random values", () => {
    const schema = { type: "object", required: ["children"], properties: { children: { type: "array", minItems: 1, items: { "x-specmock-circular": true } } } };
    const { fixtures } = buildFixtures(f({ "200": { schema, examples: [] } }));
    const body = fixtures[0].body as { children: unknown[] };
    expect(body.children.length).toBeGreaterThan(0);
    expect(body.children.every((c) => c === null)).toBe(true);
  });
});
