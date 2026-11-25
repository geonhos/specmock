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
    headers: [entry("Authorization", "***", true), entry("X-Plain", "***", true), entry("X-Ref", "${TOKEN}")],
    params: [], features,
  },
  env: [{ name: "TOKEN", status: "process" }],
  ...over,
});
type JobT = Record<string, unknown>;
const screenEl = (jobs: JobT[]) => <RecordScreen system="stripe" jobs={jobs as never} tick={0} go={() => undefined} refreshJobs={() => undefined} onChanged={() => undefined} />;
const view = () => {
  const r = render(screenEl([]));
  return { setJobs: (jobs: JobT[]) => act(() => r.rerender(screenEl(jobs))) };
};
const rjob = (over: JobT = {}): JobT => ({ id: "r1", system: "stripe", kind: "record", state: "running", cancellable: true, startedAt: "t", ...over });

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
    headers: [{ name: "Authorization", keep: true }, { name: "X-Plain", keep: true }, { name: "X-Ref", value: "${TOKEN}" }],
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

it("참조가 섞인 값은 ***·literal로 불러와 그대로 두면 keep으로 저장되고 원문은 나가지 않는다", async () => {
  const api = setup(targetInfo(), [], putOk(targetInfo()));
  view();
  await screen.findByLabelText("주소");
  expect(screen.getByRole("button", { name: "Authorization 그대로 유지" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Authorization 그대로 유지" }).closest("tr")!.textContent).not.toContain("환경 변수");
  expect(screen.getByLabelText("헤더 3 값").closest("td")!.textContent).toContain("환경 변수");
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await vi.waitFor(() => expect(api.calls).toContain(`PUT ${S}/target`));
  const body = lastBody(api, `PUT ${S}/target`);
  expect((body.headers as { name: string }[]).find((h) => h.name === "Authorization")).toEqual({ name: "Authorization", keep: true });
  expect(JSON.stringify(body)).not.toContain("Bearer");
  expect(JSON.stringify(body)).not.toContain("***");
});

it("헤더 값에 Bearer ${TOKEN}을 입력하면 환경 변수 표시가 붙고 그대로 남는다는 안내는 없다", async () => {
  setup(noTarget);
  view();
  fireEvent.click(await screen.findByRole("button", { name: "+ 헤더" }));
  fireEvent.change(screen.getByLabelText("헤더 1 이름"), { target: { value: "Authorization" } });
  fireEvent.change(screen.getByLabelText("헤더 1 값"), { target: { value: "Bearer ${TOKEN}" } });
  expect(screen.getByText("환경 변수")).not.toBeNull();
  expect(screen.queryByText(/파일에 그대로 남습니다/)).toBeNull();
});

it("파일에 직접 적힌 값은 ***로 보이고 지우기를 고르면 본문에서 빠진다", async () => {
  const api = setup(targetInfo(), [], putOk(targetInfo()));
  view();
  await screen.findByLabelText("주소");
  expect(screen.getAllByText("***").length).toBe(2);
  expect(screen.getByRole("button", { name: "X-Plain 그대로 유지" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "X-Plain 지우기" }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await vi.waitFor(() => expect(api.calls).toContain(`PUT ${S}/target`));
  expect(lastBody(api, `PUT ${S}/target`).headers).toEqual([{ name: "Authorization", keep: true }, { name: "X-Ref", value: "${TOKEN}" }]);
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

const PETS = [row("getPet", "GET", "/pets/{id}"), row("listPets", "HEAD", "/pets"), row("createPet", "POST", "/pets")];
const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

it("기본 선택은 GET·HEAD이고 변경 요청 행은 해제된 채 비활성이다", async () => {
  setup(targetInfo(), PETS);
  view();
  await vi.waitFor(() => expect(recordBtn().textContent).toBe("선택한 2개 녹화"));
  expect(checkbox("getPet 선택").checked).toBe(true);
  expect(checkbox("createPet 선택").checked).toBe(false);
  expect(checkbox("createPet 선택").disabled).toBe(true);
});

it("변경 요청 포함은 확인 창을 거치고, 켜면 변경 요청 행을 고를 수 있다", async () => {
  const api = setup(targetInfo(), PETS, { [`POST ${S}/record`]: () => ({ status: 202, body: { ok: true, data: { jobId: "r1" } } }) });
  view();
  await screen.findByText("getPet 설명");
  fireEvent.click(checkbox("변경 요청 포함"));
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(checkbox("변경 요청 포함").checked).toBe(false);
  fireEvent.click(checkbox("변경 요청 포함"));
  fireEvent.click(screen.getByRole("button", { name: "변경 요청 포함" }));
  expect(checkbox("변경 요청 포함").checked).toBe(true);
  fireEvent.click(checkbox("createPet 선택"));
  await vi.waitFor(() => expect(recordBtn().textContent).toBe("선택한 3개 녹화"));
  fireEvent.click(recordBtn());
  await vi.waitFor(() => expect(api.calls).toContain(`POST ${S}/record`));
  expect(lastBody(api, `POST ${S}/record`)).toEqual({ features: ["getPet", "listPets", "createPet"], allowMutating: true, apply: true });
});

it("녹화는 선택한 기능과 apply를 담아 POST하고 진행 바와 취소를 보인다", async () => {
  const api = setup(targetInfo(), PETS, { [`POST ${S}/record`]: () => ({ status: 202, body: { ok: true, data: { jobId: "r1" } } }) });
  const v = view();
  await vi.waitFor(() => expect(recordBtn().disabled).toBe(false));
  fireEvent.click(checkbox("listPets 선택"));
  fireEvent.click(checkbox("mock에 반영"));
  fireEvent.click(recordBtn());
  await vi.waitFor(() => expect(api.calls).toContain(`POST ${S}/record`));
  expect(lastBody(api, `POST ${S}/record`)).toEqual({ features: ["getPet"], allowMutating: false, apply: false });
  v.setJobs([rjob({ progress: { message: "1/2", done: 1, total: 2 } })]);
  const bar = await screen.findByRole("progressbar", { name: "녹화 진행" });
  expect(bar.getAttribute("aria-valuenow")).toBe("1");
  expect(bar.getAttribute("aria-valuemax")).toBe("2");
  expect(screen.getByText("1/2")).not.toBeNull();
  expect(recordBtn().disabled).toBe(true);
  expect(screen.getByRole("button", { name: "취소" })).not.toBeNull();
});

it("경로 변수 입력은 features.<id>.<이름>으로 같은 PUT에 담긴다", async () => {
  const api = setup(targetInfo(), PETS, putOk(targetInfo()));
  view();
  const input = await screen.findByLabelText("getPet id");
  fireEvent.change(input, { target: { value: "p1" } });
  expect(recordBtn().disabled).toBe(true);
  expect(screen.getByText("설정을 먼저 저장하세요")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await vi.waitFor(() => expect(api.calls).toContain(`PUT ${S}/target`));
  expect((lastBody(api, `PUT ${S}/target`)).features).toEqual({ getPet: [{ name: "id", value: "p1" }] });
});

it("job-done이면 기능 표 결과와 요약·반영 줄·notes·drift 원문이 갱신된다", async () => {
  setup(targetInfo(), PETS);
  const v = view();
  await screen.findByText("getPet 설명");
  expect(screen.getAllByText("미녹화").length).toBe(3);
  v.setJobs([rjob({ state: "done", result: {
    result: {
      baseUrl: "https://api.stripe.com", recorded: 3, matched: ["listPets"],
      drifted: [{ featureId: "getPet", errors: ["body.id 없음"] }], statusMismatch: [], skipped: [{ featureId: "createPet" }], failed: [],
      applied: { selected: 1, generate: { written: ["a", "b"] } },
    },
    driftMarkdown: "## 스펙과 다름\n\n- getPet GET /pets/{id} → 200. body.id 없음", notes: ["노트 하나"],
  } })]);
  expect(await screen.findByText("일치 1 · 스펙과 다름 1 · 상태 불일치 0 · 건너뜀 1 · 실패 0")).not.toBeNull();
  expect(screen.getByText("일치")).not.toBeNull();
  expect(screen.getByText("스펙과 다름")).not.toBeNull();
  expect(screen.getByText("건너뜀(변경 요청)")).not.toBeNull();
  expect(screen.getByText(/mock에 반영했습니다/)).not.toBeNull();
  expect(screen.getByText("노트 하나")).not.toBeNull();
  expect(document.querySelector("pre.drift")!.textContent).toContain("body.id 없음");
  const more = screen.getByRole("button", { name: "이유 보기" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(screen.getByText("body.id 없음", { selector: "li" })).not.toBeNull();
});

it("처음 열 때 GET /record/last로 지난 결과를 채운다", async () => {
  setup(targetInfo(), PETS, { [`GET ${S}/record/last`]: ok({
    exists: true, recordedAt: "2026-11-25T00:00:00Z", recorded: [{ featureId: "listPets", status: 200, at: "t" }, { featureId: "getPet", status: 200, at: "t" }],
    driftMarkdown: "## 상태 불일치\n\n- getPet GET /pets/{id} → 기대 200, 실제 404. 존재하는 id를 넣으세요",
  }) });
  view();
  expect(await screen.findByText("상태 불일치(기대 200, 실제 404)")).not.toBeNull();
  expect(screen.getByText("일치")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "이유 보기" }));
  expect(screen.getByText("존재하는 id를 넣으세요", { selector: "li" })).not.toBeNull();
});

it("409 busy면 응답의 jobId를 따라가 진행 중으로 보인다", async () => {
  setup(targetInfo(), PETS, { [`POST ${S}/record`]: () => ({ status: 409, body: { ok: false, jobId: "r9", error: { code: "busy", message: "이미 실행 중입니다" } } }) });
  const v = view();
  await vi.waitFor(() => expect(recordBtn().disabled).toBe(false));
  fireEvent.click(recordBtn());
  await vi.waitFor(() => expect(document.querySelector("#record-why, [role=alert]")).toBeNull());
  v.setJobs([rjob({ id: "r9", progress: { message: "x", done: 0, total: 2 } })]);
  expect(await screen.findByRole("progressbar", { name: "녹화 진행" })).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
