import { describe, expect, it } from "vitest";
import {
  AnalyzeRequestSchema,
  ExtractionResultSchema,
  extractionJsonSchema,
  FeatureSchema,
  MockSpecSchema,
  SourceInputSchema,
} from "../src/types.js";

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
    const bad = { system: "x", baseUrl: "/", features: [feature], notMocked: [], contracts: [], assumptions: [] };
    expect(() => MockSpecSchema.parse(bad)).toThrow();
    const good = { ...bad, features: [{ ...feature, fixtures: [{ status: 200, body: {}, source: "empty" }] }] };
    expect(MockSpecSchema.parse(good).features[0].fixtures).toHaveLength(1);
  });
});

describe("Phase 1B schemas", () => {
  it("accepts harvested content and a harvest candidate on a source input", () => {
    const r = SourceInputSchema.safeParse({
      kind: "html", origin: "https://x.test/docs", fetchedAt: "2026-11-05T00:00:00Z", contentHash: "h", content: "# Docs",
      harvestCandidate: { reasons: ["select 요소 2개"] },
      harvested: { pages: [{ url: "https://x.test/docs", title: "Docs", content: "..." }], interactions: [{ type: "tab", label: "Node", content: "..." }] },
    });
    expect(r.success).toBe(true);
  });

  it("validates an extraction result and rejects a bad method", () => {
    const ok = ExtractionResultSchema.safeParse({ endpoints: [{ method: "GET", path: "/pets", title: "List", responses: [{ status: 200 }], evidence: ["GET /pets"], confidence: 0.9 }] });
    expect(ok.success).toBe(true);
    const bad = ExtractionResultSchema.safeParse({ endpoints: [{ method: "FETCH", path: "/pets", title: "", responses: [], evidence: [], confidence: 0.5 }] });
    expect(bad.success).toBe(false);
  });

  it("exports a JSON Schema for the LLM that has no $ref and marks endpoints required", () => {
    const js = extractionJsonSchema();
    expect(JSON.stringify(js)).not.toContain("$ref");
    expect(js.required).toEqual(["endpoints"]);
  });

  it("validates an analyze request", () => {
    const r = AnalyzeRequestSchema.safeParse({
      system: "s", createdAt: "2026-11-05T00:00:00Z", prompt: "p", schema: { type: "object" },
      chunks: [{ index: 0, file: "chunks/000.md", inputIndex: 0, heading: "Pets", chars: 120 }],
    });
    expect(r.success).toBe(true);
  });
});
