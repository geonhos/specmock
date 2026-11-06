import { watch } from "node:fs";
import path from "node:path";

const IGNORE = /(^|\/)(\.lock|[^/]*\.tmp|[^/]*\.stale)$/;

export interface WorkspaceChange { system: string | null; files: string[] }

/** 작업 공간을 재귀 감시해 시스템별로 디바운스한 변경 목록을 낸다. 디렉터리는 미리 있어야 한다. */
export function watchWorkspace(dir: string, emit: (e: WorkspaceChange) => void, opts: { debounceMs?: number; unref?: boolean } = {}): { close: () => void } {
  const rootName = path.basename(dir);
  const pending = new Map<string | null, Set<string>>();
  const timers = new Map<string | null, NodeJS.Timeout>();
  const w = watch(dir, { recursive: true }, (_ev, filename) => {
    const rel = filename ? String(filename).split(/[\\/]/).join("/") : null;
    if (rel && (IGNORE.test(rel) || rel === rootName)) return; // macOS는 감시 루트 자신의 변경도 루트 이름으로 알린다
    const [system, ...rest] = rel ? rel.split("/") : [null];
    const key = system ?? null;
    const set = pending.get(key) ?? new Set<string>();
    if (rest.length) set.add(rest.join("/"));
    pending.set(key, set);
    clearTimeout(timers.get(key));
    const t = setTimeout(() => { timers.delete(key); const files = [...(pending.get(key) ?? [])]; pending.delete(key); emit({ system: key, files }); }, opts.debounceMs ?? 150);
    if (opts.unref) t.unref();
    timers.set(key, t);
  });
  w.on("error", () => { /* 감시 대상이 사라지면 조용히 멈춘다 */ });
  if (opts.unref) w.unref();
  return { close: () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); pending.clear(); w.close(); } };
}
