import type { Job, JobKind } from "@specmock/ui-server/api-types";
import { useCallback, useRef, useState } from "react";

/**
 * 한 시스템의 한 종류 작업(extract/generate/verify)을 화면에서 따라가는 훅.
 * `seen`은 이 화면이 시작했거나(watch) 실행 중인 걸 본 작업이다. 이전 방문의 오래된 결과로
 * 화면을 옮기거나 오류를 띄우지 않도록, 끝난 작업은 seen일 때만 반응 대상으로 삼는다.
 */
export function useJob(jobs: Job[], system: string, kind: JobKind) {
  const watched = useRef(new Set<string>());
  const [, bump] = useState(0);
  const watch = useCallback((id: string) => { if (!watched.current.has(id)) { watched.current.add(id); bump((n) => n + 1); } }, []);
  const mine = jobs.filter((j) => j.system === system && j.kind === kind);
  const last = mine[mine.length - 1];
  if (last?.state === "running") watched.current.add(last.id);
  return {
    last,
    running: last?.state === "running" ? last : undefined,
    /** 이 화면이 지켜본 마지막 작업(끝났어도). */
    seen: last && watched.current.has(last.id) ? last : undefined,
    watch,
  };
}
