import { describe, expect, it } from "vitest";
import { deriveFeatureId, deriveGroup, FeatureIdRegistry } from "../src/analyze/featureId.js";

describe("deriveFeatureId", () => {
  it("uses operationId when present", () => {
    expect(deriveFeatureId({ method: "GET", path: "/users/{id}", operationId: "getUser" })).toBe("getUser");
  });
  it("sanitizes operationId", () => {
    expect(deriveFeatureId({ method: "GET", path: "/x", operationId: "get user/1" })).toBe("get_user_1");
  });
  it("derives resource.action from path and method", () => {
    expect(deriveFeatureId({ method: "GET", path: "/users/{id}" })).toBe("users.get");
    expect(deriveFeatureId({ method: "GET", path: "/users" })).toBe("users.list");
    expect(deriveFeatureId({ method: "POST", path: "/users" })).toBe("users.create");
    expect(deriveFeatureId({ method: "PATCH", path: "/users/{id}" })).toBe("users.update");
    expect(deriveFeatureId({ method: "DELETE", path: "/users/{id}" })).toBe("users.delete");
    expect(deriveFeatureId({ method: "GET", path: "/store/inventory" })).toBe("inventory.list");
    expect(deriveFeatureId({ method: "GET", path: "/" })).toBe("root.list");
    expect(deriveFeatureId({ method: "HEAD", path: "/users" })).toBe("users.head");
  });
});

describe("deriveGroup", () => {
  it("prefers the first tag, then first static segment, then root", () => {
    expect(deriveGroup({ path: "/users/{id}", tags: ["People"] })).toBe("People");
    expect(deriveGroup({ path: "/users/{id}", tags: [] })).toBe("users");
    expect(deriveGroup({ path: "/{id}", tags: [] })).toBe("root");
  });
});

describe("FeatureIdRegistry", () => {
  it("appends numeric suffixes on collision", () => {
    const reg = new FeatureIdRegistry();
    expect(reg.claim("users.get")).toBe("users.get");
    expect(reg.claim("users.get")).toBe("users.get2");
    expect(reg.claim("users.get")).toBe("users.get3");
  });
});
