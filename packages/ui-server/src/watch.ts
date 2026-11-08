import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

const IGNORE = /(^|\/)(\.lock|[^/]*\.tmp|[^/]*\.stale)$/;

export interface WorkspaceChange { system: string | null; files: string[] }
export interface WatchOptions {
  debounceMs?: number;
  /** 연속 쓰기 중에도 이 시간마다 한 번은 알린다. 기본 1000. */
  maxWaitMs?: number;
  unref?: boolean;
  /** 오류 뒤 재감시 횟수와 첫 대기(지수 백오프). 기본 3회, 200ms. */
  retry?: { attempts: number; baseMs: number };
  /** 재감시에도 실패해 감시가 멈췄을 때. */
  onError?: (e: Error) => void;
  /** 테스트용 대체 구현. */
  watchFn?: typeof fsWatch;
}

/** 작업 공간을 재귀 감시해 시스템별로 디바운스한 변경 목록을 낸다. 디렉터리는 미리 있어야 한다. */
export function watchWorkspace(dir: string, emit: (e: WorkspaceChange) => void, opts: WatchOptions = {}): { close: () => void } {
  const rootName = path.basename(dir);
  const debounceMs = opts.debounceMs ?? 150;
  const maxWaitMs = opts.maxWaitMs ?? 1000;
  const retry = opts.retry ?? { attempts: 3, baseMs: 200 };
  const watchFn = opts.watchFn ?? fsWatch;
  const pending = new Map<string | null, Set<string>>();
  const timers = new Map<string | null, NodeJS.Timeout>();
  const firstAt = new Map<string | null, number>();
  let closed = false;
  let failures = 0;
  let w: FSWatcher | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const flush = (key: string | null) => {
    timers.delete(key); firstAt.delete(key);
    const files = [...(pending.get(key) ?? [])]; pending.delete(key);
    emit({ system: key, files });
  };
  const onChange = (filename: string | Buffer | null) => {
    failures = 0;
    const rel = filename ? String(filename).split(/[\\/]/).join("/") : null;
    if (rel && (IGNORE.test(rel) || rel === rootName)) return; // macOS는 감시 루트 자신의 변경도 루트 이름으로 알린다
    const [system, ...rest] = rel ? rel.split("/") : [null];
    const key = system ?? null;
    const set = pending.get(key) ?? new Set<string>();
    if (rest.length) set.add(rest.join("/"));
    pending.set(key, set);
    clearTimeout(timers.get(key));
    const now = Date.now();
    const first = firstAt.get(key) ?? now;
    firstAt.set(key, first);
    const t = setTimeout(() => flush(key), Math.max(0, Math.min(debounceMs, first + maxWaitMs - now)));
    if (opts.unref) t.unref();
    timers.set(key, t);
  };
  const fail = (e: Error) => {
    w?.close(); w = undefined;
    if (closed) return;
    if (failures >= retry.attempts) { opts.onError?.(e); return; }
    const delay = retry.baseMs * 2 ** failures++;
    retryTimer = setTimeout(() => start(true), delay);
    if (opts.unref) retryTimer.unref();
  };
  const start = (retried = false) => {
    if (closed) return;
    try {
      const next = watchFn(dir, { recursive: true }, (_ev, filename) => onChange(filename));
      next.on("error", (e) => { if (next === w) fail(e); });
      if (opts.unref) next.unref();
      w = next;
      if (retried) { failures = 0; emit({ system: null, files: [] }); } // 감시가 끊긴 사이 놓친 변경을 전체 다시 불러오기로 메운다
    } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
  };
  start();
  return { close: () => { closed = true; clearTimeout(retryTimer); for (const t of timers.values()) clearTimeout(t); timers.clear(); firstAt.clear(); pending.clear(); w?.close(); } };
}
