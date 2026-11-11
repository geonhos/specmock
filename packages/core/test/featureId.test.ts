import { describe, expect, it } from "vitest";
import { deriveFeatureId, deriveGroup, FeatureIdRegistry, methodsByShape } from "../src/analyze/featureId.js";

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
    expect(deriveFeatureId({ method: "POST", path: "/v1/customers/{id}" })).toBe("customers.update");
    expect(deriveFeatureId({ method: "POST", path: "/v1/customers" })).toBe("customers.create");
    expect(deriveFeatureId({ method: "POST", path: "/v1/customers/{id}/sources" })).toBe("sources.create");
    expect(deriveFeatureId({ method: "PATCH", path: "/users/{id}" })).toBe("users.update");
    expect(deriveFeatureId({ method: "DELETE", path: "/users/{id}" })).toBe("users.delete");
    expect(deriveFeatureId({ method: "GET", path: "/store/inventory" })).toBe("inventory.list");
    expect(deriveFeatureId({ method: "GET", path: "/" })).toBe("root.list");
    expect(deriveFeatureId({ method: "HEAD", path: "/users" })).toBe("users.head");
  });
});

describe("deriveFeatureId siblingMethods", () => {
  it("keeps POST on a trailing variable as create when PUT/PATCH is a sibling", () => {
    expect(deriveFeatureId({ method: "POST", path: "/users/{id}", siblingMethods: new Set(["POST", "PUT"]) })).toBe("users.create");
    expect(deriveFeatureId({ method: "POST", path: "/users/{id}", siblingMethods: new Set(["POST", "PATCH"]) })).toBe("users.create");
    expect(deriveFeatureId({ method: "POST", path: "/users/{id}", siblingMethods: new Set(["POST", "GET"]) })).toBe("users.update");
    expect(deriveFeatureId({ method: "PUT", path: "/users/{id}", siblingMethods: new Set(["POST", "PUT"]) })).toBe("users.update");
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

describe("deriveFeatureId sub-actions (shape context)", () => {
  const shapes = methodsByShape([
    { method: "GET", path: "/v1/payment_intents" },
    { method: "POST", path: "/v1/payment_intents" },
    { method: "GET", path: "/v1/payment_intents/{id}" },
    { method: "POST", path: "/v1/payment_intents/{id}" },
    { method: "POST", path: "/v1/payment_intents/{id}/cancel" },
    { method: "GET", path: "/v1/payment_intents/search" },
    { method: "GET", path: "/v1/payment_intents/{id}/amount_details_line_items" },
    { method: "POST", path: "/v1/customers/{id}/sources" },
    { method: "GET", path: "/v1/customers/{id}/sources" },
    { method: "GET", path: "/v1/customers" },
    { method: "GET", path: "/v1/customers/{id}" },
    { method: "GET", path: "/store/inventory" },
  ]);
  const id = (method: "GET" | "POST", path: string) => deriveFeatureId({ method, path, shapes });
  it("names a POST sub-action after its parent resource when the parent shape exists and the shape has no GET", () => {
    expect(id("POST", "/v1/payment_intents/{id}/cancel")).toBe("payment_intents.cancel");
    expect(id("POST", "/v1/payment_intents/{payment_intent_id}/cancel")).toBe("payment_intents.cancel");
  });
  it("keeps sub-collections (shape also has GET) and unknown parents as before", () => {
    expect(id("POST", "/v1/customers/{id}/sources")).toBe("sources.create");
    expect(id("POST", "/v1/orphans/{id}/cancel")).toBe("cancel.create");
  });
  it("names a static GET after the parent collection only when the parent path exists", () => {
    expect(id("GET", "/v1/payment_intents/search")).toBe("payment_intents.search");
    expect(id("GET", "/store/inventory")).toBe("inventory.list");
    expect(id("GET", "/v1/payment_intents/{id}/amount_details_line_items")).toBe("amount_details_line_items.list");
  });
  it("behaves as before without shape context", () => {
    expect(deriveFeatureId({ method: "POST", path: "/v1/payment_intents/{id}/cancel" })).toBe("cancel.create");
  });
});
