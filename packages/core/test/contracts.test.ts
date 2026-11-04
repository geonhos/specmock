import { describe, expect, it } from "vitest";
import { buildContracts } from "../src/select/contracts.js";
import type { Feature, Fixture } from "../src/types.js";

const base: Feature = {
  id: "pets.create", group: "pets", title: "", summary: "", method: "POST", path: "/pets/{petId}/toys",
  request: {
    params: { petId: { schema: { type: "integer" }, required: true } },
    query: { verbose: { schema: { type: "boolean" }, required: true }, page: { schema: { type: "integer" }, required: false } },
    headers: {},
    body: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  },
  responses: {
    "201": { schema: { type: "object" }, examples: [] },
    "400": { schema: { type: "object" }, examples: [] },
  },
  auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
};
const fixtures: Fixture[] = [{ status: 201, body: {}, source: "empty" }, { status: 400, body: {}, source: "empty" }];

describe("buildContracts", () => {
  it("builds a happy-path contract with filled params, required query and body", () => {
    const [happy] = buildContracts(base, fixtures);
    expect(happy.name).toBe("정상 요청");
    expect(happy.request.method).toBe("POST");
    expect(happy.request.path).toBe("/pets/1/toys");
    expect(happy.request.query).toEqual({ verbose: "true" });
    expect(happy.request.body).toMatchObject({ name: expect.any(String) });
    expect(happy.expect).toEqual({ status: 201, schema: { type: "object" } });
  });

  it("adds a missing-required contract when 400/422 is listed", () => {
    const contracts = buildContracts(base, fixtures);
    expect(contracts).toHaveLength(2);
    expect(contracts[1].name).toBe("필수 값 누락");
    expect(contracts[1].request.body).toBeNull();
    expect(contracts[1].request.query).toEqual({});
    expect(contracts[1].expect.status).toBe(400);
  });

  it("skips the error contract when nothing is required or no 4xx is listed", () => {
    const noReq: Feature = { ...base, request: { params: {}, query: {}, headers: {}, body: null }, path: "/pets" };
    expect(buildContracts(noReq, fixtures)).toHaveLength(1);
    const no4xx: Feature = { ...base, responses: { "201": base.responses["201"] } };
    expect(buildContracts(no4xx, [fixtures[0]])).toHaveLength(1);
  });

  it("uses the lowest 2xx status", () => {
    const multi: Feature = { ...base, responses: { "202": base.responses["201"], "200": base.responses["201"] } };
    expect(buildContracts(multi, [{ status: 200, body: {}, source: "empty" }])[0].expect.status).toBe(200);
  });
});
