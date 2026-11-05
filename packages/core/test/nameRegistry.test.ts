import { describe, expect, it } from "vitest";
import { NameRegistry, safeName } from "../src/generate/tsHono.js";

describe("NameRegistry", () => {
  it("gives distinct names to inputs that sanitize to the same string", () => {
    const r = new NameRegistry();
    expect(r.claim("결제")).toBe("__");
    expect(r.claim("주문")).toBe("__2");
  });

  it("prefixes names that are empty or start with a digit", () => {
    const r = new NameRegistry();
    expect(r.claim("1st")).toBe("g_1st");
    expect(r.claim("")).toBe("g_");
  });

  it("keeps the first claim and numbers later collisions", () => {
    const r = new NameRegistry();
    expect(r.claim("inventory.list")).toBe("inventory_list");
    expect(r.claim("inventory_list")).toBe("inventory_list2");
    expect(r.claim("pets")).toBe("pets");
  });

  it("safeName itself is not injective", () => {
    expect(safeName("a.b")).toBe(safeName("a-b"));
  });
});
