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

const extractAccepted = (jobId: string) => () => ({ status: 202, body: { ok: true, data: { jobId } } });

it("job-done mode:catalog 완료면 ③으로 이동 (우리가 시작한 작업의 jobId 기준, 진행 표시를 못 봐도)", async () => {
  let phase: "prepared" | "catalog" = "prepared";
  setup("/systems/pets/analyze", docRoutes({
    "POST /api/systems/pets/extract": extractAccepted("j1"),
    "GET /api/systems/pets": () => ({ body: { ok: true, data: phase === "catalog" ? overview("pets", "markdown", "catalog", { done: 3, total: 3 }) : overview("pets", "markdown", "prepared", { done: 0, total: 3 }) } }),
    "GET /api/systems/pets/chunks": () => ({ body: { ok: true, data: chunkRows(phase === "catalog" ? [true, true, true] : [false, false, false]) } }),
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "추출 시작" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "추출 시작" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  phase = "catalog";
  emit("job-done", job({ state: "done", result: { mode: "catalog", via: "llm", incomplete: false } })); // job-started·progress 없이 바로 끝남
  await vi.waitFor(() => expect(window.location.pathname).toBe("/systems/pets/select"));
});

/** 일부 청크가 실패했지만 merge가 catalog를 만든 실제 전이: 작업이 끝나면 overview가 catalog로 바뀐다. */
function incompleteFlow() {
  let phase: "prepared" | "partial" | "full" = "prepared";
  const done = () => (phase === "full" ? [true, true, true] : phase === "partial" ? [true, false, false] : [false, false, false]);
  const api = setup("/systems/pets/analyze", docRoutes({
    "POST /api/systems/pets/extract": extractAccepted("j2"),
    "GET /api/systems/pets": () => {
      const d = done();
      const c = { done: d.filter(Boolean).length, total: 3 };
      return { body: { ok: true, data: phase === "prepared" ? overview("pets", "markdown", "prepared", c) : overview("pets", "markdown", "catalog", c) } };
    },
    "GET /api/systems/pets/chunks": () => ({ body: { ok: true, data: chunkRows(done()) } }),
  }));
  return { api, set: (p: typeof phase) => { phase = p; } };
}
const partialResult = { mode: "catalog", via: "llm", incomplete: true, extract: { total: 3, written: 1, skipped: 0, failed: [{ chunk: 1, error: "x" }, { chunk: 2, error: "y" }] }, merge: { missingChunks: [1, 2] } };

it("일부 청크 실패 + catalog 전이: ②는 불완전 상태로 표·실패·재시도·③ 진행 버튼을 모두 보인다", async () => {
  const flow = incompleteFlow();
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job());
  flow.set("partial"); // merge가 catalog를 써서 overview가 catalog로 바뀐다
  emit("job-done", job({ state: "done", result: partialResult }));
  const retry = await screen.findByRole("button", { name: "실패한 청크 2개만 다시 추출" });
  expect(window.location.pathname).toBe("/systems/pets/analyze");
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getAllByText("실패")).toHaveLength(2);
  expect(screen.getByText(/불완전/)).toBeTruthy();
  fireEvent.click(retry);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("청크 2개를");
  fireEvent.click(within(dialog).getByRole("button", { name: "추출 시작" }));
  await vi.waitFor(() => expect(flow.api.calls).toContain("POST /api/systems/pets/extract"));
  expect(flow.api.bodies[flow.api.calls.indexOf("POST /api/systems/pets/extract")]).toEqual({ refresh: false });
  flow.set("full");
  emit("job-started", job({ id: "j2" }));
  emit("job-done", job({ id: "j2", state: "done", result: { mode: "catalog", via: "llm", incomplete: false } }));
  await vi.waitFor(() => expect(window.location.pathname).toBe("/systems/pets/select"));
});

it("불완전 상태에서도 '그래도 ③ 기능 선택으로'로 넘어갈 수 있다", async () => {
  const flow = incompleteFlow();
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job());
  flow.set("partial");
  emit("job-done", job({ state: "done", result: partialResult }));
  fireEvent.click(await screen.findByRole("button", { name: "그래도 ③ 기능 선택으로" }));
  expect(window.location.pathname).toBe("/systems/pets/select");
});

it("새로 고침 뒤에도(작업 결과 없음) 청크가 덜 끝난 catalog는 불완전로 보이고 미완료 수로 재시도한다", async () => {
  setup("/systems/pets/analyze", {
    "GET /api/systems": ok([sys("pets", "markdown", true, { done: 1, total: 3 })]),
    "GET /api/systems/pets": ok(overview("pets", "markdown", "catalog", { done: 1, total: 3 })),
    "GET /api/systems/pets/chunks": ok(chunkRows([true, false, false])),
  });
  render(<App />);
  const retry = await screen.findByRole("button", { name: "실패한 청크 2개만 다시 추출" });
  expect(screen.queryAllByText("실패")).toHaveLength(0); // 어떤 청크가 실패했는지 모르면 '대기'로 둔다
  fireEvent.click(retry);
  expect(screen.getByRole("dialog").textContent).toContain("청크 2개를");
  expect(screen.getByRole("button", { name: "그래도 ③ 기능 선택으로" })).toBeTruthy();
});

it("실패 수는 0이고 merge.missingChunks만 있으면 미완료(total-done) 수로 안내한다", async () => {
  const flow = incompleteFlow();
  render(<App />);
  await screen.findByRole("table");
  emit("job-started", job());
  flow.set("partial");
  emit("job-done", job({ state: "done", result: { mode: "catalog", via: "llm", incomplete: true, extract: { total: 3, written: 3, skipped: 0, failed: [] }, merge: { missingChunks: [1, 2] } } }));
  fireEvent.click(await screen.findByRole("button", { name: "실패한 청크 2개만 다시 추출" }));
  expect(screen.getByRole("dialog").textContent).toContain("청크 2개를");
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

it("409 busy 알림은 진행 표시가 나오면 사라진다", async () => {
  let listed = false;
  setup("/systems/pets/analyze", docRoutes({
    "POST /api/systems/pets/extract": () => { listed = true; return { status: 409, body: { ok: false, error: { code: "busy", message: "이 시스템에서 진행 중인 작업이 있어요." }, jobId: "j9" } }; },
    "GET /api/jobs": () => ({ body: { ok: true, data: { running: listed ? [job({ id: "j9", progress: { message: "x", done: 1, total: 3 } })] : [], recent: [] } } }),
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "추출 시작" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "추출 시작" }));
  await screen.findByRole("progressbar");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("다른 종류의 작업(생성)이 진행 중이면 그 작업 종류와 진행을 안내한다", async () => {
  setup("/systems/pets/analyze", docRoutes({
    "GET /api/jobs": ok({ running: [job({ id: "g1", kind: "generate", cancellable: false, progress: { message: "파일 쓰는 중", done: 2, total: 5 } })], recent: [] }),
    "POST /api/systems/pets/extract": () => ({ status: 409, body: { ok: false, error: { code: "busy", message: "이 시스템에서 진행 중인 작업이 있어요." }, jobId: "g1" } }),
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "추출 시작" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "추출 시작" }));
  const note = await screen.findByRole("status");
  expect(note.textContent).toContain("다른 작업(생성)이 진행 중이에요");
  expect(note.textContent).toContain("파일 쓰는 중");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("분석 요청을 보내는 동안 비활성인 버튼은 이유를 안내한다 (aria-describedby)", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  setup("/systems/petstore/analyze", {
    "GET /api/systems": ok([sys("petstore", "openapi")]),
    "GET /api/systems/petstore": ok(overview("petstore", "openapi", "none")),
    "POST /api/systems/petstore/analyze": () => ({ body: { ok: true, data: { mode: "prepared" } } }),
  });
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => { if (init?.method === "POST") await gate; return inner(input, init); });
  render(<App />);
  const btn = (await screen.findByRole("button", { name: "분석하기" })) as HTMLButtonElement;
  fireEvent.click(btn);
  await vi.waitFor(() => expect(btn.disabled).toBe(true));
  const reason = document.getElementById(btn.getAttribute("aria-describedby") ?? "none");
  expect(reason?.textContent).toMatch(/보내는 중/);
  release();
  await vi.waitFor(() => expect(btn.disabled).toBe(false));
});
