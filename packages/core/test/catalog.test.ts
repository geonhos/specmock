import { describe, expect, it } from "vitest";
import { formatCatalog } from "../src/catalog/format.js";
import { orderFeatures } from "../src/catalog/order.js";
import type { Catalog, Feature } from "../src/types.js";

function f(partial: Partial<Feature> & Pick<Feature, "id" | "group" | "method" | "path">): Feature {
  return {
    title: partial.id, summary: "", request: { params: {}, query: {}, headers: {}, body: null },
    responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
    ...partial,
  };
}

const catalog: Catalog = {
  system: "demo", generatedAt: "2026-01-01T00:00:00.000Z", rejected: [],
  features: [
    f({ id: "users.delete", group: "users", method: "DELETE", path: "/users/{id}" }),
    f({ id: "users.get", group: "users", method: "GET", path: "/users/{id}", hasExample: true }),
    f({ id: "accounts.list", group: "accounts", method: "GET", path: "/accounts" }),
    f({ id: "users.list", group: "users", method: "GET", path: "/users", provenance: "doc-extracted", confidence: 0.7, notes: ["path 추론"] }),
  ],
};

describe("orderFeatures", () => {
  it("sorts by group, path, then method order", () => {
    expect(orderFeatures(catalog).map((x) => x.feature.id)).toEqual(["accounts.list", "users.list", "users.get", "users.delete"]);
    expect(orderFeatures(catalog).map((x) => x.index)).toEqual([1, 2, 3, 4]);
  });

  it("orders groups by code point regardless of locale and does not mutate input", () => {
    const mixed: Catalog = { ...catalog, features: [
      f({ id: "a", group: "users", method: "GET", path: "/u" }),
      f({ id: "b", group: "Users", method: "GET", path: "/U" }),
      f({ id: "c", group: "결제", method: "GET", path: "/p" }),
      f({ id: "d", group: "accounts", method: "GET", path: "/a" }),
    ] };
    const before = JSON.stringify(mixed.features);
    expect(orderFeatures(mixed).map((o) => o.feature.group)).toEqual(["Users", "accounts", "users", "결제"]);
    expect(JSON.stringify(mixed.features)).toBe(before);
  });
});

describe("formatCatalog", () => {
  it("renders groups, badges and warnings", () => {
    const text = formatCatalog(catalog);
    expect(text).toContain("demo — 4개 기능 (openapi 3 · 문서추출 1 · 추론 0)");
    expect(text).toMatch(/── accounts \(1\)/);
    expect(text).toMatch(/── users \(3\)/);
    expect(text).toMatch(/3\s+users\.get\s+GET\s+\/users\/\{id\}\s+spec\s+1\.0\s+●/);
    expect(text).toMatch(/2\s+users\.list\s+GET\s+\/users\s+doc\s+0\.7\s+—\s+⚠ path 추론/);
    expect(text).toContain("범례");
  });

  it("keeps global numbering when filtered by group", () => {
    const text = formatCatalog(catalog, { group: "users" });
    expect(text).toContain("demo — 그룹 users: 3개 기능 (전체 4개)");
    expect(text).toMatch(/2\s+users\.list\s+GET\s+\/users/);
    expect(text).toMatch(/4\s+users\.delete/);
    expect(text).not.toContain("accounts");
    expect(text).toMatch(/── users \(3\)/);
  });

  it("renders an empty group filter without throwing", () => {
    const text = formatCatalog(catalog, { group: "nope" });
    expect(text).toContain("그룹 nope: 0개 기능 (전체 4개)");
    expect(text).toContain("(기능 없음)");
  });

  it("renders an empty catalog without throwing", () => {
    const text = formatCatalog({ ...catalog, features: [] });
    expect(text).toContain("0개 기능");
    expect(text).toContain("(기능 없음)");
  });
});
