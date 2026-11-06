import { expect, it } from "vitest";
import { EventBus } from "../src/bus.js";
import { JobManager } from "../src/jobs.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

it("시스템당 하나: 진행 중에 또 시작하면 BusyJobError(jobId 포함)", async () => {
  const jobs = new JobManager(new EventBus());
  let finish!: () => void;
  const a = jobs.start("pets", "extract", () => new Promise<void>((r) => { finish = r; }));
  expect(() => jobs.start("pets", "verify", async () => {})).toThrowError(expect.objectContaining({ code: "busy", jobId: a.id }));
  jobs.start("other", "verify", async () => {}); // 다른 시스템은 된다
  finish(); await tick();
  expect(jobs.get(a.id)!.state).toBe("done");
});

it("cancel은 signal을 abort하고 state=cancelled, error.code=cancelled", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe((e) => seen.push(e.event));
  const jobs = new JobManager(bus);
  const j = jobs.start("pets", "extract", ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  jobs.cancel(j.id); await tick(); await tick();
  expect(jobs.get(j.id)).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
  expect(seen).toEqual(["job-started", "job-failed"]);
});

it("취소 후 작업이 다른 오류로 끝나도 cancelled (signal.aborted 기준)", async () => {
  const jobs = new JobManager(new EventBus());
  const j = jobs.start("pets", "verify", ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("spawn 실패")))));
  jobs.cancel(j.id); await tick(); await tick();
  expect(jobs.get(j.id)).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
});

it("일반 오류는 failed + 변환된 error", async () => {
  const jobs = new JobManager(new EventBus());
  const j = jobs.start("pets", "verify", async () => { throw new Error("뭔가 깨짐"); });
  await tick(); await tick();
  expect(jobs.get(j.id)).toMatchObject({ state: "failed", error: { code: "failed", message: "뭔가 깨짐" } });
  // 끝난 뒤에는 같은 시스템에서 다시 시작할 수 있다
  expect(() => jobs.start("pets", "verify", async () => {})).not.toThrow();
});

it("진행 이벤트는 job-progress로, 결과는 job-done으로", async () => {
  const bus = new EventBus();
  const seen: { event: string; data: any }[] = [];
  bus.subscribe((e) => seen.push(e as { event: string; data: any }));
  const jobs = new JobManager(bus);
  jobs.start("pets", "extract", async ({ onEvent }) => { onEvent({ stage: "extract", message: "추출 1/2", done: 1, total: 2 }); return { ok: 1 }; });
  await tick(); await tick();
  expect(seen.map((e) => e.event)).toEqual(["job-started", "job-progress", "job-done"]);
  expect(seen[1]!.data.progress).toEqual({ message: "추출 1/2", done: 1, total: 2 });
  expect(seen[2]!.data.result).toEqual({ ok: 1 });
  expect(jobs.list().recent).toHaveLength(1);
});

it("recent는 시스템·종류별 마지막 하나만", async () => {
  const jobs = new JobManager(new EventBus());
  const a = jobs.start("pets", "verify", async () => 1); await tick(); await tick();
  const b = jobs.start("pets", "verify", async () => 2); await tick(); await tick();
  jobs.start("pets", "generate", async () => 3); await tick(); await tick();
  const ids = jobs.list().recent.map((j) => j.id);
  expect(ids).not.toContain(a.id);
  expect(ids).toContain(b.id);
  expect(ids).toHaveLength(2);
});

it("cancelAll은 진행 중인 모든 작업을 취소한다", async () => {
  const jobs = new JobManager(new EventBus());
  const hang = ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const a = jobs.start("a", "extract", hang);
  const b = jobs.start("b", "verify", hang);
  jobs.cancelAll(); await tick(); await tick();
  expect([jobs.get(a.id)!.state, jobs.get(b.id)!.state]).toEqual(["cancelled", "cancelled"]);
});

it("취소 불가 작업(generate): cancel은 NotCancellableError, 실제 오류가 cancelled로 가려지지 않는다", async () => {
  const jobs = new JobManager(new EventBus());
  let fail!: () => void;
  const j = jobs.start("pets", "generate", () => new Promise((_, reject) => { fail = () => reject(new Error("진짜 오류")); }));
  expect(j.cancellable).toBe(false);
  expect(() => jobs.cancel(j.id)).toThrowError(expect.objectContaining({ name: "NotCancellableError" }));
  jobs.cancelAll(); // 종료 시 일괄 abort 뒤에도 판정은 그대로
  fail(); await tick(); await tick();
  expect(jobs.get(j.id)).toMatchObject({ state: "failed", error: { message: "진짜 오류" } });
});

it("extract·verify는 cancellable, /jobs 목록에도 실린다", async () => {
  const jobs = new JobManager(new EventBus());
  const a = jobs.start("a", "extract", () => new Promise(() => {}));
  const b = jobs.start("b", "verify", () => new Promise(() => {}));
  expect(jobs.list().running.map((j) => [j.id, j.cancellable])).toEqual([[a.id, true], [b.id, true]]);
});

it("abort 뒤에도 성공 완료하면 done 유지", async () => {
  const jobs = new JobManager(new EventBus());
  let finish!: () => void;
  const j = jobs.start("pets", "extract", () => new Promise<string>((r) => { finish = () => r("merged"); }));
  jobs.cancel(j.id); finish(); await tick(); await tick();
  expect(jobs.get(j.id)).toMatchObject({ state: "done", result: "merged" });
});

it("whenIdle은 진행 중 작업이 끝나면 true, 시간이 지나면 false", async () => {
  const jobs = new JobManager(new EventBus());
  let finish!: () => void;
  jobs.start("a", "generate", () => new Promise<void>((r) => { finish = r; }));
  expect(await jobs.whenIdle(30)).toBe(false);
  setTimeout(finish, 20);
  expect(await jobs.whenIdle(1000)).toBe(true);
  expect(await jobs.whenIdle(10)).toBe(true);
});

it("shutdown 뒤에는 새 작업을 ShuttingDownError로 거부하고 진행 중인 작업은 취소한다", async () => {
  const jobs = new JobManager(new EventBus());
  const a = jobs.start("a", "extract", ({ signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))));
  jobs.shutdown();
  expect(() => jobs.start("b", "verify", async () => {})).toThrowError(expect.objectContaining({ code: "shutting-down" }));
  await tick(); await tick();
  expect(jobs.get(a.id)!.state).toBe("cancelled");
});
