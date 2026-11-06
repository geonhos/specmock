import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { n = 0; FakeEventSource.all = []; vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

const sys = { name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: false, verified: false }, stale: {} };
const overview = (over: Record<string, unknown> = {}) => ({
  summary: sys, source: [{ kind: "openapi", origin: "/x/petstore.yaml", chars: 100 }], analyze: "catalog", catalogTotal: 3, selection: null, generate: null, coverage: null, defaultOutDir: "/r/mock/petstore", ...over,
});
const ok = (data: unknown) => () => ({ body: { ok: true, data } });
let n = 0;
const accepted = () => ({ status: 202, body: { ok: true, data: { jobId: `j${++n}` } } });
const job = (over: Record<string, unknown> = {}) => ({ id: "j1", system: "petstore", kind: "generate", state: "running", cancellable: false, startedAt: "t", ...over });
const emit = (name: string, data: unknown) => act(() => FakeEventSource.last!.emit(name, data));

function setup(extra: Record<string, () => { status?: number; body: unknown }> = {}) {
  window.history.replaceState(null, "", "/systems/petstore/generate");
  return fakeApi({
    "GET /api/env": ok({ root: "/r", claude: true }),
    "GET /api/jobs": ok({ running: [], recent: [] }),
    "GET /api/systems": ok([sys]),
    "GET /api/systems/petstore": ok(overview()),
    ...extra,
  });
}

it("출력 디렉터리 기본값은 defaultOutDir이고 고칠 수 있다. 생성은 POST /generate {outDir, force:false}", async () => {
  const api = setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  const input = (await screen.findByLabelText("출력 디렉터리")) as HTMLInputElement;
  await vi.waitFor(() => expect(input.value).toBe("/r/mock/petstore"));
  fireEvent.change(input, { target: { value: "/tmp/out" } });
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/generate"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/petstore/generate")]).toEqual({ outDir: "/tmp/out", force: false });
});

it("생성 중에는 취소 버튼이 없고 생성 버튼이 잠긴다", async () => {
  setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(FakeEventSource.last).toBeTruthy());
  emit("job-started", job());
  expect(await screen.findByText(/생성 중이에요/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "취소" })).toBeNull();
  expect((screen.getByRole("button", { name: "생성" }) as HTMLButtonElement).disabled).toBe(true);
});

async function failOverwrite(api: ReturnType<typeof setup>) {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/generate"));
  emit("job-started", job());
  emit("job-failed", job({ state: "failed", error: { code: "overwrite-required", message: "/r/mock/petstore 이(가) 비어 있지 않아요 (package.json 외 3개)." } }));
}

it("overwrite-required → '덮어쓸까요?' 창(경로·message). 덮어쓰기는 force:true로 다시 호출, 취소는 호출 없음", async () => {
  const api = setup({ "POST /api/systems/petstore/generate": accepted });
  await failOverwrite(api);
  const dialog = await screen.findByRole("dialog", { name: "덮어쓸까요?" });
  expect(dialog.textContent).toContain("/r/mock/petstore");
  expect(dialog.textContent).toContain("비어 있지 않아요");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.filter((c) => c === "POST /api/systems/petstore/generate")).toHaveLength(1);
  // 다시 시도 → 같은 실패가 와도(새 작업) 창이 다시 뜨고 덮어쓰기가 force:true로 호출된다
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls.filter((c) => c === "POST /api/systems/petstore/generate")).toHaveLength(2));
  emit("job-failed", job({ id: "j2", state: "failed", error: { code: "overwrite-required", message: "비어 있어요" } }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "덮어쓸까요?" })).getByRole("button", { name: "덮어쓰기" }));
  await vi.waitFor(() => expect(api.calls.filter((c) => c === "POST /api/systems/petstore/generate")).toHaveLength(3));
  expect(api.bodies.at(-1)).toEqual({ outDir: "/r/mock/petstore", force: true });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("job-done: 생성 파일 목록과 실행 방법, ⑤ 검증으로 →", async () => {
  const api = setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/generate"));
  emit("job-started", job());
  emit("job-done", job({ state: "done", result: { outDir: "/r/mock/petstore", written: ["package.json", "src/server.ts"], preserved: ["fixtures/a.json"], orphaned: [] } }));
  expect(await screen.findByText(/생성 완료: \/r\/mock\/petstore \(2개 파일\)/)).toBeTruthy();
  expect(screen.getByText("src/server.ts")).toBeTruthy();
  expect(screen.getByText(/보존된 fixture 1개/)).toBeTruthy();
  expect(document.body.textContent).toContain("cd /r/mock/petstore && npm install && npm start");
  fireEvent.click(screen.getByRole("button", { name: "⑤ 검증으로 →" }));
  expect(window.location.pathname).toBe("/systems/petstore/verify");
});

it("그 밖의 실패는 alert로 보인다", async () => {
  const api = setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/generate"));
  emit("job-failed", job({ state: "failed", error: { code: "failed", message: "선택된 기능이 없어요" } }));
  expect((await screen.findByRole("alert")).textContent).toContain("선택된 기능이 없어요");
  expect(screen.queryByRole("dialog")).toBeNull();
});
