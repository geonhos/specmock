import { describe, expect, it } from "vitest";
import { INFER_MAX_DEPTH, inferSchema } from "../src/analyze/inferSchema.js";

describe("inferSchema", () => {
  it("infers object properties without required", () => {
    expect(inferSchema({ id: 1, name: "Rex", tags: ["a"], owner: { id: 2 }, gone: null })).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        owner: { type: "object", properties: { id: { type: "integer" } } },
        gone: { type: "null" },
      },
    });
  });

  it("uses the first element for arrays and number for non-integers", () => {
    expect(inferSchema([{ price: 1.5 }])).toEqual({ type: "array", items: { type: "object", properties: { price: { type: "number" } } } });
    expect(inferSchema([])).toEqual({ type: "array" });
  });

  it("stops at the depth cap and keeps __proto__ keys as own properties", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { n: deep };
    const schema = inferSchema(deep);
    let cur: Record<string, unknown> = schema;
    let levels = 0;
    while (cur.properties) { cur = (cur.properties as Record<string, Record<string, unknown>>).n; levels += 1; }
    expect(levels).toBeLessThanOrEqual(INFER_MAX_DEPTH + 1);
    expect(cur).toEqual({});

    const props = inferSchema(JSON.parse('{"__proto__": {"x": 1}}')).properties as Record<string, unknown>;
    expect(Object.hasOwn(props, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  });

  it("handles scalars and booleans", () => {
    expect(inferSchema(true)).toEqual({ type: "boolean" });
    expect(inferSchema("x")).toEqual({ type: "string" });
    expect(inferSchema(undefined)).toEqual({});
  });
});
