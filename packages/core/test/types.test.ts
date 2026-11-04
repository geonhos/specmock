import { describe, expect, it } from "vitest";
import { FeatureSchema, MockSpecSchema } from "../src/types.js";

const feature = {
  id: "users.get",
  group: "users",
  title: "Get user",
  method: "GET",
  path: "/users/{id}",
  request: { params: { id: { schema: { type: "string" }, required: true } }, query: {}, headers: {}, body: null },
  responses: { "200": { schema: { type: "object" }, examples: [] } },
  auth: "none",
  provenance: "openapi",
  confidence: 1,
  hasExample: false,
};

describe("FeatureSchema", () => {
  it("accepts a minimal feature and fills defaults", () => {
    const parsed = FeatureSchema.parse(feature);
    expect(parsed.notes).toEqual([]);
    expect(parsed.evidence).toEqual([]);
    expect(parsed.summary).toBe("");
  });

  it("rejects confidence outside 0..1", () => {
    expect(() => FeatureSchema.parse({ ...feature, confidence: 1.5 })).toThrow();
  });
});

describe("MockSpecSchema", () => {
  it("requires fixtures on each feature", () => {
    const bad = { system: "x", baseUrl: "/", language: "ts", features: [feature], notMocked: [], contracts: [], assumptions: [] };
    expect(() => MockSpecSchema.parse(bad)).toThrow();
    const good = { ...bad, features: [{ ...feature, fixtures: [{ status: 200, body: {}, source: "empty" }] }] };
    expect(MockSpecSchema.parse(good).features[0].fixtures).toHaveLength(1);
  });
});
