import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Register } from "../src/screens/Register";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });

it("경로를 입력하면 시스템 이름이 제안되고, 이름은 직접 고칠 수 있다", () => {
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 경로 또는 URL", "/x/docs/petstore.yaml");
  expect(field("시스템 이름").value).toBe("petstore");
  type("시스템 이름", "my-pets");
  type("스펙 경로 또는 URL", "/x/docs/other.yaml");
  expect(field("시스템 이름").value).toBe("my-pets"); // 직접 고친 뒤에는 덮어쓰지 않는다
});

it("URL이면 호스트가 이름으로 제안된다", () => {
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 경로 또는 URL", "https://api.example.com/openapi.json");
  expect(field("시스템 이름").value).toBe("api-example-com");
});

it("등록을 누르면 POST /api/systems, 형식을 보이고 ② 분석으로 이동", async () => {
  const api = fakeApi({ "POST /api/systems": () => ({ body: { ok: true, data: { system: "petstore", file: "f", inputs: [{ kind: "openapi", origin: "/x/docs/petstore.yaml", chars: 10, cached: false, harvestCandidate: [], harvested: false }] } } }) });
  const go = vi.fn(), onRegistered = vi.fn();
  render(<Register go={go} onRegistered={onRegistered} />);
  expect((screen.getByRole("button", { name: "등록" }) as HTMLButtonElement).disabled).toBe(true);
  type("스펙 경로 또는 URL", "/x/docs/petstore.yaml");
  fireEvent.click(screen.getByRole("button", { name: "등록" }));
  expect(await screen.findByText("형식: OpenAPI")).toBeTruthy();
  expect(api.bodies[0]).toEqual({ system: "petstore", origins: ["/x/docs/petstore.yaml"] });
  expect(go).toHaveBeenCalledWith("/systems/petstore/analyze");
  expect(onRegistered).toHaveBeenCalled();
});

it("400 invalid면 alert에 message(와 hint)", async () => {
  fakeApi({ "POST /api/systems": () => ({ status: 400, body: { ok: false, error: { code: "invalid", message: "파일을 찾을 수 없어요: /nope.yaml", hint: "경로를 확인해 주세요." } } }) });
  const go = vi.fn();
  render(<Register go={go} onRegistered={() => {}} />);
  type("스펙 경로 또는 URL", "/nope.yaml");
  fireEvent.click(screen.getByRole("button", { name: "등록" }));
  expect((await screen.findByRole("alert")).textContent).toContain("파일을 찾을 수 없어요: /nope.yaml");
  expect(go).not.toHaveBeenCalled();
});

it("등록 버튼이 비활성인 이유를 안내한다 (aria-describedby), 채우면 안내가 사라진다", () => {
  render(<Register go={() => {}} onRegistered={() => {}} />);
  const btn = screen.getByRole("button", { name: "등록" }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  const reason = document.getElementById(btn.getAttribute("aria-describedby") ?? "none");
  expect(reason?.textContent).toContain("경로");
  type("스펙 경로 또는 URL", "/x/docs/petstore.yaml");
  expect(btn.disabled).toBe(false);
  expect(btn.getAttribute("aria-describedby")).toBeNull();
});
