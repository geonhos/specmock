import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { vi.stubGlobal("EventSource", FakeEventSource); window.history.replaceState(null, "", "/"); });
afterEach(() => vi.unstubAllGlobals());

const systems = [
  { name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: false, verified: false }, stale: { generate: true } },
  { name: "pets", kind: "markdown", steps: { registered: true, analyzed: false, selected: false, generated: false, verified: false }, stale: {}, chunks: { done: 0, total: 3 } },
];
const base = () => ({
  "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude: true } } }),
  "GET /api/systems": () => ({ body: { ok: true, data: systems } }),
  "GET /api/jobs": () => ({ body: { ok: true, data: { running: [], recent: [] } } }),
  // "/" goes to the first service's flow screen, so the routes that screen reads must exist too.
  "GET /api/systems/petstore/flows": () => ({ body: { ok: true, data: { inferredAt: null, notes: [], flows: [] } } }),
  "GET /api/systems/petstore/safety": () => ({ body: { ok: true, data: { on: true } } }),
});

it("사이드바에 서비스 목록과 + 서비스 등록, 단계 막대는 없다", async () => {
  fakeApi(base());
  render(<App />);
  const nav = await screen.findByRole("navigation", { name: "서비스" });
  expect(within(nav).getByRole("link", { name: /petstore/ })).toBeTruthy();
  expect(within(nav).getByRole("link", { name: "+ 서비스 등록" })).toBeTruthy();
  expect(screen.queryByText("① 등록")).toBeNull();
});

it("첫 서비스의 흐름 화면으로 이동한다", async () => {
  fakeApi(base());
  render(<App />);
  await screen.findByRole("heading", { name: "흐름" });
  expect(window.location.pathname).toBe("/systems/petstore/flows");
});

it("등록된 서비스가 없으면 등록 화면", async () => {
  fakeApi({ ...base(), "GET /api/systems": () => ({ body: { ok: true, data: [] } }) });
  render(<App />);
  await screen.findByRole("heading", { name: /등록/ });
  expect(window.location.pathname).toBe("/new");
});

it("workspace-changed가 오면 시스템 목록을 다시 불러온다", async () => {
  const api = fakeApi(base());
  render(<App />);
  await screen.findByRole("link", { name: /petstore/ });
  const count = () => api.calls.filter((c) => c === "GET /api/systems").length;
  const before = count();
  FakeEventSource.last!.emit("workspace-changed", { system: "pets", files: ["catalog.json"] });
  await vi.waitFor(() => expect(count()).toBe(before + 1));
});

it("SSE가 끊기면 '연결이 끊겼어요' 알림, 다시 연결되면 사라지고 목록을 다시 불러온다", async () => {
  const api = fakeApi(base());
  render(<App />);
  await screen.findByRole("link", { name: /petstore/ });
  const es = FakeEventSource.last!;
  es.emit("ready", {});
  const count = () => api.calls.filter((c) => c === "GET /api/systems").length;
  const before = count();
  es.fail();
  expect((await screen.findByRole("alert")).textContent).toContain("연결이 끊겼어요");
  es.emit("ready", {});
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await vi.waitFor(() => expect(count()).toBe(before + 1));
});

it("watch-error가 오면 새로고침 안내 알림", async () => {
  fakeApi(base());
  render(<App />);
  await screen.findByRole("link", { name: /petstore/ });
  FakeEventSource.last!.emit("watch-error", { message: "boom" });
  expect((await screen.findByRole("alert")).textContent).toContain("변경 감지가 멈췄어요");
});

it("언마운트하면 EventSource를 닫는다", async () => {
  fakeApi(base());
  const { unmount } = render(<App />);
  await screen.findByRole("link", { name: /petstore/ });
  const es = FakeEventSource.last!;
  expect(es.closed).toBe(false);
  unmount();
  expect(es.closed).toBe(true);
  cleanup();
});

it("SSE가 영구히 끊겨 포기하면 새로고침 안내", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    fakeApi(base());
    render(<App />);
    await screen.findByRole("link", { name: /petstore/ });
    for (let i = 0; i < 10; i++) {
      FakeEventSource.last!.fail(true);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("서버와 연결이 끊겼어요");
    expect(alert.textContent).toContain("새로고침해 주세요");
  } finally { vi.useRealTimers(); }
});
