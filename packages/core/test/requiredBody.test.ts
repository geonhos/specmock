import { describe, expect, it } from "vitest";
import { requiredBodyFields } from "../src/select/requiredBody.js";
import type { Feature } from "../src/types.js";

const feature = (body: Feature["request"]["body"]): Feature => ({
  id: "f", group: "g", title: "", summary: "", method: "POST", path: "/x",
  request: { params: {}, query: {}, headers: {}, body }, responses: {},
  auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
});

describe("requiredBodyFields", () => {
  it("lists required top-level fields with spec examples only", () => {
    const f = feature({ type: "object", required: ["title", "labels"], properties: { title: { type: "string", example: "Found a bug" }, labels: { type: "array" }, body: { type: "string", example: "x" } } });
    expect(requiredBodyFields(f)).toEqual([{ name: "title", example: "Found a bug" }, { name: "labels" }]);
  });
  it("uses `examples[0]` when `example` is absent and ignores generated values", () => {
    const f = feature({ type: "object", required: ["name"], properties: { name: { type: "string", examples: ["Hello-World"] } } });
    expect(requiredBodyFields(f)).toEqual([{ name: "name", example: "Hello-World" }]);
  });
  it("no body, no required, or non-object body → []", () => {
    expect(requiredBodyFields(feature(null))).toEqual([]);
    expect(requiredBodyFields(feature({ type: "object", properties: { a: { type: "string" } } }))).toEqual([]);
    expect(requiredBodyFields(feature({ type: "array", items: {} }))).toEqual([]);
  });
});
