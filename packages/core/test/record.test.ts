// packages/core/test/record.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { record } from "../src/record/index.js";
import type { Target } from "../src/record/target.js";
import { select } from "../src/select/index.js";
import type { ServiceEvent } from "../src/service/events.js";
import { MockSpecSchema, RecordedSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { closedPortUrl, startFakeTarget, type FakeReq, type FakeRes, type FakeTarget } from "./fakeTarget.js";
import { PETSTORE } from "./helpers.js";

const SYS = "petstore";
let dir: string;
let ws: Workspace;
let spec: MockSpec;
let t: FakeTarget | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-record-"));
  ws = new Workspace(dir);
  await ingest(ws, SYS, [PETSTORE]);
  await analyze(ws, SYS);
  await select(ws, SYS, ["all"]);
  spec = await ws.read(SYS, "mockspec.json", MockSpecSchema);
});
afterEach(async () => { await t?.close(); t = undefined; await rm(dir, { recursive: true, force: true }); });

const PET = { id: 1, name: "Rex" };
/** 스펙대로 응답하는 실제 시스템. */
function ok(q: FakeReq): FakeRes {
  if (q.method === "POST") return { status: 201, body: PET };
  if (q.method === "DELETE") return { status: 204 };
  if (q.path === "/pets") return { status: 200, body: [PET] };
  if (q.path.startsWith("/pets/")) return { status: 200, body: PET };
  if (q.path === "/store/inventory") return { status: 200, body: { available: 3 } };
  return { status: 404 };
}
const target = (url: string, over: Partial<Target> = {}): Target => ({ file: "target.json", baseUrl: `${url}/v2`, headers: { Authorization: "Bearer secret-token-123456", "X-Tenant": "dev" }, params: {}, timeoutMs: 2000, secrets: [], ...over });
const strip = (handler: (q: FakeReq) => FakeRes) => (q: FakeReq) => handler({ ...q, path: q.path.replace(/^\/v2/, "") });

/** getPet의 정상 요청 path에 `?`를 넣어 보낼 수 없게 만든 mockspec. */
const unsendable = (): MockSpec => ({ ...spec, contracts: spec.contracts.map((c) => (c.featureId === "getPet" ? { ...c, request: { ...c.request, path: "/pets/1?x=1" } } : c)) });

describe("record", () => {
  it("기본: GET만 순차로 보내고 변경 요청은 건너뛰며 녹화 파일·drift.md를 쓴다", async () => {
    t = await startFakeTarget(strip(ok));
    const events: ServiceEvent[] = [];
    const { result, driftMarkdown } = await record(ws, SYS, spec, target(t.url), { onEvent: (e) => events.push(e) });
    expect(result.matched.sort()).toEqual(["getPet", "inventory.list", "listPets"]);
    expect(result.skipped.map((s) => s.featureId).sort()).toEqual(["createPet", "deletePet"]);
    expect(result.skipped[0].reason).toBe("mutating");
    expect(result.recorded.sort()).toEqual(["getPet", "inventory.list", "listPets"]);
    expect(result.applied).toBeNull();
    expect(t.requests.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
    expect(t.requests.every((r) => r.path.startsWith("/v2/"))).toBe(true);
    expect(t.requests[0].headers.authorization).toBe("Bearer secret-token-123456");
    expect(t.maxConcurrent()).toBe(1);
    expect(events.filter((e) => e.stage === "record")).toHaveLength(5);
    expect(events[events.length - 1]).toMatchObject({ done: 5, total: 5 });
    const rec = await ws.read(SYS, "recorded/getPet.json", RecordedSchema);
    expect(rec.request.headers).toEqual({ authorization: "***", "x-tenant": "***" });
    expect(rec.response).toMatchObject({ status: 200, kind: "json", body: PET });
    expect(rec.contract).toEqual({ expectedStatus: 200, statusMatch: true, schemaErrors: [] });
    expect(result.driftPath).toBe(ws.file(SYS, "drift.md"));
    expect(await readFile(result.driftPath, "utf8")).toBe(driftMarkdown);
    expect(driftMarkdown).toContain("요청 5 · 일치 3 · 스펙과 다름 0 · 상태 불일치 0 · 건너뜀(변경 요청) 2 · 실패 0");
    expect(driftMarkdown).not.toContain("secret-token");
  });

  it("스키마 다름·401·비JSON을 나누고 params로 경로를 바꾼다", async () => {
    t = await startFakeTarget(strip((q) => {
      if (q.path === "/pets") return { status: 401, body: { message: "no" } };
      if (q.path === "/pets/123") return { status: 200, body: { id: "p-123", name: "Nabi" } };
      return { status: 200, raw: "<html>hi</html>", contentType: "text/html" };
    }));
    const { result, driftMarkdown } = await record(ws, SYS, spec, target(t.url, { params: { petId: "123" } }));
    expect(result.drifted).toEqual([{ featureId: "getPet", errors: ["/id must be integer"] }]);
    expect(result.statusMismatch).toEqual([{ featureId: "listPets", expected: 200, actual: 401, hint: "인증 헤더를 확인하세요" }]);
    expect(result.failed).toEqual([{ featureId: "inventory.list", reason: "바디가 JSON이 아닙니다(content-type: text/html)" }]);
    expect(result.recorded.sort()).toEqual(["getPet", "inventory.list", "listPets"]);
    const raw = await ws.read(SYS, "recorded/inventory.list.json", RecordedSchema);
    expect(raw.response).toMatchObject({ kind: "raw", body: { raw: "<html>hi</html>", contentType: "text/html" } });
    expect(driftMarkdown).toContain("- getPet GET /pets/123 → 200. /id must be integer");
  });

  it("404 힌트와 1MB 초과(truncated)", async () => {
    t = await startFakeTarget(strip((q) => (q.path === "/pets" ? { status: 404 } : q.path.startsWith("/pets/") ? { status: 200, body: { id: 1, name: "x".repeat(1_100_000) } } : ok(q))));
    const { result } = await record(ws, SYS, spec, target(t.url));
    expect(result.statusMismatch[0]).toMatchObject({ featureId: "listPets", actual: 404, hint: "`target.json`의 `params`로 실제 값을 지정하세요" });
    expect(result.failed[0].featureId).toBe("getPet");
    expect(result.failed[0].reason).toMatch(/^응답이 1MB를 넘어 저장하지 않았습니다\(\d+바이트\)$/);
    const rec = await ws.read(SYS, "recorded/getPet.json", RecordedSchema);
    expect(rec.response).toMatchObject({ kind: "truncated", truncated: true });
    expect(rec.response.body).toBeUndefined();
  });

  it("timeout과 두 번째 이후 연결 끊김은 실패로 적고 계속한다", async () => {
    let n = 0;
    t = await startFakeTarget(strip((q) => { n++; return n === 2 ? { status: 200, destroy: true } : n === 3 ? { ...ok(q), delayMs: 500 } : ok(q); }));
    const { result } = await record(ws, SYS, spec, target(t.url, { timeoutMs: 100 }));
    expect(result.failed).toHaveLength(2);
    const reasons = result.failed.map((f) => f.reason);
    expect(reasons).toContain("시간 초과(100ms)");
    expect(reasons.some((r) => /^연결 실패: /.test(r))).toBe(true);
    expect(result.matched).toHaveLength(1);
    expect(result.recorded).toHaveLength(1);
  });

  it("첫 요청 연결 실패는 중단하고 drift.md를 쓰지 않는다", async () => {
    await expect(record(ws, SYS, spec, target(await closedPortUrl()))).rejects.toThrow("baseUrl을 확인하세요");
    expect(await ws.exists(SYS, "drift.md")).toBe(false);
  });

  it("요청 불가(invalid)는 첫 전송에 세지 않는다: 다음 요청이 연결 실패면 중단", async () => {
    // getPet의 contract path가 `?`를 품어 보낼 수 없고, 그다음 inventory.list가 실제 첫 전송이다.
    await expect(record(ws, SYS, unsendable(), target(await closedPortUrl()), { features: ["getPet", "inventory.list"] }))
      .rejects.toThrow("baseUrl을 확인하세요");
    expect(await ws.exists(SYS, "drift.md")).toBe(false);
  });

  it("요청 불가는 failed `요청 불가:`로 분류하고 중단하지 않는다", async () => {
    t = await startFakeTarget(strip(ok));
    const { result } = await record(ws, SYS, unsendable(), target(t.url), { features: ["getPet", "inventory.list"] });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.featureId).toBe("getPet");
    expect(result.failed[0]!.reason).toMatch(/^요청 불가: /);
    expect(result.matched).toEqual(["inventory.list"]);
  });

  it("allowMutating이면 POST·DELETE도 보낸다", async () => {
    t = await startFakeTarget(strip(ok));
    const { result } = await record(ws, SYS, spec, target(t.url), { allowMutating: true });
    expect(result.skipped).toEqual([]);
    expect(result.matched.sort()).toEqual(["createPet", "deletePet", "getPet", "inventory.list", "listPets"]);
    expect(t.requests.map((r) => r.method).sort()).toEqual(["DELETE", "GET", "GET", "GET", "POST"]);
  });

  it("features로 고르고 모르는 id는 요청 전에 거부한다", async () => {
    t = await startFakeTarget(strip(ok));
    await expect(record(ws, SYS, spec, target(t.url), { features: ["getPet", "nope"] })).rejects.toThrow("알 수 없는 기능 id: nope");
    expect(t.requests).toHaveLength(0);
    const { result } = await record(ws, SYS, spec, target(t.url), { features: ["getPet"] });
    expect(result.matched).toEqual(["getPet"]);
    expect(t.requests).toHaveLength(1);
  });

  it("refresh는 실행이 끝난 뒤 대상 기능 중 이번에 쓰지 않은 옛 녹화만 지운다", async () => {
    t = await startFakeTarget(strip((q) => (q.path === "/store/inventory" ? { status: 200, destroy: true } : ok(q))));
    await ws.writeText(SYS, "recorded/inventory.list.json", "{}");
    await ws.writeText(SYS, "recorded/listPets.json", "{}");
    // inventory는 첫 전송이 아니므로 실패로 적히고, 옛 녹화는 버려진다. 새로 쓴 listPets는 남는다.
    const { result } = await record(ws, SYS, spec, target(t.url), { features: ["listPets", "inventory.list"], refresh: true });
    expect(result.failed.map((f) => f.featureId)).toEqual(["inventory.list"]);
    expect(await ws.exists(SYS, "recorded/inventory.list.json")).toBe(false);
    expect(await ws.read(SYS, "recorded/listPets.json", RecordedSchema)).toBeTruthy();
  });

  it("refresh + features 필터: 다른 기능의 녹화는 유지한다", async () => {
    t = await startFakeTarget(strip(ok));
    await record(ws, SYS, spec, target(t.url));
    await record(ws, SYS, spec, target(t.url), { features: ["getPet"], refresh: true });
    expect(await ws.exists(SYS, "recorded/getPet.json")).toBe(true);
    expect(await ws.exists(SYS, "recorded/listPets.json")).toBe(true);
    expect(await ws.exists(SYS, "recorded/inventory.list.json")).toBe(true);
  });

  it("refresh + 변경 요청 건너뜀: 그 기능의 옛 녹화는 유지한다", async () => {
    t = await startFakeTarget(strip(ok));
    await record(ws, SYS, spec, target(t.url), { allowMutating: true });
    expect(await ws.exists(SYS, "recorded/createPet.json")).toBe(true);
    const { result } = await record(ws, SYS, spec, target(t.url), { refresh: true });
    expect(result.skipped.map((s) => s.featureId).sort()).toEqual(["createPet", "deletePet"]);
    expect(await ws.exists(SYS, "recorded/createPet.json")).toBe(true);
    expect(await ws.exists(SYS, "recorded/deletePet.json")).toBe(true);
  });

  it("refresh + 두 번째 요청 도중 abort: 옛 녹화를 전부 유지한다", async () => {
    t = await startFakeTarget(strip(ok));
    await record(ws, SYS, spec, target(t.url), { allowMutating: true });
    const ids = ["createPet", "deletePet", "getPet", "inventory.list", "listPets"];
    const ac = new AbortController();
    let n = 0;
    t.close();
    t = await startFakeTarget(strip((q) => { n++; if (n === 2) ac.abort(); return ok(q); }));
    await expect(record(ws, SYS, spec, target(t.url), { allowMutating: true, refresh: true, signal: ac.signal })).rejects.toThrow();
    // 첫 요청은 이미 새로 썼을 수 있지만, 옛 녹화가 지워져서는 안 된다.
    for (const id of ids) expect(await ws.exists(SYS, `recorded/${id}.json`)).toBe(true);
  });

  it("refresh + 첫 요청 연결 실패면 기존 녹화를 유지한다", async () => {
    await ws.writeText(SYS, "recorded/old.json", "{}");
    await expect(record(ws, SYS, spec, target(await closedPortUrl()), { refresh: true })).rejects.toThrow("baseUrl을 확인하세요");
    expect(await ws.exists(SYS, "recorded/old.json")).toBe(true);
  });

  it("비2xx 응답과 raw 바디의 비밀은 녹화 파일에서 가린다", async () => {
    const tok = "Bearer abcdefghijklmnop1234567890";
    t = await startFakeTarget(strip((q) => {
      if (q.path === "/pets") return { status: 401, body: { message: `bad ${tok}` } };
      if (q.path === "/store/inventory") return { status: 200, raw: `echo ${tok}`, contentType: "text/plain" };
      return ok(q);
    }));
    await record(ws, SYS, spec, target(t.url, { params: { petId: "1" } }));
    const unauth = await readFile(ws.file(SYS, "recorded/listPets.json"), "utf8");
    expect(unauth).not.toContain("abcdefghijklmnop");
    expect(unauth).toContain("***");
    const raw = await readFile(ws.file(SYS, "recorded/inventory.list.json"), "utf8");
    expect(raw).not.toContain("abcdefghijklmnop");
    const good = await ws.read(SYS, "recorded/getPet.json", RecordedSchema);
    expect(good.response.body).toEqual(PET);
  });

  it("경계: HEAD 200 빈 바디, 정확히 1MiB, 403 힌트, OPTIONS 건너뜀, 스키마 없는 contract", async () => {
    // HEAD 200 빈 바디 → empty, 실패 아님
    const headSpec: MockSpec = { ...spec, contracts: spec.contracts.map((c) => (c.featureId === "getPet" && c.name === "정상 요청" ? { ...c, request: { ...c.request, method: "HEAD" as const } } : c)) };
    t = await startFakeTarget(strip(ok));
    const h = await record(ws, SYS, headSpec, target(t.url, { params: { petId: "1" } }), { features: ["getPet"] });
    expect(h.result.failed).toEqual([]);
    expect((await ws.read(SYS, "recorded/getPet.json", RecordedSchema)).response.kind).toBe("empty");
    await t.close();

    // 정확히 1,048,576바이트는 truncated 아님, 1바이트 초과는 truncated
    const body = (n: number) => { const pad = n - Buffer.byteLength(JSON.stringify({ id: 1, name: "" })); return { id: 1, name: "x".repeat(pad) }; };
    t = await startFakeTarget(strip((q) => (q.path.startsWith("/pets/") ? { status: 200, body: body(1_048_576) } : ok(q))));
    let r = await record(ws, SYS, spec, target(t.url), { features: ["getPet"] });
    expect(r.result.matched).toEqual(["getPet"]);
    expect((await ws.read(SYS, "recorded/getPet.json", RecordedSchema)).response.kind).toBe("json");
    await t.close();
    t = await startFakeTarget(strip((q) => (q.path.startsWith("/pets/") ? { status: 200, body: body(1_048_577) } : ok(q))));
    r = await record(ws, SYS, spec, target(t.url), { features: ["getPet"] });
    expect(r.result.failed[0].reason).toContain("1MB");
    expect((await ws.read(SYS, "recorded/getPet.json", RecordedSchema)).response.kind).toBe("truncated");
    await t.close();

    // 403 힌트
    t = await startFakeTarget(strip(() => ({ status: 403 })));
    r = await record(ws, SYS, spec, target(t.url), { features: ["listPets"] });
    expect(r.result.statusMismatch[0]).toMatchObject({ actual: 403 });
    expect(r.result.statusMismatch[0].hint).toBeTruthy();
    await t.close();

    // OPTIONS는 기본으로 건너뜀
    const optSpec: MockSpec = { ...spec, contracts: spec.contracts.map((c) => (c.featureId === "listPets" && c.name === "정상 요청" ? { ...c, request: { ...c.request, method: "OPTIONS" as const } } : c)) };
    t = await startFakeTarget(strip(ok));
    r = await record(ws, SYS, optSpec, target(t.url), { features: ["listPets"] });
    expect(r.result.skipped).toEqual([{ featureId: "listPets", reason: "mutating" }]);
    expect(t.requests).toHaveLength(0);

    // 스키마 없는 contract: status가 맞으면 일치
    const noSchema: MockSpec = { ...spec, contracts: spec.contracts.map((c) => (c.featureId === "listPets" && c.name === "정상 요청" ? { ...c, expect: { ...c.expect, schema: null } } : c)) };
    r = await record(ws, SYS, noSchema, target(t.url), { features: ["listPets"] });
    expect(r.result.matched).toEqual(["listPets"]);
  });
  it("출처 기반 마스킹: target 헤더는 이름과 무관하게 전부 ***, contract 헤더는 유지", async () => {
    t = await startFakeTarget(strip(ok));
    const hdr: MockSpec = { ...spec, contracts: spec.contracts.map((c) => (c.featureId === "getPet" && c.name === "정상 요청" ? { ...c, request: { ...c.request, headers: { "x-trace": "keep-me" } } } : c)) };
    const SIG = "sig-plain-1";
    await record(ws, SYS, hdr, target(t.url, { headers: { "X-Signature": SIG, "X-Client-Id": "cid-77" }, secrets: [SIG, "cid-77"] }), { features: ["getPet"] });
    const text = await readFile(ws.file(SYS, "recorded/getPet.json"), "utf8");
    const rec = await ws.read(SYS, "recorded/getPet.json", RecordedSchema);
    expect(text).not.toContain(SIG);
    expect(text).not.toContain("cid-77");
    expect(rec.request.headers["x-signature"]).toBe("***");
    expect(rec.request.headers["x-client-id"]).toBe("***");
    expect(rec.request.headers["x-trace"]).toBe("keep-me");
  });

  it("params의 ${ENV} 값(query 인증)은 녹화 파일·이벤트·drift.md·RecordResult 어디에도 남지 않는다", async () => {
    const KEY = "k9k9";   // 8자 미만이어도 4자 이상이면 가린다
    const withQuery: MockSpec = { ...spec, contracts: spec.contracts.map((c) => (c.featureId === "listPets" && c.name === "정상 요청" ? { ...c, request: { ...c.request, query: { ...c.request.query, apiKey: "x" } } } : c)) };
    t = await startFakeTarget(strip(() => ({ status: 401 })));
    const events: ServiceEvent[] = [];
    const tg = target(t.url, { params: { apiKey: KEY, petId: KEY }, secrets: [KEY] });
    const { result, driftMarkdown } = await record(ws, SYS, withQuery, tg, { features: ["listPets", "getPet"], onEvent: (e) => events.push(e) });
    expect(result.statusMismatch).toHaveLength(2);
    expect(t.requests.some((r) => r.path.includes(KEY))).toBe(true);   // 실제로는 보냈다
    const files = [await readFile(ws.file(SYS, "recorded/listPets.json"), "utf8"), await readFile(ws.file(SYS, "recorded/getPet.json"), "utf8")];
    for (const out of [...files, driftMarkdown, JSON.stringify(result), JSON.stringify(events), await readFile(ws.file(SYS, "drift.md"), "utf8")]) {
      expect(out.includes(KEY)).toBe(false);
    }
    expect(driftMarkdown.includes("***")).toBe(true);
  });

  it("2xx JSON 응답이 에코한 비밀도 녹화 파일에서 ***로 가려지고, 4자 미만 비밀은 건드리지 않는다", async () => {
    const SEC = "echo-secret-77";
    t = await startFakeTarget(strip(() => ({ status: 200, body: { echoKey: SEC, id: 1, n: 12 } })));
    await record(ws, SYS, spec, target(t.url, { headers: { "X-Sig": SEC }, secrets: [SEC, "1"] }), { features: ["listPets"] });
    const text = await readFile(ws.file(SYS, "recorded/listPets.json"), "utf8");
    expect(text).not.toContain(SEC);
    expect(text).toContain("***");
    expect((await ws.read(SYS, "recorded/listPets.json", RecordedSchema)).response.body).toEqual({ echoKey: "***", id: 1, n: 12 });
  });

  it("진행 이벤트의 path도 query 이름 기반(token·key)으로 가린다", async () => {
    t = await startFakeTarget(strip(ok));
    const withToken: MockSpec = { ...spec, contracts: spec.contracts.map((c) => (c.featureId === "listPets" && c.name === "정상 요청" ? { ...c, request: { ...c.request, query: { token: "abcdefghijkl" } } } : c)) };
    const events: ServiceEvent[] = [];
    await record(ws, SYS, withToken, target(t.url), { features: ["listPets"], onEvent: (e) => events.push(e) });
    expect(events[0].message).toContain("token=***");
    expect(events[0].message).not.toContain("abcdefghijkl");
  });
});
