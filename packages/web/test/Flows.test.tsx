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
  "GET /api/systems/gh/flows/issues": ok({ flow, empty: ["create_issue:body.title"], missingFeatures: [], features: { f_create_issue: { method: "POST", path: "/repos/{owner}/{repo}/issues" } }, runs: { mock: null, real: null }, ...detail }),
  "GET /api/systems/gh/safety": ok({ on: safety }),
});
const mount = () => render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);

it("list shows empty-input count; chart shows '입력 필요', edge names before a run, basis badges", async () => {
  fakeApi(routes());
  mount();
  const list = await screen.findByRole("navigation", { name: "흐름" });
  const item = within(list).getByRole("button", { name: /issue 다루기/ });
  expect(item.getAttribute("href")).toBeNull();
  const header = await screen.findByRole("button", { name: /POST/ });
  expect(within(header).getByText("POST").className).toContain("flow-method");
  expect(within(header).getByText("/repos/{owner}/{repo}/issues")).toBeTruthy();
  expect(within(header).getByText("create_issue")).toBeTruthy(); // the step id stays visible
  expect(screen.getByRole("button", { name: /f_get_issue/ })).toBeTruthy(); // no catalog entry: the feature id is shown
  expect(await screen.findByText("입력 필요")).toBeTruthy();
  expect(screen.getByText("number")).toBeTruthy(); // before a run: the edge shows the field name
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
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/flows/issues/inputs": ok({ flow, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } }) });
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
  const detail = { flow: three, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } };
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
    "GET /api/systems/gl/flows/glissues": ok({ flow: glFlow, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } }),
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
  fakeApi({ ...routes({ empty: [], runs: { mock: cancelled, real: null } }), "POST /api/systems/gh/flows/issues/run": ok({ jobId: "j1" }) });
  const { rerender } = render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "전체 실행" })); // the screen remembers that this flow started j1
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "전체 실행" })).toBeTruthy());
  rerender(<Flows system="gh" jobs={[flowJob("running")]} tick={0} refreshJobs={() => {}} />);
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
    "GET /api/systems/gh/flows/repos": ok({ flow: other, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } }) });
  mount();
  expect(await screen.findByRole("heading", { name: "repo 다루기" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("navigation", { name: "흐름" })).getByRole("button", { name: /issue 다루기/ }));
  expect(await screen.findByRole("heading", { name: "issue 다루기" })).toBeTruthy();
});

const fail = (status: number, message = "서버 오류") => () => ({ status, body: { ok: false, error: { code: "boom", message } } });

it("GET /flows fails → an alert says what failed and what to do (no blank screen)", async () => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": fail(500) });
  mount();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("흐름 목록을 불러오지 못했습니다");
  expect(alert.textContent).toContain("새로 고");
});

it("the first GET /flows/:id fails → alert shown and the list stays visible", async () => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows/issues": fail(500) });
  mount();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("흐름을 불러오지 못했습니다");
  expect(within(screen.getByRole("navigation", { name: "흐름" })).getByRole("button", { name: /issue 다루기/ })).toBeTruthy();
});

it("a failed safety read shows a notice and a disabled switch, with no off colour; a later read restores it", async () => {
  const glFlow = { ...flow, id: "glissues" };
  fakeApi({ ...routes(),
    "GET /api/systems/gh/safety": fail(500),
    "GET /api/systems/gl/flows": ok({ inferredAt: "t", notes: [], flows: [{ id: "glissues", name: "issue 다루기", resource: "issue", steps: 2, empty: 0, missingFeatures: [], last: { mock: null, real: null } }] }),
    "GET /api/systems/gl/flows/glissues": ok({ flow: glFlow, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } }),
    "GET /api/systems/gl/safety": ok({ on: true }) });
  const { rerender } = render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);
  const sw = await screen.findByRole("switch", { name: "안전장치" });
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("안전장치 상태를 읽지 못했습니다"));
  expect(sw.hasAttribute("disabled") || sw.getAttribute("aria-disabled") === "true").toBe(true);
  expect(document.querySelector('[data-safety="off"]')).toBeNull();
  expect(screen.queryByText("실제 서버에 변경 요청을 보냅니다")).toBeNull();
  rerender(<Flows system="gl" jobs={[]} tick={0} refreshJobs={() => {}} />);
  await vi.waitFor(() => expect(screen.getByRole("switch", { name: "안전장치" }).hasAttribute("disabled")).toBe(false));
  expect(((screen.getByRole("switch", { name: "안전장치" })) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

// Same-system reloads: bump `tick` on the mounted instance (no remount), after swapping a route between fail and ok.
const flaky = (good: unknown, bad = fail(500)) => { const s = { failing: true }; return { s, route: () => (s.failing ? bad() : { body: { ok: true, data: good } }) }; };
const reload = (rerender: (ui: React.ReactElement) => void, tick: number) => rerender(<Flows system="gh" jobs={[]} tick={tick} refreshJobs={() => {}} />);
const detailOk = { flow, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } };

it("list: a failed load shows the alert, a reload on the same service clears it", async () => {
  const r = routes();
  const l = flaky(await (r["GET /api/systems/gh/flows"]() as { body: { data: unknown } }).body.data);
  fakeApi({ ...r, "GET /api/systems/gh/flows": l.route });
  const { rerender } = mount();
  expect((await screen.findByRole("alert")).textContent).toContain("흐름 목록을 불러오지 못했습니다");
  l.s.failing = false;
  reload(rerender, 1);
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(await screen.findByRole("navigation", { name: "흐름" })).toBeTruthy();
});

it("detail: a failed load shows the alert, a reload on the same flow clears it", async () => {
  const d = flaky(detailOk);
  fakeApi({ ...routes(), "GET /api/systems/gh/flows/issues": d.route });
  const { rerender } = mount();
  expect((await screen.findByRole("alert")).textContent).toContain("흐름을 불러오지 못했습니다");
  d.s.failing = false;
  reload(rerender, 1);
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(await screen.findByRole("switch", { name: "안전장치" })).toBeTruthy();
});

it("safety: fail → notice and disabled switch; reload ok → enabled with the server value; reload fail → unknown again", async () => {
  const s = flaky({ on: false });
  fakeApi({ ...routes(), "GET /api/systems/gh/safety": s.route });
  const { rerender } = mount();
  const sw = () => screen.getByRole("switch", { name: "안전장치" }) as HTMLInputElement;
  const unknown = () => { expect(sw().getAttribute("aria-disabled") === "true" || sw().disabled).toBe(true); expect(document.querySelector('[data-safety="unknown"]')).not.toBeNull(); };
  await screen.findByRole("switch", { name: "안전장치" });
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("안전장치 상태를 읽지 못했습니다"));
  unknown();
  s.s.failing = false;
  reload(rerender, 1);
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(sw().disabled).toBe(false);
  expect(sw().checked).toBe(false);
  expect(document.querySelector('[data-safety="off"]')).not.toBeNull();
  s.s.failing = true;
  reload(rerender, 2);
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("안전장치 상태를 읽지 못했습니다"));
  unknown();
  expect(sw().checked).toBe(false); // the stale "off" is not shown as a known state: data-safety is unknown and the switch is disabled
});

// Stale responses: two flows A ("issues") and B ("repos") in one list; the user picks A, then B.
const flowB: FlowDetail["flow"] = { id: "repos", name: "repo 다루기", resource: "repo", steps: [step("only_b", "main")] };
const twoFlows = ok({ inferredAt: "t", notes: [], flows: [
  { id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 0, missingFeatures: [], last: { mock: null, real: null } },
  { id: "repos", name: "repo 다루기", resource: "repo", steps: 1, empty: 0, missingFeatures: [], last: { mock: null, real: null } }] });
const detailOf = (f: FlowDetail["flow"]) => ({ flow: f, empty: [], missingFeatures: [], features: {}, runs: { mock: null, real: null } });

it("a late response for flow A does not replace flow B after the user picked B", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": twoFlows,
    "GET /api/systems/gh/flows/issues": () => ({ body: { ok: true, data: detailOf(flow) }, wait }),
    "GET /api/systems/gh/flows/repos": ok(detailOf(flowB)) });
  mount(); // current = issues; its detail is held back
  fireEvent.click(await screen.findByRole("button", { name: /repo 다루기/ }));
  expect(await screen.findByRole("button", { name: /only_b/ })).toBeTruthy();
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByRole("button", { name: /only_b/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /create_issue/ })).toBeNull();
});

it("flow B fails to load: B's error shows and A's chart is not shown as B", async () => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": twoFlows,
    "GET /api/systems/gh/flows/issues": ok(detailOf(flow)),
    "GET /api/systems/gh/flows/repos": fail(500) });
  mount();
  await screen.findByRole("button", { name: /create_issue/ });
  fireEvent.click(screen.getByRole("button", { name: /repo 다루기/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("흐름을 불러오지 못했습니다");
  expect(screen.queryByRole("button", { name: /create_issue/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "전체 실행" })).toBeNull();
});

it("empty-flows view still shows load notices (a failed safety read)", async () => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": ok({ inferredAt: "t", notes: ["메모"], flows: [] }), "GET /api/systems/gh/safety": fail(500) });
  mount();
  expect(await screen.findByText("고른 기능에서 흐름을 만들지 못했어요.")).toBeTruthy();
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("안전장치 상태를 읽지 못했습니다"));
});

it("clicking the disabled safety switch while the state is unknown sends nothing", async () => {
  const api = fakeApi({ ...routes(), "GET /api/systems/gh/safety": fail(500), "POST /api/systems/gh/safety": ok({ on: false }) });
  mount();
  await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  fireEvent.click(screen.getByRole("switch", { name: "안전장치" }));
  await new Promise((r) => setTimeout(r, 30));
  expect(api.calls).not.toContain("POST /api/systems/gh/safety");
});

it("an action error is cleared by a later successful safety toggle", async () => {
  const post = { failing: true };
  fakeApi({ ...routes(), "POST /api/systems/gh/safety": () => (post.failing ? fail(500, "토글 실패")() : { body: { ok: true, data: { on: false } } }) });
  mount();
  fireEvent.click(await screen.findByRole("switch", { name: "안전장치" }));
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("토글 실패"));
  post.failing = false;
  fireEvent.click(screen.getByRole("switch", { name: "안전장치" }));
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("an action error is cleared by a later successful cancel", async () => {
  const post = { failing: true };
  fakeApi({ ...routes(), "POST /api/jobs/j1/cancel": () => (post.failing ? fail(500, "취소 실패")() : { body: { ok: true, data: { state: "running" } } }) });
  render(<Flows system="gh" jobs={[flowJob("running")]} tick={0} refreshJobs={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "실행 취소" }));
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("취소 실패"));
  post.failing = false;
  fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

// A save on flow A that is still in flight when the user picks B: the server echoes A's id, so only a check against the current selection can drop it.
const saveOnA = async (post: () => { status?: number; body: unknown; wait?: Promise<unknown> }) => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": twoFlows,
    "GET /api/systems/gh/flows/issues": ok(detailOf(flow)),
    "GET /api/systems/gh/flows/repos": ok(detailOf(flowB)),
    "POST /api/systems/gh/flows/issues/inputs": post });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /create_issue/ }));
  fireEvent.change(screen.getByLabelText("body.title 값"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "body.title 저장" }));
  fireEvent.click(screen.getByRole("button", { name: /repo 다루기/ }));
  expect(await screen.findByRole("button", { name: /only_b/ })).toBeTruthy();
};

it("a save response for flow A that arrives after the user picked B does not hide B's chart", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  await saveOnA(() => ({ body: { ok: true, data: detailOf(flow) }, wait }));
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByRole("button", { name: /only_b/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "전체 실행" })).toBeTruthy();
});

it("a failed save on flow A that is reported after the user picked B shows no error on B", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  await saveOnA(() => ({ ...fail(500, "A 저장 실패")(), wait }));
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText(/A 저장 실패/)).toBeNull();
  expect(screen.getByRole("button", { name: /only_b/ })).toBeTruthy();
});

// Run notices belong to the flow that was run (the screen remembers job id -> flow id).
const runOnA = async (jobs: (state: "running" | "done" | "failed") => Job[]) => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": twoFlows,
    "GET /api/systems/gh/flows/issues": ok(detailOf(flow)),
    "GET /api/systems/gh/flows/repos": ok(detailOf(flowB)),
    "POST /api/systems/gh/flows/issues/run": ok({ jobId: "j1" }) });
  const view = (state: "running" | "done" | "failed", tick: number) => <Flows system="gh" jobs={jobs(state)} tick={tick} refreshJobs={() => {}} />;
  const { rerender } = render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "전체 실행" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "전체 실행" })).toBeTruthy());
  return { rerender: (state: "running" | "done" | "failed", tick: number) => rerender(view(state, tick)) };
};
const pickFlow = (re: RegExp) => fireEvent.click(within(screen.getByRole("navigation", { name: "흐름" })).getByRole("button", { name: re }));

it("a failed job and its notRun targets show only on the flow that was run", async () => {
  const jobsOf = (state: "running" | "done" | "failed"): Job[] => [state === "failed"
    ? { ...flowJob("failed"), error: { code: "failed", message: "A 실행이 실패했습니다", hint: "다시 시도" } } as Job
    : flowJob(state, { runs: [], notRun: ["real"] })];
  const { rerender } = await runOnA(jobsOf);
  rerender("running", 0);
  rerender("done", 1);
  expect(await screen.findByText("실행하지 않은 대상: 실제")).toBeTruthy();
  pickFlow(/repo 다루기/);
  expect(await screen.findByRole("button", { name: /only_b/ })).toBeTruthy();
  expect(screen.queryByText(/실행하지 않은 대상/)).toBeNull();
  pickFlow(/issue 다루기/);
  expect(await screen.findByText("실행하지 않은 대상: 실제")).toBeTruthy();
  rerender("failed", 2);
  expect(await screen.findByText("A 실행이 실패했습니다")).toBeTruthy();
  pickFlow(/repo 다루기/);
  expect(await screen.findByRole("button", { name: /only_b/ })).toBeTruthy();
  expect(screen.queryByText("A 실행이 실패했습니다")).toBeNull();
  pickFlow(/issue 다루기/);
  expect(await screen.findByText("A 실행이 실패했습니다")).toBeTruthy();
});

it("a job whose flow is unknown (started before a reload) shows no run notice on any flow", async () => {
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": twoFlows,
    "GET /api/systems/gh/flows/issues": ok(detailOf(flow)), "GET /api/systems/gh/flows/repos": ok(detailOf(flowB)) });
  const failedJob = { ...flowJob("failed"), error: { code: "failed", message: "이전 실행 실패", hint: "다시 시도" } } as Job;
  const { rerender } = render(<Flows system="gh" jobs={[flowJob("running")]} tick={0} refreshJobs={() => {}} />); // seen as running, flow unknown
  await screen.findByRole("button", { name: /create_issue/ });
  rerender(<Flows system="gh" jobs={[failedJob]} tick={1} refreshJobs={() => {}} />);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText("이전 실행 실패")).toBeNull();
  rerender(<Flows system="gh" jobs={[flowJob("done", { runs: [], notRun: ["real"] })]} tick={2} refreshJobs={() => {}} />);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText(/실행하지 않은 대상/)).toBeNull();
});

it("flow A's load fails after B loaded: B shows no load error (detailError flow check and the detail .catch guard)", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": twoFlows,
    "GET /api/systems/gh/flows/issues": () => ({ ...fail(500)(), wait }),
    "GET /api/systems/gh/flows/repos": ok(detailOf(flowB)) });
  mount(); // current = issues; its failure is held back
  fireEvent.click(await screen.findByRole("button", { name: /repo 다루기/ }));
  expect(await screen.findByRole("button", { name: /only_b/ })).toBeTruthy();
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText(/흐름을 불러오지 못했습니다/)).toBeNull();
  expect(screen.getByRole("button", { name: /only_b/ })).toBeTruthy();
});

it("an older list response that arrives after a newer one does not replace it", async () => {
  const oldList = { inferredAt: "t", notes: [], flows: [{ id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: [], last: { mock: null, real: null } }] };
  const newList = { ...oldList, flows: [{ ...oldList.flows[0]!, name: "새 목록 이름" }] };
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  let n = 0;
  fakeApi({ ...routes(), "GET /api/systems/gh/flows": () => (++n === 1 ? { body: { ok: true, data: oldList }, wait } : { body: { ok: true, data: newList } }),
    "GET /api/systems/gh/flows/issues": ok(detailOf(flow)) });
  const { rerender } = render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />); // 1st list request is held
  reload(rerender, 1); // 2nd request answers at once
  expect(await screen.findByRole("button", { name: /새 목록 이름/ })).toBeTruthy();
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByRole("button", { name: /새 목록 이름/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^issue 다루기/ })).toBeNull();
});
