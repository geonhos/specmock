import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { FakeEventSource.all = []; vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

const steps = (analyzed: boolean) => ({ registered: true, analyzed, selected: false, generated: false, verified: false });
const sys = (name: string, kind: string, analyzed = false, chunks?: { done: number; total: number }) => ({ name, kind, steps: steps(analyzed), stale: {}, ...(chunks ? { chunks } : {}) });
const overview = (name: string, kind: string, analyze: "none" | "prepared" | "catalog", chunks?: { done: number; total: number }) => ({
  summary: sys(name, kind, analyze === "catalog", chunks), source: [{ kind, origin: `/x/${name}`, chars: 100 }], analyze, catalogTotal: analyze === "catalog" ? 12 : 0, selection: null, generate: null, coverage: null, defaultOutDir: `/r/mock/${name}`,
});
const chunkRows = (done: boolean[]) => done.map((d, i) => ({ index: i, heading: `섹션 ${i + 1}`, chars: 1000 * (i + 1), contentHash: `h${i}`, done: d }));

function setup(path: string, routes: Record<string, () => { status?: number; body: unknown }>, claude = true) {
  window.history.replaceState(null, "", path);
  return fakeApi({
    "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude } } }),
    "GET /api/jobs": () => ({ body: { ok: true, data: { running: [], recent: [] } } }),
    ...routes,
  });
}
const ok = (data: unknown) => () => ({ body: { ok: true, data } });
const emit = (name: string, data: unknown) => act(() => FakeEventSource.last!.emit(name, data));
const job = (over: Record<string, unknown> = {}) => ({ id: "j1", system: "pets", kind: "extract", state: "running", cancellable: true, startedAt: "t", ...over });

it("OpenAPI: 분석하기 버튼 하나, 누르면 POST /analyze 후 mode:catalog면 ③으로 이동", async () => {
  const api = setup("/systems/petstore/analyze", {
    "GET /api/systems": ok([sys("petstore", "openapi")]),
    "GET /api/systems/petstore": ok(overview("petstore", "openapi", "none")),
    "POST /api/systems/petstore/analyze": ok({ mode: "catalog", via: "openapi" }),
  });
  render(<App />);
  expect(screen.queryByRole("button", { name: "추출 시작" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "분석하기" }));
  await vi.waitFor(() => expect(window.location.pathname).toBe("/systems/petstore/select"));
  expect(api.calls).toContain("POST /api/systems/petstore/analyze");
});

it("문서: analyze가 prepared면 청크 표(제목·글자 수·상태)", async () => {
  setup("/systems/pets/analyze", {
    "GET /api/systems": ok([sys("pets", "markdown", false, { done: 1, total: 3 })]),
    "GET /api/systems/pets": ok(overview("pets", "markdown", "prepared", { done: 1, total: 3 })),
    "GET /api/systems/pets/chunks": ok(chunkRows([true, false, false])),
  });
  render(<App />);
  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(4); // 머리글 + 3
  expect(within(rows[1]!).getByText("섹션 1")).toBeTruthy();
  expect(within(rows[1]!).getByText("1,000")).toBeTruthy();
  expect(within(rows[1]!).getByText("완료")).toBeTruthy();
  expect(within(rows[2]!).getByText("대기")).toBeTruthy();
});

const docRoutes = (extra: Record<string, () => { status?: number; body: unknown }> = {}) => ({
  "GET /api/systems": ok([sys("pets", "markdown", false, { done: 0, total: 3 })]),
  "GET /api/systems/pets": ok(overview("pets", "markdown", "prepared", { done: 0, total: 3 })),
  "GET /api/systems/pets/chunks": ok(chunkRows([false, false, false])),
  ...extra,
});

it("추출 시작 → 확인 창 문구. 취소는 호출 없음, 확인하면 POST /extract {refresh:false}", async () => {
  const api = setup("/systems/pets/analyze", docRoutes({ "POST /api/systems/pets/extract": () => ({ status: 202, body: { ok: true, data: { jobId: "j1" } } }) }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "추출 시작" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("청크 3개를 claude CLI로 추출해요. 구독 사용량이 발생해요.");
  expect(dialog.querySelector("code")?.textContent).toBe("claude");
  fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.some((c) => c.includes("/extract"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "추출 시작" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "추출 시작" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/pets/extract"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/pets/extract")]).toEqual({ refresh: false });
});

it("진행: job-progress → 진행 바 aria-valuenow/max, 취소는 POST /api/jobs/<id>/cancel", async () => {
  const api = setup("/systems/pets/analyze", docRoutes({ "POST /api/jobs/j1/cancel": ok({ state: "running" }) }));
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job());
  emit("job-progress", job({ progress: { message: "추출 1/3", done: 1, total: 3 } }));
  const bar = await screen.findByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("1");
  expect(bar.getAttribute("aria-valuemax")).toBe("3");
  expect(screen.queryByRole("button", { name: "추출 시작" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/jobs/j1/cancel"));
});

it("cancellable이 false인 작업에는 취소 버튼이 없다", async () => {
  setup("/systems/pets/analyze", docRoutes());
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job({ cancellable: false }));
  await screen.findByRole("progressbar");
  expect(screen.queryByRole("button", { name: "취소" })).toBeNull();
});

it("새로 고침해도(작업 목록에 running) 진행 표시가 이어진다", async () => {
  setup("/systems/pets/analyze", docRoutes({ "GET /api/jobs": ok({ running: [job({ progress: { message: "x", done: 2, total: 3 } })], recent: [] }) }));
  render(<App />);
  expect((await screen.findByRole("progressbar")).getAttribute("aria-valuenow")).toBe("2");
});

it("job-done mode:catalog면 ③으로 이동, incomplete면 이동하지 않고 실패 청크만 다시 추출 버튼", async () => {
  const api = setup("/systems/pets/analyze", docRoutes({ "POST /api/systems/pets/extract": () => ({ status: 202, body: { ok: true, data: { jobId: "j2" } } }) }));
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job());
  emit("job-done", job({ state: "done", result: { mode: "catalog", via: "llm", incomplete: true, extract: { total: 3, written: 1, skipped: 0, failed: [{ chunk: 1, error: "x" }, { chunk: 2, error: "y" }] }, merge: { missingChunks: [1, 2] } } }));
  const retry = await screen.findByRole("button", { name: "실패한 청크 2개만 다시 추출" });
  expect(window.location.pathname).toBe("/systems/pets/analyze");
  expect(screen.getAllByText("실패").length).toBeGreaterThan(0);
  fireEvent.click(retry);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "추출 시작" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/pets/extract"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/pets/extract")]).toEqual({ refresh: false });

  emit("job-started", job({ id: "j3" }));
  emit("job-done", job({ id: "j3", state: "done", result: { mode: "catalog", via: "llm", incomplete: false } }));
  await vi.waitFor(() => expect(window.location.pathname).toBe("/systems/pets/select"));
});

it("claude CLI가 없으면 추출 시작 대신 대화에서 추출 안내", async () => {
  setup("/systems/pets/analyze", docRoutes(), false);
  render(<App />);
  await screen.findByRole("table");
  const note = await screen.findByRole("note");
  expect(note.textContent).toBe("이 컴퓨터에서 claude CLI를 찾지 못했어요. Claude Code 대화에서 analyze_spec부터 진행하면 추출 결과가 이 화면에 바로 반영돼요.");
  expect(screen.queryByRole("button", { name: "추출 시작" })).toBeNull();
});

it("409 busy + jobId면 그 작업의 진행 표시로 이어진다", async () => {
  let listed = false;
  setup("/systems/pets/analyze", docRoutes({
    "POST /api/systems/pets/extract": () => { listed = true; return { status: 409, body: { ok: false, error: { code: "busy", message: "이 시스템에서 진행 중인 작업이 있어요." }, jobId: "j9" } }; },
    "GET /api/jobs": () => ({ body: { ok: true, data: { running: listed ? [job({ id: "j9", progress: { message: "x", done: 1, total: 3 } })] : [], recent: [] } } }),
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "추출 시작" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "추출 시작" }));
  expect((await screen.findByRole("progressbar")).getAttribute("aria-valuenow")).toBe("1");
});

it("workspace-changed(extracted/…)가 오면 청크 표를 다시 불러온다 (대화에서 제출한 결과 반영)", async () => {
  let done = [false, false, false];
  const api = setup("/systems/pets/analyze", docRoutes({ "GET /api/systems/pets/chunks": () => ({ body: { ok: true, data: chunkRows(done) } }) }));
  render(<App />);
  await screen.findByRole("table");
  expect(screen.queryByText("완료")).toBeNull();
  done = [true, false, false];
  emit("workspace-changed", { system: "pets", files: ["extracted/000.json"] });
  expect(await screen.findByText("완료")).toBeTruthy();
  expect(api.calls.filter((c) => c.endsWith("/chunks")).length).toBeGreaterThanOrEqual(2);
});

it("실패한 작업과 취소된 작업은 안내를 보인다", async () => {
  setup("/systems/pets/analyze", docRoutes());
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job());
  emit("job-failed", job({ state: "failed", error: { code: "failed", message: "claude 실행에 실패했어요" } }));
  expect((await screen.findByRole("alert")).textContent).toContain("claude 실행에 실패했어요");
});

it("이미 분석을 마친 시스템은 기능 수와 ③으로 가는 버튼", async () => {
  setup("/systems/petstore/analyze", {
    "GET /api/systems": ok([sys("petstore", "openapi", true)]),
    "GET /api/systems/petstore": ok(overview("petstore", "openapi", "catalog")),
  });
  render(<App />);
  expect(await screen.findByText(/기능 12개/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "③ 기능 선택으로" }));
  expect(window.location.pathname).toBe("/systems/petstore/select");
});
