import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());

it("ok면 data를, 아니면 ApiError(code, hint)를", async () => {
  fakeApi({
    "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude: false } } }),
    "GET /api/systems/x/features": () => ({ status: 404, body: { ok: false, error: { code: "not-found", message: "없음", hint: "먼저 ② 분석을 진행해 주세요." } } }),
  });
  expect(await api.env()).toEqual({ root: "/r", claude: false });
  await expect(api.features("x")).rejects.toMatchObject({ code: "not-found", hint: "먼저 ② 분석을 진행해 주세요." });
  await expect(api.features("x")).rejects.toBeInstanceOf(ApiError);
});

it("409 busy는 jobId를 싣고, POST 본문은 JSON, 이름은 인코딩한다", async () => {
  const f = fakeApi({
    "POST /api/systems/a%20b/extract": () => ({ status: 409, body: { ok: false, error: { code: "busy", message: "진행 중" }, jobId: "j1" } }),
  });
  await expect(api.extract("a b", true)).rejects.toMatchObject({ status: 409, code: "busy", jobId: "j1" });
  expect(f.bodies[0]).toEqual({ refresh: true });
});
