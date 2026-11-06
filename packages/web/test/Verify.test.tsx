import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { FakeEventSource.all = []; vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

const mkSys = (stale: Record<string, boolean> = {}) => ({ name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: true, verified: false }, stale });
const COVERAGE = "# Coverage\n\n선택 3개 중 mock 3개\n\n## contract test\n\n| 기능 | 결과 |\n";
const overview = (stale: Record<string, boolean> = {}, coverage: string | null = null) => ({
  summary: mkSys(stale), source: [{ kind: "openapi", origin: "/x/petstore.yaml", chars: 100 }], analyze: "catalog", catalogTotal: 3, selection: null, generate: { outDir: "/r/mock/petstore", generatedAt: "t" }, coverage, defaultOutDir: "/r/mock/petstore",
});
const ok = (data: unknown) => () => ({ body: { ok: true, data } });
const job = (over: Record<string, unknown> = {}) => ({ id: "v1", system: "petstore", kind: "verify", state: "running", cancellable: true, startedAt: "t", ...over });
const emit = (name: string, data: unknown) => act(() => FakeEventSource.last!.emit(name, data));

function setup(stale: Record<string, boolean> = {}, coverage: string | null = null, extra: Record<string, () => { status?: number; body: unknown }> = {}) {
  window.history.replaceState(null, "", "/systems/petstore/verify");
  return fakeApi({
    "GET /api/env": ok({ root: "/r", claude: true }),
    "GET /api/jobs": ok({ running: [], recent: [] }),
    "GET /api/systems": ok([mkSys(stale)]),
    "GET /api/systems/petstore": ok(overview(stale, coverage)),
    "POST /api/systems/petstore/verify": () => ({ status: 202, body: { ok: true, data: { jobId: "v1" } } }),
    "POST /api/jobs/v1/cancel": ok({ state: "cancelled" }),
    ...extra,
  });
}
const result = {
  dir: "/r/mock/petstore", coverageFile: "/c.md", coverageMarkdown: COVERAGE,
  result: {
    mockDir: "/r/mock/petstore", total: 3, passed: 2, failed: 1,
    results: [
      { featureId: "listPets", name: "List pets", passed: true, expectedStatus: 200, actualStatus: 200, errors: [] },
      { featureId: "getPet", name: "Get a pet", passed: true, expectedStatus: 200, actualStatus: 200, errors: [] },
      { featureId: "createPet", name: "Create a pet", passed: false, expectedStatus: 201, actualStatus: 500, errors: ["상태 코드 201 기대, 500 받음", "body.id 없음"] },
    ],
  },
};

async function start(api: ReturnType<typeof setup>) {
  fireEvent.click(await screen.findByRole("button", { name: "검증 시작" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/verify"));
  emit("job-started", job());
}

it("검증 시작 → POST /verify, 진행 메시지와 취소 버튼, 취소는 POST /api/jobs/<id>/cancel", async () => {
  const api = setup();
  render(<App />);
  await start(api);
  emit("job-progress", job({ progress: { message: "npm install…" } }));
  expect(await screen.findByText("npm install…")).toBeTruthy();
  emit("job-progress", job({ progress: { message: "계약 테스트 3/5", done: 3, total: 5 } }));
  expect(await screen.findByText("계약 테스트 3/5")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/jobs/v1/cancel"));
});

it("job-done: 통과 N · 실패 M, 커버리지 요약(## contract test 앞), 기능별 표 — 통과 ok/실패 danger 글자, alert 없음", async () => {
  const api = setup();
  render(<App />);
  await start(api);
  emit("job-done", job({ state: "done", result }));
  expect(await screen.findByText("통과 2 · 실패 1")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  const pre = document.querySelector("pre.coverage")!;
  expect(pre.textContent).toContain("선택 3개 중 mock 3개");
  expect(pre.textContent).not.toContain("contract test");
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(4);
  expect(within(rows[1]!).getByText("통과").className).toContain("st-done");
  expect(within(rows[3]!).getByText("실패").className).toContain("st-failed");
  expect(within(rows[3]!).getByText("Create a pet")).toBeTruthy();
});

it("실패 행은 펼쳐 이유를 본다", async () => {
  const api = setup();
  render(<App />);
  await start(api);
  emit("job-done", job({ state: "done", result }));
  const toggle = await screen.findByRole("button", { name: /이유 보기/ });
  expect(screen.queryByText(/body\.id 없음/)).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/상태 코드 201 기대, 500 받음/)).toBeTruthy();
  expect(screen.getByText(/body\.id 없음/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /이유 (보기|닫기)/ })).toHaveLength(1); // 통과 행에는 없음
});

it("앞서 만든 coverage는 화면을 열 때 overview에서 보인다(작업 결과 없이)", async () => {
  setup({}, COVERAGE);
  render(<App />);
  await vi.waitFor(() => expect(document.querySelector("pre.coverage")?.textContent).toContain("선택 3개 중 mock 3개"));
});

it("stale.verify면 '다시 실행 필요'", async () => {
  setup({ verify: true });
  render(<App />);
  expect(await screen.findByRole("note")).toBeTruthy();
  expect(screen.getByRole("note").textContent).toContain("다시 실행 필요");
});

it("앞 단계(선택·생성) 변경도 '다시 실행 필요'로 보인다", async () => {
  setup({ generate: true });
  render(<App />);
  expect((await screen.findByRole("note")).textContent).toContain("다시 실행 필요");
});

it("stale이 없으면 표시 없음", async () => {
  setup();
  render(<App />);
  await screen.findByRole("button", { name: "검증 시작" });
  expect(screen.queryByRole("note")).toBeNull();
});

it("작업 실패는 alert, 취소는 안내", async () => {
  const api = setup();
  render(<App />);
  await start(api);
  emit("job-failed", job({ state: "failed", error: { code: "failed", message: "npm install 실패" } }));
  expect((await screen.findByRole("alert")).textContent).toContain("npm install 실패");
});

it("취소되면 안내 문구", async () => {
  const api = setup();
  render(<App />);
  await start(api);
  emit("job-failed", job({ state: "cancelled", error: { code: "cancelled", message: "취소됨" } }));
  expect(await screen.findByText(/검증을 취소했어요/)).toBeTruthy();
});
