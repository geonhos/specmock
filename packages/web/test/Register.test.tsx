import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Register } from "../src/screens/Register";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const okBody = (data: unknown) => () => ({ body: { ok: true, data } });
const rows = [
  { id: "issues_create", group: "issues", method: "POST", path: "/repos/{owner}/{repo}/issues", summary: "", warnings: [], codes: ["201"] },
  { id: "repos_get", group: "repos", method: "GET", path: "/repos/{owner}/{repo}", summary: "", warnings: [], codes: ["200"] },
];
const routes = () => ({
  "POST /api/systems": okBody({ system: "gh", inputs: [{ kind: "openapi" }] }),
  "POST /api/systems/gh/analyze": okBody({ mode: "catalog" }),
  "POST /api/systems/gh/env": okBody({ names: ["API_TOKEN"] }),
  "GET /api/systems/gh/target": okBody({ exists: false, example: "{}", suggestedBaseUrl: "https://api.github.com" }),
  "GET /api/systems/gh/feature-groups": okBody({ total: 2, groups: [{ group: "issues", total: 1 }, { group: "repos", total: 1 }] }),
  "GET /api/systems/gh/features?group=issues": okBody({ total: 1, rows: [rows[0]], groups: ["issues", "repos"] }),
  "GET /api/systems/gh/features?group=repos": okBody({ total: 1, rows: [rows[1]], groups: ["issues", "repos"] }),
  "PUT /api/systems/gh/target": okBody({ exists: true }),
  "POST /api/systems/gh/selection": okBody({ selected: ["issues_create"] }),
  "POST /api/systems/gh/flows/infer": okBody({ flows: [] }),
});

it("stage 1: name, spec URL, token → ingest, analyze, token into server memory; stage 2 shows the suggested base URL", async () => {
  const api = fakeApi(routes());
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/github.yaml");
  type("서비스 이름", "gh");
  type("테스트 토큰", "ghp_secret");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  expect(((await screen.findByLabelText("주소")) as HTMLInputElement).value).toBe("https://api.github.com");
  expect(api.bodies[api.calls.indexOf("POST /api/systems/gh/env")]).toEqual({ values: { API_TOKEN: "ghp_secret" } });
  expect(screen.getByRole("button", { name: /issues/ }).getAttribute("aria-expanded")).toBe("false"); // groups stay collapsed
  expect(api.calls.some((c) => c.startsWith("GET /api/systems/gh/features"))).toBe(false); // 묶음 요약만 받고 행은 받지 않는다
});

it("stage 2: a group's rows are fetched on first open, only once", async () => {
  const api = fakeApi(routes());
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/github.yaml"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  const issues = await screen.findByRole("button", { name: /issues/ });
  fireEvent.click(issues);
  expect(await screen.findByRole("checkbox", { name: "POST /repos/{owner}/{repo}/issues 선택" })).toBeTruthy();
  fireEvent.click(issues); // 접기
  fireEvent.click(issues); // 다시 열기: 이미 받은 행을 쓴다
  await screen.findByRole("checkbox", { name: "POST /repos/{owner}/{repo}/issues 선택" });
  expect(api.calls.filter((c) => c === "GET /api/systems/gh/features?group=issues")).toHaveLength(1);
  expect(api.calls).not.toContain("GET /api/systems/gh/features?group=repos");
});

it("stage 2: pick a group, save → PUT target, POST selection (literal ids), infer, go to flows", async () => {
  const api = fakeApi(routes());
  const go = vi.fn(), onRegistered = vi.fn();
  render(<Register go={go} onRegistered={onRegistered} />);
  type("스펙 URL", "https://example.com/github.yaml"); type("서비스 이름", "gh"); type("테스트 토큰", "ghp_secret"); // the header is only built when a token is given
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /^issues 그룹 전체 선택$/ }));
  await screen.findByText(/1개 선택/); // the group's rows are fetched before they are picked
  // Astryx CheckboxInput is a native input: state is .checked / .indeterminate, not aria-checked
  expect(screen.getByRole("checkbox", { name: /^issues 그룹 전체 선택$/ })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: /^repos 그룹 전체 선택$/ })).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("button", { name: "등록하고 흐름 만들기" }));
  await vi.waitFor(() => expect(go).toHaveBeenCalledWith("/systems/gh/flows"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/gh/selection")]).toEqual({ ids: ["issues_create"] });
  expect(api.calls).toContain("POST /api/systems/gh/flows/infer");
  const put = api.bodies[api.calls.indexOf("PUT /api/systems/gh/target")] as { baseUrl: string; headers: { name: string; value: string }[] };
  expect(put.baseUrl).toBe("https://api.github.com");
  expect(put.headers).toEqual([{ name: "Authorization", value: "Bearer ${API_TOKEN}" }]);
  expect(onRegistered).toHaveBeenCalled();
});

it("not OpenAPI → stops on the registration screen with the reason", async () => {
  fakeApi({ ...routes(), "POST /api/systems/gh/analyze": okBody({ mode: "prepared" }) });
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/doc.md"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  expect((await screen.findByRole("alert")).textContent).toContain("OpenAPI 스펙이 아니에요");
});

it("ingest error (unreadable URL) shows message and hint", async () => {
  fakeApi({ ...routes(), "POST /api/systems": () => ({ status: 400, body: { ok: false, error: { code: "invalid", message: "스펙을 읽지 못했어요", hint: "URL을 확인해 주세요." } } }) });
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://nope"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  expect((await screen.findByRole("alert")).textContent).toContain("스펙을 읽지 못했어요");
});

it("stage 2: a group checkbox is indeterminate while only some rows are picked, checked when all are", async () => {
  fakeApi({ ...routes(),
    "GET /api/systems/gh/feature-groups": okBody({ total: 2, groups: [{ group: "issues", total: 2 }] }),
    "GET /api/systems/gh/features?group=issues": okBody({ total: 2, rows: [rows[0], { ...rows[0], id: "issues_list", method: "GET", path: "/repos/{owner}/{repo}/issues" }], groups: ["issues"] }) });
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/github.yaml"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  fireEvent.click(await screen.findByRole("button", { name: /issues/ }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "GET /repos/{owner}/{repo}/issues 선택" }));
  const group = screen.getByRole("checkbox", { name: /^issues 그룹 전체 선택$/ }) as HTMLInputElement;
  expect(group.indeterminate).toBe(true);
  expect(group.checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "POST /repos/{owner}/{repo}/issues 선택" }));
  expect(group.indeterminate).toBe(false);
  expect(group.checked).toBe(true);
});
