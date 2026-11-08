import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useServerEvents } from "../src/events";
import { FakeEventSource } from "./fakes";

function Probe({ onReconnect }: { onReconnect?: () => void }) {
  const { connected, dead } = useServerEvents({ onReconnect });
  return <p>{dead ? "dead" : connected ? "connected" : "reconnecting"}</p>;
}

beforeEach(() => { FakeEventSource.all = []; FakeEventSource.last = undefined; vi.stubGlobal("EventSource", FakeEventSource); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("연결이 영구히 닫히면(CLOSED) 백오프로 새로 만들고, ready가 오면 복구·onReconnect", async () => {
  const onReconnect = vi.fn();
  render(<Probe onReconnect={onReconnect} />);
  act(() => FakeEventSource.last!.emit("ready", {}));
  act(() => FakeEventSource.last!.fail(true));
  expect(screen.getByText("reconnecting")).toBeTruthy();
  expect(FakeEventSource.all).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(FakeEventSource.all).toHaveLength(2);
  expect(FakeEventSource.all[0]!.closed).toBe(true);
  act(() => FakeEventSource.last!.emit("ready", {}));
  expect(screen.getByText("connected")).toBeTruthy();
  expect(onReconnect).toHaveBeenCalledTimes(1);
});

it("브라우저가 알아서 재연결하는 오류(CONNECTING)는 새로 만들지 않는다", async () => {
  render(<Probe />);
  act(() => FakeEventSource.last!.fail(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(FakeEventSource.all).toHaveLength(1);
  expect(screen.getByText("reconnecting")).toBeTruthy();
});

it("계속 실패하면 포기하고 dead", async () => {
  render(<Probe />);
  for (let i = 0; i < 10; i++) {
    act(() => FakeEventSource.last!.fail(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  }
  expect(screen.getByText("dead")).toBeTruthy();
  const n = FakeEventSource.all.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(FakeEventSource.all).toHaveLength(n);
  expect(n).toBeLessThanOrEqual(8);
});

it("언마운트하면 연결을 닫고 예약된 재연결도 취소한다", async () => {
  const { unmount } = render(<Probe />);
  const es = FakeEventSource.last!;
  act(() => es.fail(true));
  unmount();
  expect(es.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeEventSource.all).toHaveLength(1);
});
