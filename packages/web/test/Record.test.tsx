import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecordScreen } from "../src/screens/Record";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { FakeEventSource.all = []; vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Resp = (b?: unknown) => { status?: number; body: unknown };
const ok = (data: unknown): Resp => () => ({ body: { ok: true, data } });
const S = "/api/systems/stripe";
const EXAMPLE = "{\n  \"baseUrl\": \"https://api.example.com/v2\"\n}";
const noTarget = { exists: false, example: EXAMPLE };
const entry = (name: string, value: string, literal = false) => ({ name, value, literal });
const row = (id: string, method: string, path: string) => ({ index: 1, id, group: "g", method, path, provenance: "spec", confidence: 1, hasExample: true, warnings: [], summary: `${id} 설명`, codes: ["200"] });
type Row = ReturnType<typeof row>;
const featureList = (rows: Row[]) => ({ total: rows.length, rows, groups: ["g"] });
const selection = (ids: string[]) => ({ system: "stripe", catalogHash: "h", selected: ids, resolved: ids, updatedAt: "t" });
const noLast = { exists: false, recorded: [] };
const targetInfo = (over: Record<string, unknown> = {}, features: Record<string, unknown[]> = {}) => ({
  exists: true, example: EXAMPLE, baseUrl: "https://api.stripe.com",
  target: {
    baseUrl: "https://api.stripe.com", timeoutMs: 20000,
    headers: [entry("Authorization", "Bearer ${TOKEN}"), entry("X-Plain", "***", true)],
    params: [], features,
  },
  env: [{ name: "TOKEN", status: "process" }],
  ...over,
});
const view = () => render(<RecordScreen system="stripe" jobs={[]} tick={0} go={() => undefined} refreshJobs={() => undefined} onChanged={() => undefined} />);
const emit = (name: string, data: unknown) => act(() => FakeEventSource.last!.emit(name, data));

function setup(target: unknown, rows: Row[] = [], extra: Record<string, Resp> = {}) {
  return fakeApi({
    [`GET ${S}/target`]: ok(target),
    [`GET ${S}/record/last`]: ok(noLast),
    [`GET ${S}/features`]: ok(featureList(rows)),
    [`GET ${S}/selection`]: ok(selection(rows.map((r) => r.id))),
    ...extra,
  });
}
const lastBody = (api: ReturnType<typeof fakeApi>, key: string) => api.bodies[api.calls.lastIndexOf(key)] as Record<string, unknown>;
const putOk = (data: unknown): Record<string, Resp> => ({ [`PUT ${S}/target`]: ok(data) });
const recordBtn = () => screen.getByRole("button", { name: /녹화$/ }) as HTMLButtonElement;

it("설정이 없으면 폼이 펼쳐지고 녹화 버튼이 막힌 이유를 보인다", async () => {
  setup(noTarget);
  view();
  expect(((await screen.findByRole("group", { name: "대상 서버 설정" })) as HTMLDetailsElement).open).toBe(true);
  const btn = recordBtn();
  expect(btn.disabled).toBe(true);
  const why = screen.getByText("먼저 대상 서버 설정을 저장하세요");
  expect(btn.getAttribute("aria-describedby")).toBe(why.id);
});

it("저장된 설정이 있으면 폼은 접혀 있다", async () => {
  setup(targetInfo());
  view();
  const g = await screen.findByRole("group", { name: "대상 서버 설정" });
  expect(g.closest("details")!.open).toBe(false);
});

it("저장은 PUT /target 본문에 헤더·공통 값·keep을 담는다", async () => {
  const api = setup(targetInfo(), [], putOk(targetInfo()));
  view();
  fireEvent.change(await screen.findByLabelText("주소"), { target: { value: "https://api2.stripe.com" } });
  fireEvent.change(screen.getByLabelText("제한 시간(초)"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "+ 값" }));
  fireEvent.change(screen.getByLabelText("공통 값 1 이름"), { target: { value: "limit" } });
  fireEvent.change(screen.getByLabelText("공통 값 1 값"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await vi.waitFor(() => expect(api.calls).toContain(`PUT ${S}/target`));
  expect(lastBody(api, `PUT ${S}/target`)).toEqual({
    baseUrl: "https://api2.stripe.com", timeoutMs: 30000,
    headers: [{ name: "Authorization", value: "Bearer ${TOKEN}" }, { name: "X-Plain", keep: true }],
    params: [{ name: "limit", value: "3" }],
    features: {},
  });
});

it("직접 적은 헤더 값에는 안내가 뜨고, ${이름} 값에는 환경 변수 표시가 붙는다", async () => {
  setup(noTarget);
  view();
  fireEvent.click(await screen.findByRole("button", { name: "+ 헤더" }));
  fireEvent.change(screen.getByLabelText("헤더 1 이름"), { target: { value: "X-Key" } });
  fireEvent.change(screen.getByLabelText("헤더 1 값"), { target: { value: "abc" } });
  expect(screen.getByText("이 값은 파일에 그대로 남습니다. ${이름} 참조를 권합니다")).not.toBeNull();
  fireEvent.change(screen.getByLabelText("헤더 1 값"), { target: { value: "${KEY}" } });
  expect(screen.queryByText(/파일에 그대로 남습니다/)).toBeNull();
  expect(screen.getByText("환경 변수")).not.toBeNull();
});

it("파일에 직접 적힌 값은 ***로 보이고 지우기를 고르면 본문에서 빠진다", async () => {
  const api = setup(targetInfo(), [], putOk(targetInfo()));
  view();
  await screen.findByLabelText("주소");
  expect(screen.getByText("***")).not.toBeNull();
  expect(screen.getByRole("button", { name: "X-Plain 그대로 유지" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "X-Plain 지우기" }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await vi.waitFor(() => expect(api.calls).toContain(`PUT ${S}/target`));
  expect(lastBody(api, `PUT ${S}/target`).headers).toEqual([{ name: "Authorization", value: "Bearer ${TOKEN}" }]);
});

it("환경 변수가 미설정이면 녹화가 막히고, 이번 세션에 사용을 누르면 POST /env 뒤 설정됨으로 바뀐다", async () => {
  const rows = [row("getPet", "GET", "/pets")];
  let status = "missing";
  const api = setup(targetInfo(), rows, {
    [`GET ${S}/target`]: () => ({ body: { ok: true, data: targetInfo({ env: [{ name: "TOKEN", status }] }) } }),
    [`POST ${S}/env`]: () => { status = "session"; return { body: { ok: true, data: { names: ["TOKEN"] } } }; },
  });
  view();
  expect(await screen.findByText("환경 변수 1개가 미설정입니다")).not.toBeNull();
  expect(recordBtn().disabled).toBe(true);
  expect(screen.getByText("입력한 값은 이 서버의 메모리에만 있고 파일·기록에 남지 않습니다. 서버를 다시 켜면 다시 입력합니다")).not.toBeNull();
  const input = screen.getByLabelText("TOKEN 값");
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.change(input, { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "TOKEN 이번 세션에 사용" }));
  await vi.waitFor(() => expect(api.calls).toContain(`POST ${S}/env`));
  expect(lastBody(api, `POST ${S}/env`)).toEqual({ values: { TOKEN: "x" } });
  expect(await screen.findByText("설정됨(화면 입력)")).not.toBeNull();
  expect((screen.getByLabelText("TOKEN 값") as HTMLInputElement).value).toBe("");
  await vi.waitFor(() => expect(recordBtn().disabled).toBe(false));
});

it("저장하지 않은 변경이 있으면 녹화가 막힌다", async () => {
  setup(targetInfo(), [row("getPet", "GET", "/pets")]);
  view();
  const base = await screen.findByLabelText("주소");
  await vi.waitFor(() => expect(recordBtn().disabled).toBe(false));
  fireEvent.change(base, { target: { value: "https://other.example.com" } });
  expect(recordBtn().disabled).toBe(true);
  expect(screen.getByText("설정을 먼저 저장하세요")).not.toBeNull();
});

it("선택하지 않은 기능의 값은 저장 본문에서 빠지고 안내가 뜬다", async () => {
  const info = targetInfo({}, { gone: [entry("id", "p1")], getPet: [entry("id", "p2")] });
  const api = setup(info, [row("getPet", "GET", "/pets/{id}")], putOk(info));
  view();
  await screen.findByLabelText("주소");
  expect(screen.getByText("선택하지 않은 기능의 값 1개는 저장에서 제외됩니다")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await vi.waitFor(() => expect(api.calls).toContain(`PUT ${S}/target`));
  expect((lastBody(api, `PUT ${S}/target`).features as Record<string, unknown>).gone).toBeUndefined();
  expect(Object.keys(lastBody(api, `PUT ${S}/target`).features as object)).toEqual(["getPet"]);
});

// emit은 Task 9 테스트에서 쓴다.
void emit;
