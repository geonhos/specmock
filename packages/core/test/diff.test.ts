import { describe, expect, it } from "vitest";
import { diffCatalogs } from "../src/analyze/diff.js";
import type { Catalog, Feature } from "../src/types.js";

const f = (id: string, extra: Partial<Feature> = {}): Feature => ({
  id,
  group: "g",
  title: id,
  summary: "",
  method: "GET",
  path: `/${id}`,
  request: { params: {}, query: {}, headers: {}, body: null },
  responses: {},
  auth: "none",
  provenance: "openapi",
  confidence: 1,
  hasExample: false,
  evidence: [],
  notes: [],
  ...extra,
});
const cat = (...features: Feature[]): Catalog => ({ system: "s", generatedAt: "t", features, rejected: [] });

describe("diffCatalogs", () => {
  it("reports added, removed and changed ids, ignoring confidence-only changes", () => {
    const prev = cat(f("a"), f("b"), f("c", { confidence: 0.5 }));
    const next = cat(f("a", { summary: "new" }), f("c", { confidence: 0.9 }), f("d"));
    expect(diffCatalogs(prev, next)).toEqual({ previousAt: "t", added: ["d"], removed: ["b"], changed: ["a"] });
  });

  it("treats everything as added when there is no previous catalog", () => {
    expect(diffCatalogs(null, cat(f("a")))).toEqual({ previousAt: null, added: ["a"], removed: [], changed: [] });
  });

  it("is empty when nothing changed", () => {
    const prev = cat(f("a"), f("b"));
    expect(diffCatalogs(prev, cat(f("b"), f("a")))).toEqual({ previousAt: "t", added: [], removed: [], changed: [] });
  });
});
