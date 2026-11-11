// packages/core/test/contract-run.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { joinUrl, runContract } from "../src/verify/contracts.js";
import type { Contract } from "../src/types.js";
import { closedPortUrl, startFakeTarget, type FakeTarget } from "./fakeTarget.js";

let t: FakeTarget | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const PET = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
function contract(over: Partial<Contract["request"]> = {}, schema: Record<string, unknown> | null = PET, status = 200): Contract {
  return { featureId: "getPet", name: "정상 요청", request: { method: "GET", path: "/pets/1", headers: {}, query: {}, body: null, ...over }, expect: { status, schema } };
}

describe("joinUrl", () => {
  it("baseUrl 경로를 지우지 않고 끝 /를 하나로 맞춘다", () => {
    expect(joinUrl("https://h.example/v2", "/pets").toString()).toBe("https://h.example/v2/pets");
    expect(joinUrl("https://h.example/v2/", "/pets").toString()).toBe("https://h.example/v2/pets");
    expect(joinUrl("https://h.example/v2//", "/pets").toString()).toBe("https://h.example/v2/pets");
    expect(joinUrl("http://127.0.0.1:3000", "/pets/1").toString()).toBe("http://127.0.0.1:3000/pets/1");
  });

  it("query를 붙인다", () => {
    expect(joinUrl("https://h.example/v2", "/pets", { status: "available", limit: "2" }).toString()).toBe("https://h.example/v2/pets?status=available&limit=2");
  });
});

describe("joinUrl ?·#", () => {
  it("path에 ?나 #가 있으면 던진다", () => {
    expect(() => joinUrl("https://h.example", "/pets?x=1")).toThrow("contract path에는 ?나 #를 쓸 수 없습니다: /pets?x=1");
    expect(() => joinUrl("https://h.example", "/pets#a")).toThrow("?나 #");
  });
});

describe("runContract", () => {
  it("path에 ?가 있으면 요청 없이 request failed로 보고한다", async () => {
    const r = await runContract("http://127.0.0.1:1", contract({ path: "/pets?x=1" }));
    expect(r.status).toBeNull();
    expect(r.errors).toEqual(["request failed: contract path에는 ?나 #를 쓸 수 없습니다: /pets?x=1"]);
    expect(r.failure?.kind).toBe("invalid");
  });

  it("일치: status·스키마가 맞으면 errors가 비고 content-type·content-length만 남긴다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 }, headers: { "x-secret": "s" } }));
    const r = await runContract(t.url, contract());
    expect(r).toMatchObject({ status: 200, kind: "json", body: { id: 1 }, errors: [], schemaErrors: [], failure: null });
    expect(Object.keys(r.headers).sort()).toEqual(["content-length", "content-type"]);
  });

  it("스키마 오류는 verify와 같은 문구로 errors·schemaErrors에 들어간다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: "p-1" } }));
    const r = await runContract(t.url, contract());
    expect(r.schemaErrors).toEqual(["/id must be integer"]);
    expect(r.errors).toEqual(["/id must be integer"]);
  });

  it("status가 다르면 status 문구만 남기고 바디는 검증하지 않는다", async () => {
    t = await startFakeTarget(() => ({ status: 404, body: { message: "nope" } }));
    const r = await runContract(t.url, contract());
    expect(r.errors).toEqual(["status: expected 200, got 404"]);
    expect(r.schemaErrors).toEqual([]);
    expect(r.kind).toBe("json");
  });

  it("JSON이 아니면 raw, 비어 있으면 empty", async () => {
    t = await startFakeTarget((q) => (q.path === "/html" ? { status: 200, raw: "<html>x</html>", contentType: "text/html" } : { status: 200, raw: "" }));
    const raw = await runContract(t.url, contract({ path: "/html" }));
    expect(raw.kind).toBe("raw");
    expect(raw.body).toEqual({ raw: "<html>x</html>", contentType: "text/html" });
    expect(raw.errors).toEqual(["body is not JSON: <html>x</html>"]);
    const empty = await runContract(t.url, contract({ path: "/e" }, null));
    expect(empty).toMatchObject({ kind: "empty", body: null, errors: [] });
  });

  it("maxBytes를 넘으면 truncated이고 바디를 버린다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1, pad: "x".repeat(100) } }));
    const r = await runContract(t.url, contract(), { maxBytes: 50 });
    expect(r.kind).toBe("truncated");
    expect(r.body).toBeUndefined();
    expect(r.bytes).toBeGreaterThan(50);
    expect(r.schemaErrors).toEqual([]);
  });

  it("timeout과 연결 실패를 failure로 구별한다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 }, delayMs: 500 }));
    const slow = await runContract(t.url, contract(), { timeoutMs: 50 });
    expect(slow.status).toBeNull();
    expect(slow.failure?.kind).toBe("timeout");
    const refused = await runContract(await closedPortUrl(), contract());
    expect(refused.failure?.kind).toBe("network");
    expect(refused.errors[0]).toMatch(/^request failed: /);
  });

  it("opts.headers가 contract 헤더보다 우선하고 opts.path·query가 contract 값을 대신한다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 } }));
    await runContract(t.url, contract({ headers: { "x-a": "contract", "x-b": "b" } }), { headers: { "X-A": "target" }, path: "/pets/123", query: { q: "1" } });
    expect(t.requests[0]).toMatchObject({ path: "/pets/123", query: { q: "1" } });
    expect(t.requests[0].headers["x-a"]).toBe("target");
    expect(t.requests[0].headers["x-b"]).toBe("b");
  });

  it("사용자 취소(signal)는 failure가 아니라 예외로 올린다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 }, delayMs: 500 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(runContract(t.url, contract(), { signal: ac.signal })).rejects.toThrow();
  });

  it("계약 headers의 content-type이 form이면 본문을 form-encoded로 보낸다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 } }));
    await runContract(t.url, contract({ method: "POST", path: "/pets", body: { amount: 1000, meta: { k: "v" } }, headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(t.requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(t.requests[0].body).toBe("amount=1000&meta%5Bk%5D=v");
  });

  it("content-type 지정이 없으면 기존처럼 JSON으로 보낸다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 } }));
    await runContract(t.url, contract({ method: "POST", path: "/pets", body: { amount: 1000 } }));
    expect(t.requests[0].headers["content-type"]).toBe("application/json");
    expect(t.requests[0].body).toBe('{"amount":1000}');
  });
});
