import { render, screen, within } from "@testing-library/react";
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
});

it("사이드바에 시스템 목록과 + 스펙 등록, 상단에 단계 5개", async () => {
  fakeApi(base());
  render(<App />);
  const nav = await screen.findByRole("navigation", { name: "시스템" });
  expect(within(nav).getByRole("link", { name: /petstore/ })).toBeTruthy();
  expect(within(nav).getByRole("link", { name: "+ 스펙 등록" })).toBeTruthy();
  for (const s of ["① 등록", "② 분석", "③ 기능 선택", "④ 생성", "⑤ 검증"]) expect(screen.getByText(s)).toBeTruthy();
});

it("첫 시스템의 다음 단계로 이동하고, 완료한 단계는 버튼·못 가는 단계는 aria-disabled, stale은 보조 글자", async () => {
  fakeApi(base());
  render(<App />);
  await screen.findByRole("heading", { name: /생성/ });
  expect(window.location.pathname).toBe("/systems/petstore/generate");
  expect(screen.getByText("② 분석").closest("button")).toBeTruthy();
  expect(screen.getByText("⑤ 검증").closest("[aria-disabled='true']")).toBeTruthy();
  expect(screen.getByText("④ 생성").closest("[aria-current='step']")).toBeTruthy();
  expect(screen.getByText("다시 실행 필요")).toBeTruthy();
});

it("등록된 시스템이 없으면 ① 등록 화면", async () => {
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
