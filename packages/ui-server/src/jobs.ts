import { randomUUID } from "node:crypto";
import type { OnEvent } from "@specmock/core";
import type { EventBus } from "./bus.js";
import { toApiError } from "./errors.js";
import type { Job, JobKind } from "./api-types.js";

export class BusyJobError extends Error {
  readonly code = "busy" as const;
  constructor(readonly jobId: string) { super("이 시스템에서 진행 중인 작업이 있어요."); this.name = "BusyJobError"; }
}
export interface JobContext { signal: AbortSignal; onEvent: OnEvent }

/** 시스템당 작업 하나. 진행·결과는 EventBus로 알린다. */
export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running = new Map<string, string>(); // system → jobId
  constructor(private readonly bus: EventBus) {}

  start(system: string, kind: JobKind, run: (ctx: JobContext) => Promise<unknown>): Job {
    const busy = this.running.get(system);
    if (busy) throw new BusyJobError(busy);
    const job: Job = { id: randomUUID(), system, kind, state: "running", startedAt: new Date().toISOString() };
    const ac = new AbortController();
    this.jobs.set(job.id, job); this.controllers.set(job.id, ac); this.running.set(system, job.id);
    // SSE 루프는 큐에서 꺼낼 때 직렬화하므로, 그때의 객체가 아니라 발행 시점의 사본을 보낸다.
    const snap = (): Job => ({ ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) });
    this.bus.publish("job-started", snap());
    const onEvent: OnEvent = (e) => {
      job.progress = { message: e.message, ...(e.done !== undefined ? { done: e.done } : {}), ...(e.total !== undefined ? { total: e.total } : {}) };
      this.bus.publish("job-progress", snap());
    };
    void (async () => {
      try {
        job.result = await run({ signal: ac.signal, onEvent });
        job.state = "done"; job.endedAt = new Date().toISOString();
        this.bus.publish("job-done", snap());
      } catch (e) {
        // 취소는 오류 이름이 아니라 우리가 쥔 signal로 판정한다.
        if (ac.signal.aborted) { job.state = "cancelled"; job.error = { code: "cancelled", message: "작업을 취소했어요." }; }
        else { job.state = "failed"; job.error = toApiError(e).body.error; }
        job.endedAt = new Date().toISOString();
        this.bus.publish("job-failed", snap());
      } finally {
        this.running.delete(system); this.controllers.delete(job.id);
        this.prune(system, kind, job.id);
      }
    })();
    return snap();
  }
  cancel(id: string): Job | undefined { this.controllers.get(id)?.abort(); return this.jobs.get(id); }
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
}
