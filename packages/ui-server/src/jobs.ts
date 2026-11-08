import { randomUUID } from "node:crypto";
import type { OnEvent } from "@specmock/core";
import type { EventBus } from "./bus.js";
import { toApiError } from "./errors.js";
import type { Job, JobKind } from "./api-types.js";

export class BusyJobError extends Error {
  readonly code = "busy" as const;
  constructor(readonly jobId: string) { super("이 시스템에서 진행 중인 작업이 있어요."); this.name = "BusyJobError"; }
}
export class NotCancellableError extends Error {
  readonly code = "not-cancellable" as const;
  constructor() { super("이 작업은 취소할 수 없어요"); this.name = "NotCancellableError"; }
}
export class ShuttingDownError extends Error {
  readonly code = "shutting-down" as const;
  constructor() { super("서버를 끄는 중이에요"); this.name = "ShuttingDownError"; }
}
/** generate는 도중에 멈출 수 없다(파일을 쓰는 중). 나머지는 signal을 따른다. */
const CANCELLABLE: Record<JobKind, boolean> = { extract: true, verify: true, generate: false };
export interface JobContext { signal: AbortSignal; onEvent: OnEvent }

/** 시스템당 작업 하나. 진행·결과는 EventBus로 알린다. */
export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running = new Map<string, string>(); // system → jobId
  private settled = new Set<Promise<void>>();
  private closing = false;
  constructor(private readonly bus: EventBus) {}

  start(system: string, kind: JobKind, run: (ctx: JobContext) => Promise<unknown>, input?: Job["input"]): Job {
    if (this.closing) throw new ShuttingDownError();
    const busy = this.running.get(system);
    if (busy) throw new BusyJobError(busy);
    const job: Job = { id: randomUUID(), system, kind, state: "running", cancellable: CANCELLABLE[kind], startedAt: new Date().toISOString(), ...(input ? { input } : {}) };
    const ac = new AbortController();
    this.jobs.set(job.id, job); this.controllers.set(job.id, ac); this.running.set(system, job.id);
    // SSE 루프는 큐에서 꺼낼 때 직렬화하므로, 그때의 객체가 아니라 발행 시점의 사본을 보낸다.
    const snap = (): Job => ({ ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) });
    this.bus.publish("job-started", snap());
    const onEvent: OnEvent = (e) => {
      // done/total이 없는 이벤트(병합 중 등)는 이전 값을 유지한다. 화면 진행 막대가 0으로 되돌아가지 않게 한다.
      const done = e.done ?? job.progress?.done;
      const total = e.total ?? job.progress?.total;
      job.progress = { message: e.message, ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}) };
      this.bus.publish("job-progress", snap());
    };
    const task = (async () => {
      try {
        job.result = await run({ signal: ac.signal, onEvent });
        job.state = "done"; job.endedAt = new Date().toISOString();
        this.bus.publish("job-done", snap());
      } catch (e) {
        // 취소는 오류 이름이 아니라 우리가 쥔 signal로 판정한다. 취소할 수 없는 작업의 오류는 그대로 둔다.
        if (ac.signal.aborted && job.cancellable) { job.state = "cancelled"; job.error = { code: "cancelled", message: "작업을 취소했어요." }; }
        else { job.state = "failed"; job.error = toApiError(e).body.error; }
        job.endedAt = new Date().toISOString();
        this.bus.publish("job-failed", snap());
      } finally {
        this.running.delete(system); this.controllers.delete(job.id);
        this.prune(system, kind, job.id);
      }
    })();
    this.settled.add(task);
    void task.finally(() => this.settled.delete(task));
    return snap();
  }
  /** 진행 중이면 abort. 취소할 수 없는 작업이 아직 돌고 있으면 NotCancellableError. 끝난 작업은 그대로 돌려준다. */
  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job?.state === "running" && !job.cancellable) throw new NotCancellableError();
    this.controllers.get(id)?.abort();
    return job;
  }
  /** 진행 중인 작업이 모두 끝나면 true, timeoutMs가 지나면 false. */
  async whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.settled.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => { timer = setTimeout(() => r(false), timeoutMs); });
    try { return await Promise.race([Promise.all([...this.settled]).then(() => true as const), timeout]); } finally { clearTimeout(timer); }
  }
  get(id: string): Job | undefined { return this.jobs.get(id); }
  list(): { running: Job[]; recent: Job[] } {
    const all = [...this.jobs.values()];
    return { running: all.filter((j) => j.state === "running"), recent: all.filter((j) => j.state !== "running") };
  }
  /** 끝난 작업은 시스템·종류별 마지막 하나만 남긴다. */
  private prune(system: string, kind: JobKind, keep: string): void {
    for (const [id, j] of this.jobs) if (id !== keep && j.system === system && j.kind === kind && j.state !== "running") this.jobs.delete(id);
  }
  /** 서버 종료 시 진행 중인 작업을 모두 취소한다. */
  cancelAll(): void { for (const ac of this.controllers.values()) ac.abort(); }
  /** 새 작업을 더 받지 않고(503) 진행 중인 작업을 모두 취소한다. */
  shutdown(): void { this.closing = true; this.cancelAll(); }
}
