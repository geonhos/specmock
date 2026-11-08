import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { FakeEventSource.all = []; vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ok = (data: unknown) => () => ({ body: { ok: true, data } });
const row = (index: number, id: string, group: string, method: string, path: string, summary = `${id} 설명`, codes = ["200"]) => ({ index, id, group, method, path, provenance: "openapi", confidence: 1, hasExample: true, warnings: [] as string[], summary, codes });
const ROWS = [
  row(1, "pets.list", "pets", "GET", "/pets"),
  row(2, "pets.get", "pets", "GET", "/pets/{petId}"),
  row(3, "pets.create", "pets", "POST", "/pets"),
  row(4, "store.inv", "store", "GET", "/store/inventory"),
];
const list = (rows = ROWS) => ({ total: rows.length, rows, groups: [...new Set(rows.map((r) => r.group))] });
const sel = (resolved: string[]) => ({ system: "petstore", catalogHash: "h", selected: resolved, resolved, updatedAt: "t" });
const FEATURE = {
  id: "pets.get", group: "pets", title: "펫 조회", summary: "펫 한 마리를 돌려줘요", method: "GET", path: "/pets/{petId}",
  request: { params: { petId: { schema: { type: "integer" }, required: true } }, query: {}, headers: {}, body: null },
  responses: {
    "200": { schema: { type: "object" }, examples: [{ source: "spec-example", body: { id: 10, name: "초코" } }] },
    "404": { schema: { type: "object", properties: { code: { type: "integer" }, message: { type: "string" } } }, examples: [] },
  },
  auth: "none", provenance: "openapi", confidence: 1, hasExample: true, evidence: [{ chunk: 0, quote: "GET /pets/{petId} returns a pet" }], notes: [],
};
const sysSummary = { name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: false, verified: false }, stale: {} };

function setup(initial: string[] | null, extra: Record<string, (b?: unknown) => { status?: number; body: unknown }> = {}) {
  window.history.replaceState(null, "", "/systems/petstore/select");
  const server = { selection: initial === null ? null : sel(initial), rows: ROWS };
  const api = fakeApi({
    "GET /api/env": ok({ root: "/r", claude: true }),
    "GET /api/jobs": ok({ running: [], recent: [] }),
    "GET /api/systems": ok([sysSummary]),
    "GET /api/systems/petstore": ok({ summary: sysSummary, source: [{ kind: "openapi", origin: "/r/specs/petstore.yaml" }], analyze: "catalog", catalogTotal: 4, selection: null, generate: null, coverage: null, defaultOutDir: "/r/mock/petstore" }),
    "GET /api/systems/petstore/features": () => ({ body: { ok: true, data: list(server.rows) } }),
    "GET /api/systems/petstore/selection": () => ({ body: { ok: true, data: server.selection } }),
    "GET /api/systems/petstore/features/pets.get": ok(FEATURE),
    "POST /api/systems/petstore/selection": (b) => { const ids = (b as { ids: string[] }).ids; server.selection = sel(ids); return { body: { ok: true, data: { selected: ids } } }; },
    ...extra,
  });
  return { api, server };
}
const emit = (name: string, data: unknown) => act(() => FakeEventSource.last!.emit(name, data));
const saves = (api: { calls: string[] }) => api.calls.filter((c) => c === "POST /api/systems/petstore/selection").length;
const saveBodies = (api: { calls: string[]; bodies: unknown[] }) => api.calls.flatMap((c, i) => (c === "POST /api/systems/petstore/selection" ? [api.bodies[i]] : []));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const rowCheckbox = (name: string) => screen.getByRole("checkbox", { name });

it("일부만 선택된 그룹의 체크박스는 aria-checked=mixed, 그룹 체크는 400ms 뒤 한 번만 저장", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  const g = await screen.findByRole("checkbox", { name: /pets 그룹/ });
  expect(g.getAttribute("aria-checked")).toBe("mixed");
  expect(screen.getByRole("checkbox", { name: /store 그룹/ }).getAttribute("aria-checked")).toBe("false");
  vi.useFakeTimers();
  fireEvent.click(g);
  expect(g.getAttribute("aria-checked")).toBe("true");
  await advance(399);
  expect(saves(api)).toBe(0);
  await advance(1);
  expect(saves(api)).toBe(1);
  expect((saveBodies(api)[0] as { ids: string[] }).ids.sort()).toEqual(["pets.create", "pets.get", "pets.list"]);
});

it("연속 변경은 디바운스로 합쳐 마지막 값 한 번만 저장한다", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  await screen.findByRole("checkbox", { name: /pets 그룹/ });
  vi.useFakeTimers();
  fireEvent.click(rowCheckbox("GET /pets/{petId} 선택"));
  await advance(200);
  fireEvent.click(rowCheckbox("POST /pets 선택"));
  await advance(400);
  expect(saves(api)).toBe(1);
  expect((saveBodies(api)[0] as { ids: string[] }).ids.sort()).toEqual(["pets.create", "pets.get", "pets.list"]);
});

it("저장 중에 바뀌면 끝난 뒤 최신 값으로 한 번 더 저장한다(직렬화)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const { api } = setup(["pets.list"], {
    "POST /api/systems/petstore/selection": (b) => ({ body: { ok: true, data: { selected: (b as { ids: string[] }).ids } } }),
  });
  const orig = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST" && first) { first = false; api.calls.push(`POST ${String(input)}`); api.bodies.push(JSON.parse(String(init.body))); await gate; return new Response(JSON.stringify({ ok: true, data: { selected: [] } })); }
    return orig(input, init);
  });
  render(<App />);
  await screen.findByRole("checkbox", { name: /pets 그룹/ });
  vi.useFakeTimers();
  fireEvent.click(rowCheckbox("GET /pets/{petId} 선택"));
  await advance(400);
  expect(saves(api)).toBe(1);
  fireEvent.click(rowCheckbox("POST /pets 선택"));
  await advance(400);
  expect(saves(api)).toBe(1); // 진행 중인 저장이 끝나기 전에는 새로 보내지 않는다
  release();
  await advance(0);
  expect(saves(api)).toBe(2);
  expect((saveBodies(api)[1] as { ids: string[] }).ids.sort()).toEqual(["pets.create", "pets.get", "pets.list"]);
});

it("그룹 행을 누르면 접히고 펼쳐진다", async () => {
  setup(["pets.list"]);
  render(<App />);
  const toggle = await screen.findByRole("button", { name: /^pets/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("/store/inventory")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("checkbox", { name: "GET /pets 선택" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: /pets 그룹/ })).toBeTruthy(); // 접어도 그룹 체크는 남는다
  fireEvent.click(toggle);
  expect(screen.getByRole("checkbox", { name: "GET /pets 선택" })).toBeTruthy();
});

it("행을 누르면 상세 패널이 GET /features/:id 결과를 보이고, 체크박스 클릭은 상세를 열지 않는다", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "GET /pets/{petId} 선택" });
  fireEvent.click(cb);
  expect(api.calls).not.toContain("GET /api/systems/petstore/features/pets.get");
  fireEvent.click(screen.getByRole("button", { name: /\/pets\/\{petId\}/ }));
  const det = await screen.findByRole("complementary", { name: "상세" });
  await within(det).findByText("펫 한 마리를 돌려줘요");
  expect(api.calls).toContain("GET /api/systems/petstore/features/pets.get");
  expect(det.textContent).toContain("GET");
  expect(det.textContent).toContain("/pets/{petId}");
  expect(within(det).getByText("petId")).toBeTruthy(); // 요청 필드 표
  expect(det.querySelector("pre")!.textContent).toContain('"name": "초코"'); // 응답 예시
  expect(within(det).getByText("GET /pets/{petId} returns a pet")).toBeTruthy(); // 출처 인용
  expect(det.textContent).toContain("openapi");
  // 시안: 상세 위 라벨 줄은 메서드 + 기능 id
  expect(det.querySelector(".fd-label")!.textContent).toBe("GET pets.get");
  // 예시 없는 응답 스키마는 접고 요약 한 줄만 보인다
  const fold = det.querySelector("details.fd-schema") as HTMLDetailsElement;
  expect(fold.open).toBe(false);
  expect(fold.querySelector("summary")!.textContent).toBe("object · code, message");
  expect(fold.querySelector("pre")!.textContent).toContain('"message"');
});

it("상세 경로 글자 크기: .fd-path 안의 .ft-path는 부모 크기를 따른다(CSS)", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(`${process.cwd().replace(/\/packages\/web$/, "")}/packages/web/src/styles/app.css`, "utf8");
  expect(css).toMatch(/\.fd-path \.ft-path\s*\{[^}]*font-size:\s*inherit/);
});

it("행: 4열은 summary(없으면 id), 오른쪽 열은 응답 코드(⚠ 경고 수가 앞), 검색은 summary도 본다", async () => {
  setup(["pets.list"], {
    "GET /api/systems/petstore/features": () => ({ body: { ok: true, data: list([
      { ...row(1, "pets.list", "pets", "GET", "/pets", "펫 목록", ["200", "404"]), warnings: ["x", "y"] },
      row(2, "pets.get", "pets", "GET", "/pets/{petId}", "", ["200"]),
    ]) } }),
  });
  const { container } = render(<App />);
  await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  const rows = [...container.querySelectorAll(".ft-row")];
  expect(rows[0]!.querySelector(".ft-id")!.textContent).toBe("펫 목록");
  expect(rows[0]!.querySelector(".ft-meta")!.textContent).toBe("⚠ 2  200 404");
  expect(rows[1]!.querySelector(".ft-id")!.textContent).toBe("pets.get"); // summary 없으면 id
  expect(rows[1]!.querySelector(".ft-meta")!.textContent).toBe("200");
  fireEvent.change(screen.getByRole("searchbox", { name: "기능 검색" }), { target: { value: "펫 목록" } });
  expect(screen.queryByRole("checkbox", { name: "GET /pets/{petId} 선택" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "GET /pets 선택" })).toBeTruthy();
});

it("제목 아래 부제: 시스템 · 원본 파일명 · 기능 N개", async () => {
  setup(["pets.list"]);
  const { container } = render(<App />);
  await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  await vi.waitFor(() => expect(container.querySelector(".sel-sub")!.textContent).toBe("petstore · petstore.yaml · 기능 4개"));
});

it("필터 중 그룹 개수는 '보이는 선택/보이는 수 (전체 M)'", async () => {
  setup(["pets.list", "pets.create"]);
  const { container } = render(<App />);
  await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  const count = () => [...container.querySelectorAll(".ft-g-count")].map((e) => e.textContent);
  expect(count()).toEqual(["2/3", "0/1"]); // 필터 없음: 전체 표기 없음
  fireEvent.click(screen.getByRole("button", { name: "POST" }));
  expect(count()).toEqual(["1/1 (전체 3)"]);
});

it("전체 선택/해제: 보이는 행만, 보이지 않는 행의 선택은 그대로", async () => {
  const { api } = setup(["store.inv"]);
  render(<App />);
  await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  fireEvent.click(screen.getByRole("button", { name: "GET" })); // pets.list·pets.get·store.inv
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
  expect(screen.getByText("3개 선택")).toBeTruthy();
  expect(screen.getByRole("button", { name: "전체 해제" })).toBeTruthy();
  await advance(400);
  expect((saveBodies(api)[0] as { ids: string[] }).ids.sort()).toEqual(["pets.get", "pets.list", "store.inv"]);
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "GET" })); // 필터 해제
  fireEvent.click(screen.getByRole("button", { name: "POST" })); // pets.create만 보임
  fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
  expect(screen.getByText("4개 선택")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
  expect(screen.getByText("3개 선택")).toBeTruthy(); // POST 행만 풀렸다
});

it("하단 바: 3개 선택, mock 만들기로 ④ 이동", async () => {
  setup(["pets.list", "pets.get", "store.inv"]);
  render(<App />);
  expect(await screen.findByText("3개 선택")).toBeTruthy();
  expect(screen.getByText(/자동 저장/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /mock 만들기/ }));
  await vi.waitFor(() => expect(window.location.pathname).toBe("/systems/petstore/generate"));
});

it("0개면 버튼 비활성 + 이유 안내, 저장 호출 없음", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(1000);
  expect(screen.getByText("0개 선택")).toBeTruthy();
  const btn = screen.getByRole("button", { name: /mock 만들기/ }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(screen.getByText("하나 이상 골라 주세요")).toBeTruthy();
  expect(btn.getAttribute("aria-describedby")).toBeTruthy();
  expect(document.getElementById(btn.getAttribute("aria-describedby")!)!.textContent).toContain("하나 이상 골라 주세요");
  expect(saves(api)).toBe(0);
});

it("저장 실패: role=alert에 오류와 hint, 선택 상태는 유지", async () => {
  setup(["pets.list"], {
    "POST /api/systems/petstore/selection": () => ({ status: 400, body: { ok: false, error: { code: "invalid", message: "알 수 없는 기능 id예요", hint: "목록을 다시 불러오세요" } } }),
  });
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(400);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("알 수 없는 기능 id예요");
  expect(alert.textContent).toContain("목록을 다시 불러오세요");
  expect(cb.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("2개 선택")).toBeTruthy();
});

it("외부 변경(selection.json): 로컬 변경이 없으면 GET /selection을 다시 불러 반영", async () => {
  const { api, server } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  expect(cb.getAttribute("aria-checked")).toBe("false");
  const before = api.calls.filter((c) => c === "GET /api/systems/petstore/selection").length;
  server.selection = sel(["pets.list", "pets.create"]);
  emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
  await vi.waitFor(() => expect(rowCheckbox("POST /pets 선택").getAttribute("aria-checked")).toBe("true"));
  expect(api.calls.filter((c) => c === "GET /api/systems/petstore/selection").length).toBe(before + 1);
});

it("외부 변경: 저장 대기 중이면 배너를 띄우고 로컬 값을 유지, 불러오기로 반영", async () => {
  const { api, server } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  server.selection = sel(["store.inv"]);
  emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
  await advance(0);
  expect(screen.getByText(/다른 곳에서 선택이 바뀌었어요/)).toBeTruthy();
  expect(cb.getAttribute("aria-checked")).toBe("true"); // 로컬 값 유지
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await vi.waitFor(() => expect(screen.getByRole("checkbox", { name: "GET /store/inventory 선택" }).getAttribute("aria-checked")).toBe("true"));
  expect(rowCheckbox("POST /pets 선택").getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByText(/다른 곳에서 선택이 바뀌었어요/)).toBeNull();
  expect(saves(api)).toBe(0); // 불러오기는 대기 중이던 저장을 취소한다
});

it("배너가 떠 있으면 자동 저장을 멈추고, '내 선택 유지'를 누르면 바로 저장해 외부 값을 덮는다", async () => {
  const { api, server } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  server.selection = sel(["store.inv"]);
  emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
  await advance(0);
  expect(screen.getByRole("button", { name: "내 선택 유지" })).toBeTruthy();
  await advance(2000);
  expect(saves(api)).toBe(0); // 400ms가 지나도 외부 값을 덮지 않는다
  fireEvent.click(rowCheckbox("GET /pets/{petId} 선택")); // 배너 중 더 바꿔도 저장하지 않는다
  await advance(2000);
  expect(saves(api)).toBe(0);
  expect((screen.getByRole("button", { name: /mock 만들기/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "내 선택 유지" }));
  await advance(0);
  expect(saves(api)).toBe(1);
  expect((saveBodies(api)[0] as { ids: string[] }).ids.sort()).toEqual(["pets.create", "pets.get", "pets.list"]);
  expect(screen.queryByText(/다른 곳에서 선택이 바뀌었어요/)).toBeNull();
});

it("외부 변경: 우리가 저장한 값과 같은 이벤트(메아리)는 시간과 무관하게 무시", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(400);
  expect(saves(api)).toBe(1);
  for (const wait of [300, 5000]) {
    await advance(wait);
    emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
    await advance(0);
    expect(screen.queryByText(/다른 곳에서 선택이 바뀌었어요/)).toBeNull();
    expect(cb.getAttribute("aria-checked")).toBe("true");
  }
});

it("외부 변경: 저장 0.9초 뒤 다른 값이 쓰이면 메아리로 오해하지 않고 반영한다", async () => {
  const { api, server } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(400);
  expect(saves(api)).toBe(1);
  await advance(500);
  server.selection = sel(["store.inv"]);
  emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
  await advance(0);
  expect(screen.getByRole("checkbox", { name: "GET /store/inventory 선택" }).getAttribute("aria-checked")).toBe("true");
  expect(cb.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("1개 선택")).toBeTruthy();
});

it("저장 루프 중에 온 이벤트는 루프가 끝난 뒤 다시 확인한다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { api, server } = setup(["pets.list"]);
  const orig = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      api.calls.push(`POST ${String(input)}`); api.bodies.push(JSON.parse(String(init.body)));
      await gate;
      server.selection = sel((JSON.parse(String(init.body)) as { ids: string[] }).ids);
      return new Response(JSON.stringify({ ok: true, data: { selected: [] } }));
    }
    return orig(input, init);
  });
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(400);
  expect(saves(api)).toBe(1);
  const gets = () => api.calls.filter((c) => c === "GET /api/systems/petstore/selection").length;
  const before = gets();
  emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
  await advance(0);
  expect(gets()).toBe(before); // 루프 중에는 읽지 않는다
  release();
  await advance(0);
  await advance(0);
  expect(gets()).toBe(before + 1); // 끝난 뒤 한 번 확인
  expect(screen.queryByText(/다른 곳에서 선택이 바뀌었어요/)).toBeNull();
  expect(cb.getAttribute("aria-checked")).toBe("true");
});

it("저장이 실패한 뒤 mock 만들기를 누르면 다시 저장하고, 실패하면 이동하지 않는다", async () => {
  const { api } = setup(["pets.list"], {
    "POST /api/systems/petstore/selection": () => ({ status: 500, body: { ok: false, error: { code: "failed", message: "디스크에 쓸 수 없어요" } } }),
  });
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(400);
  expect(saves(api)).toBe(1);
  expect(screen.getByRole("alert").textContent).toContain("디스크에 쓸 수 없어요");
  fireEvent.click(screen.getByRole("button", { name: /mock 만들기/ }));
  await advance(0);
  expect(saves(api)).toBe(2); // 다시 저장을 시도한다
  expect(window.location.pathname).toBe("/systems/petstore/select");
  expect(screen.getByRole("alert").textContent).toContain("디스크에 쓸 수 없어요");
});

it("저장이 실패했다가 복구되면 mock 만들기가 저장한 뒤 이동한다", async () => {
  let fail = true;
  const { api } = setup(["pets.list"], {
    "POST /api/systems/petstore/selection": (b) => fail ? { status: 500, body: { ok: false, error: { code: "failed", message: "실패" } } } : { body: { ok: true, data: { selected: (b as { ids: string[] }).ids } } },
  });
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.click(cb);
  await advance(400);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: /mock 만들기/ }));
  await advance(0);
  expect(saves(api)).toBe(2);
  expect(window.location.pathname).toBe("/systems/petstore/generate");
});

it("디바운스 중에 화면을 옮겨도 마지막 변경을 저장한다(언마운트 flush)", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  fireEvent.click(cb);
  expect(saves(api)).toBe(0);
  act(() => { window.history.pushState(null, "", "/new"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await vi.waitFor(() => expect(saves(api)).toBe(1));
  expect((saveBodies(api)[0] as { ids: string[] }).ids.sort()).toEqual(["pets.create", "pets.list"]);
});

it("selection 응답이 오기 전에 토글하면 응답이 그 변경을 덮지 않는다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { server } = setup(["pets.list"]);
  const orig = globalThis.fetch;
  let hold = false;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (hold && !init?.method && String(input).endsWith("/selection")) { hold = false; await gate; }
    return orig(input, init);
  });
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  hold = true;
  server.selection = sel(["store.inv"]);
  emit("workspace-changed", { system: "petstore", files: ["selection.json"] });
  fireEvent.click(cb); // 응답 전에 토글
  release();
  await vi.waitFor(() => expect(screen.getByText(/다른 곳에서 선택이 바뀌었어요/)).toBeTruthy());
  expect(cb.getAttribute("aria-checked")).toBe("true"); // 내 토글이 살아 있다
  expect(screen.getByRole("checkbox", { name: "GET /pets 선택" }).getAttribute("aria-checked")).toBe("true");
});

it("다른 시스템 이벤트는 무시", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  const before = api.calls.length;
  emit("workspace-changed", { system: "other", files: ["selection.json"] });
  await new Promise((r) => setTimeout(r, 20));
  expect(api.calls.slice(before).filter((c) => c.includes("/petstore/"))).toEqual([]);
});

it("catalog.json 변경: 목록을 다시 부르고 없어진 id는 선택에서 빠진다", async () => {
  const { api, server } = setup(["pets.list", "store.inv"]);
  render(<App />);
  await screen.findByRole("checkbox", { name: "GET /store/inventory 선택" });
  expect(screen.getByText("2개 선택")).toBeTruthy();
  const before = api.calls.filter((c) => c === "GET /api/systems/petstore/features").length;
  server.rows = ROWS.filter((r) => r.id !== "store.inv");
  emit("workspace-changed", { system: "petstore", files: ["catalog.json"] });
  await vi.waitFor(() => expect(screen.queryByRole("checkbox", { name: "GET /store/inventory 선택" })).toBeNull());
  expect(api.calls.filter((c) => c === "GET /api/systems/petstore/features").length).toBe(before + 1);
  expect(screen.getByText("1개 선택")).toBeTruthy();
});

it("선택 안 된 행의 경로는 text-3, 경로 변수는 항상 span.var.text-3", async () => {
  setup(["pets.list"]);
  const { container } = render(<App />);
  await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  const paths = [...container.querySelectorAll(".ft-path")];
  const byText = (t: string) => paths.find((p) => p.textContent === t)!;
  expect(byText("/pets").className).not.toContain("text-3"); // pets.list와 pets.create 중 선택된 쪽
  const off = paths.filter((p) => p.textContent === "/store/inventory")[0]!;
  expect(off.className).toContain("text-3");
  const v = container.querySelector(".ft-path .var")!;
  expect(v.textContent).toBe("{petId}");
  expect(v.className).toContain("text-3");
});

it("검색·메서드 칩·그룹 필터로 행을 줄이고, 보이는 행만 그룹 토글에 반영", async () => {
  const { api } = setup([]);
  render(<App />);
  await screen.findByRole("checkbox", { name: "GET /pets 선택" });
  fireEvent.change(screen.getByRole("searchbox", { name: "기능 검색" }), { target: { value: "inventory" } });
  expect(screen.queryByRole("checkbox", { name: "GET /pets 선택" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "GET /store/inventory 선택" })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "기능 검색" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "POST" }));
  expect(screen.queryByRole("checkbox", { name: "GET /pets 선택" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "POST /pets 선택" })).toBeTruthy();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("checkbox", { name: /pets 그룹/ }));
  await advance(400);
  expect((saveBodies(api)[0] as { ids: string[] }).ids).toEqual(["pets.create"]);
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "POST" }));
  fireEvent.change(screen.getByRole("combobox", { name: "그룹 필터" }), { target: { value: "store" } });
  expect(screen.queryByRole("checkbox", { name: "GET /pets 선택" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "GET /store/inventory 선택" })).toBeTruthy();
});

it("TriCheckbox는 Space·Enter로도 토글", async () => {
  const { api } = setup(["pets.list"]);
  render(<App />);
  const cb = await screen.findByRole("checkbox", { name: "POST /pets 선택" });
  vi.useFakeTimers();
  fireEvent.keyDown(cb, { key: " " });
  expect(cb.getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(cb, { key: "Enter" });
  expect(cb.getAttribute("aria-checked")).toBe("false");
  await advance(400);
  expect(saves(api)).toBe(1);
});

it("카탈로그가 없으면 오류와 hint를 보인다", async () => {
  setup(null, {
    "GET /api/systems/petstore/features": () => ({ status: 400, body: { ok: false, error: { code: "no-catalog", message: "카탈로그가 없어요", hint: "② 분석을 먼저 해 주세요" } } }),
  });
  render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("카탈로그가 없어요");
  expect(alert.textContent).toContain("② 분석을 먼저 해 주세요");
});
