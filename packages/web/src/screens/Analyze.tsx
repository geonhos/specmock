import type { Job, SystemOverview } from "@specmock/ui-server/api-types";
import type { ChunkSummary } from "@specmock/core";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { ChunkTable } from "../components/ChunkTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Notice } from "../components/Notice";
import { jobKindLabel, kindLabel } from "../format";
import { pathFor } from "../route";
import { useJob } from "../useJob";

interface ExtractResult { mode?: string; incomplete?: boolean; extract?: { failed?: { chunk: number }[] }; merge?: { missingChunks?: number[] } }
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
  const [, bump] = useState(0);
  const { last, running, seen, watch } = useJob(jobs, system, "extract");

  const load = useCallback(async () => {
    try {
      const o = await api.overview(system);
      setOverview(o);
      setChunks(o.summary.chunks ? await api.chunks(system) : []);
    } catch (e) { setError(asError(e)); }
  }, [system]);
  useEffect(() => { void load(); }, [load, tick]);

  const doneId = seen?.state === "done" ? seen.id : undefined;
  const result = last?.state === "done" ? (last.result as ExtractResult | undefined) : undefined;
  useEffect(() => {
    if (!doneId) return;
    void load();
    if (result?.mode === "catalog" && !result.incomplete) go(pathFor("select", system));
  }, [doneId]); // eslint-disable-line react-hooks/exhaustive-deps

  const other = jobs.find((j) => j.system === system && j.kind !== "extract" && j.state === "running");

  // 청크가 덜 끝났는데 merge가 catalog를 만든 "불완전" 상태. ③으로 갈 수도, 남은 청크만 다시 추출할 수도 있다.
  const unfinished = chunks.filter((c) => !c.done).length;
  const incomplete = overview?.analyze === "catalog" && unfinished > 0;
  const failed = new Set((result?.extract?.failed ?? []).map((f) => f.chunk).filter((i) => chunks.some((c) => c.index === i && !c.done)));
  const retryCount = incomplete ? failed.size || unfinished : 0;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    } finally { setBusy(false); }
  };
  const analyze = () => run(async () => {
    const r = await api.analyze(system);
    onChanged();
    if (r.mode === "catalog") go(pathFor("select", system)); else await load();
  });
  const extract = () => { setConfirm(false); return run(async () => { const r = await api.extract(system, false); watch(r.jobId); refreshJobs(); }); };

  if (!overview) return error ? <Notice message={error.message} hint={error.hint} /> : <p className="muted">불러오는 중이에요</p>;

  const format = kindLabel(overview.source[0]?.kind);
  const why = busy ? <span id="analyze-why" className="muted">요청을 보내는 중이에요</span> : null;
  const describe = busy ? "analyze-why" : undefined;
  const showTable = overview.analyze === "prepared" || incomplete;
  // busy 알림은 진행 표시(또는 다른 작업 안내)가 나오면 필요 없다.
  const showError = error && !(error.code === "busy" && (running || other));
  const pct = (j: Job) => (j.progress?.total ?? chunks.length) || 0;
  return (
    <div className="analyze">
      {format ? <p className="format">형식: {format}</p> : null}
      {showError ? <Notice message={error.message} hint={error.hint} /> : null}
      {other ? (
        <p role="status" className="muted">
          다른 작업({jobKindLabel(other.kind)})이 진행 중이에요{other.progress?.message ? ` · ${other.progress.message}` : ""}{other.progress?.done !== undefined && other.progress.total ? ` (${other.progress.done}/${other.progress.total})` : ""}. 끝나면 이어서 할 수 있어요.
        </p>
      ) : null}
      {seen?.state === "failed" ? <Notice message={seen.error?.message ?? "추출에 실패했어요"} hint={seen.error?.hint} /> : null}
      {seen?.state === "cancelled" ? <p className="muted">추출을 취소했어요. 끝낸 청크는 그대로 남아 있어요.</p> : null}

      {overview.analyze === "catalog" && !incomplete ? (
        <>
          <p>분석을 마쳤어요. 기능 {overview.catalogTotal}개</p>
          <div><button type="button" className="btn-primary" onClick={() => go(pathFor("select", system))}>③ 기능 선택으로</button></div>
        </>
      ) : overview.analyze === "none" ? (
        <div className="action-row"><button type="button" className="btn-primary" disabled={busy} aria-describedby={describe} onClick={() => void analyze()}>분석하기</button>{why}</div>
      ) : showTable ? (
        <>
          {incomplete ? <p>분석이 불완전해요. 기능 {overview.catalogTotal}개를 찾았지만 청크 {unfinished}개가 아직 추출되지 않았어요.</p> : null}
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
          ) : incomplete ? (
            <div><button type="button" className="btn-primary" disabled={busy} aria-describedby={describe} onClick={() => setConfirm(true)}>실패한 청크 {retryCount}개만 다시 추출</button></div>
          ) : (
            <div><button type="button" className="btn-primary" disabled={busy} aria-describedby={describe} onClick={() => setConfirm(true)}>추출 시작</button></div>
          )}
          {why}
          {incomplete && !running ? <div><button type="button" className="btn-ghost" onClick={() => go(pathFor("select", system))}>그래도 ③ 기능 선택으로</button></div> : null}
          <ConfirmDialog open={confirm} title="추출을 시작할까요?" confirmLabel="추출 시작" onCancel={() => setConfirm(false)} onConfirm={() => void extract()}>
            청크 {incomplete ? retryCount : chunks.length}개를 <code>claude</code> CLI로 {incomplete ? "다시 " : ""}추출해요. 구독 사용량이 발생해요.
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}
