import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Notice } from "../src/components/Notice";

it("Notice: role=alert, hint는 둘째 줄", () => {
  render(<Notice message="실패했어요" hint="먼저 ② 분석을 진행해 주세요." />);
  const a = screen.getByRole("alert");
  expect(a.textContent).toContain("실패했어요");
  expect(a.querySelector(".notice-hint")?.textContent).toBe("먼저 ② 분석을 진행해 주세요.");
});

it("ConfirmDialog: open일 때만 열려 있고, 취소·확인 콜백", () => {
  const onCancel = vi.fn(), onConfirm = vi.fn();
  const { rerender } = render(<ConfirmDialog open={false} title="t" confirmLabel="추출 시작" onCancel={onCancel} onConfirm={onConfirm}>본문</ConfirmDialog>);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<ConfirmDialog open title="t" confirmLabel="추출 시작" onCancel={onCancel} onConfirm={onConfirm}>본문</ConfirmDialog>);
  expect(screen.getByRole("dialog").textContent).toContain("본문");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "추출 시작" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
