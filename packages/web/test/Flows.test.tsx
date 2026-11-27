import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FlowDetail, FlowRun, Job, StepResult } from "@specmock/ui-server/api-types";
import { Flows } from "../src/screens/Flows";
import { STATE_LABEL } from "../src/flowModel";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());
const ok = (data: unknown) => () => ({ body: { ok: true, data } });
const step = (id: string, role: "prep" | "main" | "cleanup", inputs: FlowDetail["flow"]["steps"][number]["inputs"] = []) => ({ id, featureId: `f_${id}`, role, inputs });
const flow: FlowDetail["flow"] = { id: "issues", name: "issue 다루기", resource: "issue", steps: [
  step("create_issue", "main", [{ slot: "body.title", source: { kind: "empty" }, basis: "rule" }, { slot: "path.repo", source: { kind: "user", value: "r" }, basis: "claude" }]),
  step("get_issue", "main", [{ slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule" }]),
] };
const res = (stepId: string, state: StepResult["state"], body: unknown, values = {}): StepResult => ({ stepId, featureId: "f", role: "main", state, reason: state === "success" ? null : `${state} 이유`, missing: [], request: { method: "GET", url: "http://x/1", headers: {}, body: null }, response: { status: 200, kind: "json", body: body as never }, schemaErrors: [], values, durationMs: 1 });
const run = (target: "mock" | "real", steps: StepResult[], leftovers: FlowRun["leftovers"] = []): FlowRun => ({ flowId: "issues", target, startedAt: "a", finishedAt: "b", safety: target === "real", cleanup: true, suffix: "", outcome: "success", error: null, steps, leftovers });
const routes = (detail: Partial<FlowDetail> = {}, safety = true) => ({
  "GET /api/systems/gh/flows": ok({ inferredAt: "t", notes: ['issue: 삭제 기능이 없어 실행 뒤 "남은 자원"으로 알립니다.'], flows: [{ id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: [], last: { mock: null, real: null } }] }),
  "GET /api/systems/gh/flows/issues": ok({ flow, empty: ["create_issue:body.title"], missingFeatures: [], runs: { mock: null, real: null }, ...detail }),
  "GET /api/systems/gh/safety": ok({ on: safety }),
});
const mount = () => render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);

it("list shows empty-input count; chart shows '입력 필요', edge names before a run, basis badges", async () => {
  fakeApi(routes());
  mount();
  const list = await screen.findByRole("navigation", { name: "흐름" });
  expect(within(list).getByRole("button", { name: /issue 다루기.*빈 연결 1/ })).toBeTruthy();
  expect(await screen.findByText("입력 필요")).toBeTruthy();
  expect(screen.getByText("number")).toBeTruthy(); // 실행 전: 연결 이름
  expect(screen.getAllByText(STATE_LABEL.pending).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: /create_issue/ }));
  expect(screen.getByText("Claude Code")).toBeTruthy();
  expect(screen.getByText("규칙")).toBeTruthy();
});

it("renders all eight states with label and class", async () => {
  const states = ["success", "diff", "failed", "skipped-safety", "stopped-empty", "cleaned", "leftover"] as const;
  const many: FlowDetail["flow"] = { ...flow, steps: [...states.map((s) => step(s.replace("-", "_"), "main")), step("not_run", "main")] }; // not_run has no result → pending
  fakeApi(routes({ flow: many, empty: [], runs: { mock: run("mock", states.map((s) => res(s.replace("-", "_"), s, {}))), real: null } }));
  mount();
  for (const s of ["pending", ...states] as const) {
    const el = (await screen.findAllByText(STATE_LABEL[s]))[0]!;
    expect(el.closest(`.st-${s}`)).not.toBeNull();
  }
});

it("after a run: edge shows `field = value`; expanded step shows only differing fields first, then 전체 보기", async () => {
  fakeApi(routes({ empty: [], runs: {
    mock: run("mock", [res("create_issue", "success", { number: 1, title: "a" }), res("get_issue", "success", { number: 1 }, { "path.issue_number": 1 })]),
    real: run("real", [res("create_issue", "success", { number: 7, title: "a" }), res("get_issue", "success", { number: 7 }, { "path.issue_number": 7 })]) } }));
  mount();
  expect(await screen.findByText("number = 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /create_issue/ }));
  const card = screen.getByRole("region", { name: "create_issue 결과" });
  expect(within(card).getByText("차이 난 필드: number")).toBeTruthy();
  expect(within(card).queryByText(/"title"/)).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "전체 보기" }));
  expect(within(card).getAllByText(/"title"/).length).toBe(2);
});

it("fill an empty input with a user value → POST inputs with source user", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/flows/issues/inputs": ok({ flow, empty: [], missingFeatures: [], runs: { mock: null, real: null } }) });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /create_issue/ }));
  fireEvent.change(screen.getByLabelText("body.title 값"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "body.title 저장" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/gh/flows/issues/inputs"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/gh/flows/issues/inputs")]).toEqual({ stepId: "create_issue", slot: "body.title", source: { kind: "user", value: "hello" } });
});

it("switch a user-valued input to an earlier step's response field and save the new source", async () => {
  // c's slot starts as a user value with no createdBy, so nothing is preselected; "b" is not the default step.
  const three: FlowDetail["flow"] = { ...flow, steps: [step("a", "prep"), step("b", "main"),
    step("c", "main", [{ slot: "body.owner", source: { kind: "user", value: "x" }, basis: "user" }])] };
  const detail = { flow: three, empty: [], missingFeatures: [], runs: { mock: null, real: null } };
  const api = fakeApi({ ...routes(detail), "POST /api/systems/gh/flows/issues/inputs": ok(detail) });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /f_c/ }));
  fireEvent.click(screen.getByRole("combobox", { name: "body.owner 출처" }));
  fireEvent.click(await screen.findByRole("option", { name: "앞 단계 응답" }));
  fireEvent.click(screen.getByRole("combobox", { name: "body.owner 앞 단계" }));
  fireEvent.click(await screen.findByRole("option", { name: "b" }));
  fireEvent.change(screen.getByLabelText("body.owner 응답 필드"), { target: { value: "id" } });
  fireEvent.click(screen.getByRole("button", { name: "body.owner 저장" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/gh/flows/issues/inputs"));
  expect(api.bodies.at(-1)).toEqual({ stepId: "c", slot: "body.owner", source: { kind: "step", step: "b", field: "id" } });
});

it("run with empty inputs is allowed; targets and cleanup go to the run route", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/flows/issues/run": ok({ jobId: "j1" }) });
  mount();
  fireEvent.click(await screen.findByRole("radio", { name: "둘 다" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "정리" }));
  fireEvent.click(screen.getByRole("button", { name: "전체 실행" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/gh/flows/issues/run"));
  expect(api.bodies.at(-1)).toEqual({ targets: ["mock", "real"], cleanup: false });
});

it("safety off colours the top bar; the switch posts to the server", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/safety": ok({ on: false }) });
  mount();
  const sw = await screen.findByRole("switch", { name: "안전장치" });
  expect((sw as HTMLInputElement).checked).toBe(true);
  fireEvent.click(sw);
  await vi.waitFor(() => expect(screen.getByRole("toolbar", { name: "흐름 실행" }).closest('[data-safety="off"]')).not.toBeNull());
  expect(screen.getByText("실제 서버에 변경 요청을 보냅니다")).toBeTruthy();
  expect(api.bodies.at(-1)).toEqual({ on: false });
});

it("leftovers list shows URL and id; missing features block the run", async () => {
  fakeApi(routes({ missingFeatures: ["f_get_issue"], runs: { mock: null, real: run("real", [], [{ resource: "issue", stepId: "create_issue", url: "https://api.github.com/repos/o/r/issues/7", id: "7", reason: "삭제 기능이 없어요" }]) } }));
  mount();
  const left = await screen.findByRole("region", { name: "남은 자원" });
  expect(within(left).getByText("https://api.github.com/repos/o/r/issues/7")).toBeTruthy();
  expect(within(left).getByText("7")).toBeTruthy();
  expect(screen.getByText(/기능 없음: f_get_issue/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "전체 실행" }).getAttribute("aria-disabled")).toBe("true");
});

const flowJob = (state: Job["state"], result?: unknown): Job => ({ id: "j1", system: "gh", kind: "flow", state, cancellable: true, startedAt: "a", ...(result === undefined ? {} : { result }) });

it("safety is read per service: switching service shows that service's value (#45, decision 11)", async () => {
  const glFlow = { ...flow, id: "glissues" };
  const api = fakeApi({ ...routes({}, false), // gh: safety off
    "GET /api/systems/gl/flows": ok({ inferredAt: "t", notes: [], flows: [{ id: "glissues", name: "issue 다루기", resource: "issue", steps: 2, empty: 0, missingFeatures: [], last: { mock: null, real: null } }] }),
    "GET /api/systems/gl/flows/glissues": ok({ flow: glFlow, empty: [], missingFeatures: [], runs: { mock: null, real: null } }),
    "GET /api/systems/gl/safety": ok({ on: true }) });
  const { rerender } = render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);
  expect(((await screen.findByRole("switch", { name: "안전장치" })) as HTMLInputElement).checked).toBe(false);
  rerender(<Flows system="gl" jobs={[]} tick={0} refreshJobs={() => {}} />);
  await vi.waitFor(() => expect(api.calls).toContain("GET /api/systems/gl/safety"));
  await vi.waitFor(() => expect(((screen.getByRole("switch", { name: "안전장치" })) as HTMLInputElement).checked).toBe(true));
  // Back to gh: false again. A Flows that ignored the response would show the initial true here.
  rerender(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);
  await vi.waitFor(() => expect(((screen.getByRole("switch", { name: "안전장치" })) as HTMLInputElement).checked).toBe(false));
});

it("a running flow job shows 실행 취소, which posts the job cancel", async () => {
  const api = fakeApi({ ...routes(), "POST /api/jobs/j1/cancel": ok({ state: "running" }) });
  render(<Flows system="gh" jobs={[flowJob("running")]} tick={0} refreshJobs={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "실행 취소" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/jobs/j1/cancel"));
});

it("cancelled run: outcome 취소됨, unsent steps stay 실행 전, targets in notRun are named", async () => {
  const cancelled: FlowRun = { ...run("mock", [res("create_issue", "success", { number: 1 }),
    { ...res("get_issue", "pending", null), reason: "취소되어 실행하지 않았습니다.", request: null, response: null }]), outcome: "cancelled" };
  fakeApi(routes({ empty: [], runs: { mock: cancelled, real: null } }));
  const { rerender } = render(<Flows system="gh" jobs={[flowJob("running")]} tick={0} refreshJobs={() => {}} />);
  rerender(<Flows system="gh" jobs={[flowJob("done", { runs: [cancelled], notRun: ["real"] })]} tick={1} refreshJobs={() => {}} />);
  expect(await screen.findByText("취소됨")).toBeTruthy();
  expect(screen.getAllByText(STATE_LABEL.pending).length).toBeGreaterThan(0);
  expect(screen.getByText("실행하지 않은 대상: 실제")).toBeTruthy();
});

it("picking another flow in the list opens that flow", async () => {
  const other = { ...flow, id: "repos", name: "repo 다루기" };
  const r = routes();
  fakeApi({ ...r,
    "GET /api/systems/gh/flows": ok({ inferredAt: "t", notes: [], flows: [
      { id: "repos", name: "repo 다루기", resource: "repo", steps: 1, empty: 0, missingFeatures: [], last: { mock: null, real: null } },
      { id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: [], last: { mock: null, real: null } }] }),
    "GET /api/systems/gh/flows/repos": ok({ flow: other, empty: [], missingFeatures: [], runs: { mock: null, real: null } }) });
  mount();
  expect(await screen.findByRole("heading", { name: "repo 다루기" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("navigation", { name: "흐름" })).getByRole("button", { name: /issue 다루기/ }));
  expect(await screen.findByRole("heading", { name: "issue 다루기" })).toBeTruthy();
});
