import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { FlowSummary } from "@specmock/ui-server/api-types";
import { FlowList } from "../src/components/FlowList";

const summary = (over: Partial<FlowSummary>): FlowSummary => ({ id: "a", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: [], last: { mock: null, real: null }, ...over });

it("a cancelled last run shows a '취소됨' pill in the pending style", () => {
  render(<FlowList flows={[summary({ last: { mock: "cancelled", real: null } })]} current={null} onPick={() => {}} />);
  const item = screen.getByRole("listitem");
  expect(within(item).getByText("mock 취소됨").closest(".st-pending")).toBeTruthy();
  expect(within(item).getByText("실제 실행 전").closest(".st-pending")).toBeTruthy();
});

it("the list item's accessible name is the flow name only; the pills are its description", () => {
  render(<FlowList flows={[summary({ last: { mock: "success", real: null } })]} current={null} onPick={() => {}} />);
  const item = screen.getByRole("button", { name: "issue 다루기" }); // an exact name: no pill text in it
  const describedBy = item.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const description = document.getElementById(describedBy!)!.textContent ?? "";
  expect(description).toContain("빈 연결 1");
  expect(description).toContain("mock 성공");
  expect(description).toContain("실제 실행 전");
});

it("a click on the name picks the flow once; the selected item's button is marked current", () => {
  const picked: string[] = [];
  render(<FlowList flows={[summary({}), summary({ id: "b", name: "repo 다루기" })]} current="a" onPick={(id) => picked.push(id)} />);
  fireEvent.click(screen.getByRole("button", { name: "repo 다루기" }));
  expect(picked).toEqual(["b"]);
  expect(screen.getByRole("button", { name: "issue 다루기" }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("button", { name: "repo 다루기" }).getAttribute("aria-current")).toBeNull();
});
