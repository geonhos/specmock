import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => { delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal; });

it("ConfirmDialog: showModal이 있으면 그걸로 연다(포커스 가두기·aria-modal은 브라우저가)", () => {
  const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  (HTMLDialogElement.prototype as { showModal?: unknown }).showModal = showModal;
  render(<ConfirmDialog open title="t" confirmLabel="확인" onCancel={() => {}} onConfirm={() => {}}>본문</ConfirmDialog>);
  expect(showModal).toHaveBeenCalledTimes(1);
});

it("ConfirmDialog: 닫히면 연 버튼으로 포커스가 돌아간다", () => {
  const props = { title: "t", confirmLabel: "확인", onCancel: () => {}, onConfirm: () => {} };
  const { rerender } = render(<><button type="button">열기</button><ConfirmDialog open={false} {...props}>본문</ConfirmDialog></>);
  const opener = screen.getByRole("button", { name: "열기" });
  opener.focus();
  rerender(<><button type="button">열기</button><ConfirmDialog open {...props}>본문</ConfirmDialog></>);
  expect(document.activeElement).not.toBe(opener);
  rerender(<><button type="button">열기</button><ConfirmDialog open={false} {...props}>본문</ConfirmDialog></>);
  expect(document.activeElement).toBe(opener);
});

it("ConfirmDialog: Esc와 배경(dialog 자신) 클릭은 취소, 안쪽 클릭은 아님", () => {
  const onCancel = vi.fn();
  render(<ConfirmDialog open title="t" confirmLabel="확인" onCancel={onCancel} onConfirm={() => {}}>본문</ConfirmDialog>);
  fireEvent.click(screen.getByText("본문"));
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("dialog"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(2);
});

it("ConfirmDialog: showModal 환경에서는 브라우저의 cancel 이벤트(Esc)를 취소로 본다", () => {
  (HTMLDialogElement.prototype as { showModal?: unknown }).showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  const onCancel = vi.fn();
  render(<ConfirmDialog open title="t" confirmLabel="확인" onCancel={onCancel} onConfirm={() => {}}>본문</ConfirmDialog>);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
