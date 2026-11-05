import { describe, expect, it } from "vitest";
import { formatCatalog } from "../src/catalog/format.js";
import { buildChoices, mergeInteractivePick } from "../src/select/interactive.js";
import type { Catalog, Feature } from "../src/types.js";

const f = (id: string, group: string, extra: Partial<Feature> = {}): Feature => ({
  id, group, title: id, summary: "", method: "GET", path: `/${group}/${id}`, request: { params: {}, query: {}, headers: {}, body: null },
  responses: { "200": { schema: { type: "object" }, examples: [] } }, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], ...extra,
} as Feature);
const catalog: Catalog = { system: "s", generatedAt: "t", rejected: [], features: [f("b1", "beta"), f("a2", "alpha", { provenance: "doc-extracted", confidence: 0.6, notes: ["근거 인용 없음"] }), f("a1", "alpha", { hasExample: true })] } as Catalog;

describe("buildChoices", () => {
  it("groups in catalog display order with separators and global numbers", () => {
    const rows = buildChoices(catalog, null);
    expect(rows.map((r) => ("separator" in r ? `-- ${r.separator}` : r.value))).toEqual(["-- alpha (2)", "a1", "a2", "-- beta (1)", "b1"]);
    const a1 = rows.find((r) => "value" in r && r.value === "a1")!;
    expect("name" in a1 && a1.name).toMatch(/^1\s+a1\s+GET\s+\/alpha\/a1\s+spec\s+1\.0\s+●/);
  });

  it("matches the row text, numbers and order of formatCatalog", () => {
    const rows = buildChoices(catalog, null).flatMap((r) => ("name" in r ? [r.name] : []));
    const table = formatCatalog(catalog).split("\n");
    for (const name of rows) expect(table, name).toContain("  " + name);
    const order = (xs: string[]) => xs.map((x) => x.trim().split(/\s+/)[1]);
    expect(order(rows)).toEqual(order(table.filter((l) => /^ {2}\d+ /.test(l))));
  });

  it("pre-checks the previous selection and puts warnings in the description", () => {
    const rows = buildChoices(catalog, ["a2"]);
    const a2 = rows.find((r) => "value" in r && r.value === "a2")!;
    expect("checked" in a2 && a2.checked).toBe(true);
    expect("description" in a2 && a2.description).toContain("근거 인용 없음");
    const a1 = rows.find((r) => "value" in r && r.value === "a1")!;
    expect("checked" in a1 && a1.checked).toBe(false);
  });

  it("filters by group but keeps numbering", () => {
    const rows = buildChoices(catalog, null, { group: "beta" });
    expect(rows.map((r) => ("value" in r ? r.value : r.separator))).toEqual(["beta (1)", "b1"]);
    expect((rows[1] as { name: string }).name).toMatch(/^3\s/);
  });
});

describe("mergeInteractivePick", () => {
  const shownAlpha = ["a1", "a2"];
  it("keeps previous picks of groups that were not shown", () => {
    expect(mergeInteractivePick({ catalog, previous: ["b1", "a1"], shownIds: shownAlpha, picked: ["a2"] })).toEqual(["a2", "b1"]);
  });
  it("drops shown items the user unchecked", () => {
    expect(mergeInteractivePick({ catalog, previous: ["a1", "a2", "b1"], shownIds: shownAlpha, picked: ["a1"] })).toEqual(["a1", "b1"]);
  });
  it("discards ids that vanished from the catalog", () => {
    expect(mergeInteractivePick({ catalog, previous: ["gone", "b1"], shownIds: shownAlpha, picked: ["a1"] })).toEqual(["a1", "b1"]);
  });
  it("handles a null previous selection", () => {
    expect(mergeInteractivePick({ catalog, previous: null, shownIds: ["a1", "a2", "b1"], picked: ["b1", "a2"] })).toEqual(["a2", "b1"]);
  });
  it("orders deterministically in catalog display order without duplicates", () => {
    expect(mergeInteractivePick({ catalog, previous: ["b1"], shownIds: shownAlpha, picked: ["a2", "a1", "a2"] })).toEqual(["a1", "a2", "b1"]);
  });
});
