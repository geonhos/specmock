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

describe("deriveFeatureId hardening", () => {
  it("treats segments containing a template as parameters and sanitizes resources", () => {
    expect(deriveFeatureId({ method: "GET", path: "/users/{id}.json" })).toBe("users.get");
    expect(deriveFeatureId({ method: "GET", path: "/users/{id}/posts.{format}" })).toBe("posts.list");
    expect(deriveFeatureId({ method: "GET", path: "/user profile" })).toBe("user_profile.list");
    expect(deriveFeatureId({ method: "GET", path: "/users/{id:[0-9]+}" })).toBe("users.get");
    expect(deriveFeatureId({ method: "GET", path: "/users/" })).toBe("users.list");
    expect(deriveFeatureId({ method: "GET", path: "/users/{id}/posts/{postId}" })).toBe("posts.get");
    expect(deriveFeatureId({ method: "PUT", path: "/users/{id}" })).toBe("users.update");
  });
  it("falls back to resource.action for degenerate operationIds", () => {
    expect(deriveFeatureId({ method: "GET", path: "/users/{id}", operationId: "사용자 조회" })).toBe("users.get");
    expect(deriveFeatureId({ method: "GET", path: "/users", operationId: "*" })).toBe("users.list");
    expect(deriveFeatureId({ method: "GET", path: "/users", operationId: "  " })).toBe("users.list");
    expect(deriveFeatureId({ method: "GET", path: "/users", operationId: "-legacyList" })).toBe("legacyList");
    expect(deriveFeatureId({ method: "GET", path: "/users", operationId: "get  user" })).toBe("get_user");
  });
});

describe("deriveGroup", () => {
  it("skips leading version/api prefixes and blank tags", () => {
    expect(deriveGroup({ path: "/v1/users/{id}", tags: [] })).toBe("users");
    expect(deriveGroup({ path: "/api/v2/orders", tags: [] })).toBe("orders");
    expect(deriveGroup({ path: "/v1", tags: [] })).toBe("v1");
    expect(deriveGroup({ path: "/users", tags: ["  ", "People"] })).toBe("People");
    expect(deriveGroup({ path: "/users" })).toBe("users");
  });
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
