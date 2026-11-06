import type { Job, SystemOverview } from "@specmock/ui-server/api-types";
import type { ChunkSummary } from "@specmock/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { ChunkTable } from "../components/ChunkTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Notice } from "../components/Notice";
import { kindLabel } from "../format";
import { pathFor } from "../route";

interface ExtractResult { mode?: string; incomplete?: boolean; extract?: { failed?: { chunk: number }[] } }
interface Props {
  system: string; claude: boolean | undefined; jobs: Job[];
  /** workspace-changed가 올 때마다 늘어난다. 개요·청크를 다시 읽는 신호. */
  tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void;
}

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

export function Analyze({ system, claude, jobs, tick, go, refreshJobs, onChanged }: Props) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [chunks, setChunks] = useState<ChunkSummary[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const watched = useRef(new Set<string>()); // 이 화면이 실행 중인 걸 본 작업만 끝났을 때 화면을 옮긴다

  const load = useCallback(async () => {
    try {
      const o = await api.overview(system);
      setOverview(o);
      setChunks(o.analyze === "prepared" ? await api.chunks(system) : []);
    } catch (e) { setError(asError(e)); }
  }, [system]);
  useEffect(() => { void load(); }, [load, tick]);

  const mine = jobs.filter((j) => j.system === system && j.kind === "extract");
  const last = mine[mine.length - 1];
  if (last?.state === "running") watched.current.add(last.id);
  const running = last?.state === "running" ? last : undefined;

  const doneId = last?.state === "done" && watched.current.has(last.id) ? last.id : undefined;
  const result = last?.state === "done" ? (last.result as ExtractResult | undefined) : undefined;
  useEffect(() => {
    if (!doneId) return;
    void load();
    if (result?.mode === "catalog" && !result.incomplete) go(pathFor("select", system));
  }, [doneId]); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = new Set((result?.extract?.failed ?? []).map((f) => f.chunk));
  const retryable = last?.state === "done" && result?.incomplete && dismissed !== last.id;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(asError(e)); refreshJobs(); } finally { setBusy(false); }
  };
  const analyze = () => run(async () => {
    const r = await api.analyze(system);
    onChanged();
    if (r.mode === "catalog") go(pathFor("select", system)); else await load();
  });
  const extract = () => { setConfirm(false); if (last) setDismissed(last.id); return run(async () => { await api.extract(system, false); refreshJobs(); }); };

  if (!overview) return error ? <Notice message={error.message} hint={error.hint} /> : <p className="muted">불러오는 중이에요</p>;

  const format = kindLabel(overview.source[0]?.kind);
  const pct = (j: Job) => (j.progress?.total ?? chunks.length) || 0;
  return (
    <div className="analyze">
      {format ? <p className="format">형식: {format}</p> : null}
      {error ? <Notice message={error.message} hint={error.hint} /> : null}
      {last?.state === "failed" && watched.current.has(last.id) ? <Notice message={last.error?.message ?? "추출에 실패했어요"} hint={last.error?.hint} /> : null}
      {last?.state === "cancelled" && watched.current.has(last.id) ? <p className="muted">추출을 취소했어요. 끝낸 청크는 그대로 남아 있어요.</p> : null}

      {overview.analyze === "catalog" ? (
        <>
          <p>분석을 마쳤어요. 기능 {overview.catalogTotal}개</p>
          <div><button type="button" className="btn-primary" onClick={() => go(pathFor("select", system))}>③ 기능 선택으로</button></div>
        </>
      ) : overview.analyze === "none" ? (
        <div><button type="button" className="btn-primary" disabled={busy} onClick={() => void analyze()}>분석하기</button></div>
      ) : (
        <>
          <ChunkTable chunks={chunks} failed={failed} />
          {running ? (
            <div className="progress-row">
              <div className="progress" role="progressbar" aria-label="추출 진행" aria-valuemin={0} aria-valuenow={running.progress?.done ?? 0} aria-valuemax={pct(running)}>
                <div className="progress-fill" style={{ width: `${pct(running) ? Math.min(100, ((running.progress?.done ?? 0) / pct(running)) * 100) : 0}%` }} />
              </div>
              <span className="muted">{running.progress?.message ?? "추출을 시작했어요"}</span>
              {running.cancellable ? <button type="button" className="btn-ghost" onClick={() => void run(() => api.cancel(running.id))}>취소</button> : null}
            </div>
          ) : claude === false ? (
            <p role="note" className="muted">이 컴퓨터에서 <code>claude</code> CLI를 찾지 못했어요. Claude Code 대화에서 <code>analyze_spec</code>부터 진행하면 추출 결과가 이 화면에 바로 반영돼요.</p>
          ) : retryable ? (
            <div><button type="button" className="btn-primary" disabled={busy} onClick={() => setConfirm(true)}>실패한 청크 {failed.size}개만 다시 추출</button></div>
          ) : (
            <div><button type="button" className="btn-primary" disabled={busy} onClick={() => setConfirm(true)}>추출 시작</button></div>
          )}
          <ConfirmDialog open={confirm} title="추출을 시작할까요?" confirmLabel="추출 시작" onCancel={() => setConfirm(false)} onConfirm={() => void extract()}>
            청크 {chunks.length}개를 <code>claude</code> CLI로 추출해요. 구독 사용량이 발생해요.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}
