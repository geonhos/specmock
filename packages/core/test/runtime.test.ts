// packages/core/test/runtime.test.ts
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { pickNotMocked, runRuntimeChecks } from "../src/verify/runtime.js";

let server: Server | undefined;
afterEach(async () => { await new Promise((r) => server ? server.close(r) : r(undefined)); server = undefined; });

/** 501·404를 status로 흉내 내는 서버. handler가 경로별 응답을 정한다. */
async function serve(handler: (method: string, path: string) => [number, unknown]): Promise<string> {
  server = createServer((req, res) => {
    const [status, body] = handler(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

describe("pickNotMocked", () => {
  it("선택된 같은 method 경로와 겹치는 항목은 건너뛴다", () => {
    const rt = {
      features: [{ method: "GET" as const, path: "/pets/{petId}" }],
      notMocked: [
        { id: "mine", method: "GET" as const, path: "/pets/mine" },
        { id: "listPets", method: "GET" as const, path: "/pets" },
      ],
    };
    expect(pickNotMocked(rt)?.id).toBe("listPets");
  });
  it("고를 항목이 없으면 null", () => {
    expect(pickNotMocked({ features: [], notMocked: [] })).toBeNull();
  });
});

describe("runRuntimeChecks", () => {
  const rt = { features: [{ method: "GET" as const, path: "/pets/{petId}" }], notMocked: [{ id: "listPets", method: "GET" as const, path: "/pets" }] };

  it("501 not_mocked와 404 unknown_path를 확인한다", async () => {
    const base = await serve((_m, p) => (p === "/pets" ? [501, { error: "not_mocked", feature: "listPets", hint: "x" }] : [404, { error: "unknown_path" }]));
    const checks = await runRuntimeChecks(base, rt);
    expect(checks.map((c) => [c.id, c.passed, c.skipped])).toEqual([["not_mocked", true, false], ["unknown_path", true, false]]);
  });

  it("미선택 경로가 404면 계약 7 실패, 모르는 경로가 200이면 계약 8 실패", async () => {
    const base = await serve(() => [200, {}]);
    const checks = await runRuntimeChecks(base, rt);
    expect(checks.every((c) => !c.passed)).toBe(true);
    expect(checks[0].errors[0]).toBe("status: expected 501, got 200");
  });

  it("runtime 정보가 없으면 계약 8만, notMocked가 비면 계약 7은 skipped", async () => {
    const base = await serve(() => [404, { error: "unknown_path" }]);
    expect((await runRuntimeChecks(base, undefined)).map((c) => c.id)).toEqual(["unknown_path"]);
    const both = await runRuntimeChecks(base, { features: [], notMocked: [] });
    expect(both[0]).toMatchObject({ id: "not_mocked", skipped: true, passed: true });
  });
});
