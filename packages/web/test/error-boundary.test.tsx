import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

function Boom(): never { throw new Error("렌더 실패"); }

it("렌더 오류가 나면 안내와 새로고침 버튼", () => {
  const onReload = vi.fn();
  render(<ErrorBoundary onReload={onReload}><Boom /></ErrorBoundary>);
  expect(screen.getByRole("alert").textContent).toContain("화면에 문제가 생겼어요");
  fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(onReload).toHaveBeenCalledTimes(1);
});

it("오류가 없으면 자식을 그대로 보인다", () => {
  render(<ErrorBoundary><p>정상</p></ErrorBoundary>);
  expect(screen.getByText("정상")).toBeTruthy();
});
