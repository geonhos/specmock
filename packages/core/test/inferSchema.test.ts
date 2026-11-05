import { describe, expect, it } from "vitest";
import { inferSchema } from "../src/analyze/inferSchema.js";

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

  it("handles scalars and booleans", () => {
    expect(inferSchema(true)).toEqual({ type: "boolean" });
    expect(inferSchema("x")).toEqual({ type: "string" });
    expect(inferSchema(undefined)).toEqual({});
  });
});
