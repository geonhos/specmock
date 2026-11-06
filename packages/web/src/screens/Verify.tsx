import type { Job, SystemOverview } from "@specmock/ui-server/api-types";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Notice } from "../components/Notice";
import { jobKindLabel } from "../format";
import { pathFor } from "../route";
import { useJob } from "../useJob";

interface ContractResult { featureId: string; name: string; passed: boolean; expectedStatus: number; actualStatus: number | null; errors: string[] }
/** core VerifyMockResult(service/verify.ts). */
interface VerifyResult { dir: string; coverageMarkdown: string; result: { total: number; passed: number; failed: number; results: ContractResult[] } }
interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
/** MCP coverageSummary와 같은 범위: `## contract test` 앞부분. */
const coverageSummary = (md: string) => md.split("\n## contract test")[0]!.trimEnd();

export function Verify({ system, jobs, tick, go, refreshJobs }: Props) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { last, running, seen, watch } = useJob(jobs, system, "verify");

  const load = useCallback(() => {
    api.overview(system).then(setOverview).catch((e: unknown) => setError(asError(e)));
  }, [system]);
  useEffect(() => { load(); }, [load, tick]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    } finally { setBusy(false); }
  };
  const start = () => { setOpen(new Set()); return run(async () => { const r = await api.verify(system); watch(r.jobId); refreshJobs(); }); };
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!overview) return error ? <Notice message={error.message} hint={error.hint} /> : <p className="muted">불러오는 중이에요</p>;

  const stale = overview.summary.stale;
  const needsRerun = stale.verify || stale.generate || stale.select;
  const other = jobs.find((j) => j.system === system && j.kind !== "verify" && j.state === "running");
  const done = last?.state === "done" ? (last.result as VerifyResult | undefined) : undefined;
  const md = done?.coverageMarkdown ?? overview.coverage;
  const showError = error && !(error.code === "busy" && (running || other));
  const pct = running?.progress?.total ?? 0;
  const notGenerated = !overview.summary.steps.generated;
  return (
    <div className="analyze verify">
      {needsRerun ? <p role="note" className="stale-note">다시 실행 필요 — {stale.select ? "선택이" : stale.generate ? "생성이" : "마지막 검증 뒤 mock이"} 바뀌었어요.</p> : null}
      {showError ? <Notice message={error.message} hint={error.hint} /> : null}
      {seen?.state === "failed" ? <Notice message={seen.error?.message ?? "검증에 실패했어요"} hint={seen.error?.hint} /> : null}
      {seen?.state === "cancelled" ? <p className="muted">검증을 취소했어요.</p> : null}
      {other ? <p role="status" className="muted">다른 작업({jobKindLabel(other.kind)})이 진행 중이에요. 끝나면 이어서 할 수 있어요.</p> : null}
      {notGenerated ? (
        <p className="muted">아직 mock을 만들지 않았어요. <button type="button" className="btn-ghost" onClick={() => go(pathFor("generate", system))}>④ 생성으로</button></p>
      ) : running ? (
        <div className="progress-row">
          {pct ? (
            <div className="progress" role="progressbar" aria-label="검증 진행" aria-valuemin={0} aria-valuenow={running.progress?.done ?? 0} aria-valuemax={pct}>
              <div className="progress-fill" style={{ width: `${Math.min(100, ((running.progress?.done ?? 0) / pct) * 100)}%` }} />
            </div>
          ) : null}
          <span className="muted">{running.progress?.message ?? "검증을 시작했어요"}</span>
          {running.cancellable ? <button type="button" className="btn-ghost" onClick={() => void run(() => api.cancel(running.id))}>취소</button> : null}
        </div>
      ) : (
        <div><button type="button" className="btn-primary" disabled={busy} onClick={() => void start()}>검증 시작</button></div>
      )}
      {done ? (
        <>
          <p className="summary"><strong>통과 {done.result.passed} · 실패 {done.result.failed}</strong></p>
          <table className="chunks results">
            <thead><tr><th scope="col">기능</th><th scope="col" className="num">기대</th><th scope="col" className="num">실제</th><th scope="col" className="st">결과</th></tr></thead>
            <tbody>
              {done.result.results.map((r) => (
                <Fragment key={r.featureId}>
                  <tr>
                    <td>{r.name} <span className="muted mono">{r.featureId}</span></td>
                    <td className="num">{r.expectedStatus}</td>
                    <td className="num">{r.actualStatus ?? "—"}</td>
                    <td className={`st ${r.passed ? "st-done" : "st-failed"}`}>
                      {r.passed ? "통과" : "실패"}
                      {!r.passed ? <> <button type="button" className="link" aria-expanded={open.has(r.featureId)} onClick={() => toggle(r.featureId)}>{open.has(r.featureId) ? "이유 닫기" : "이유 보기"}</button></> : null}
                    </td>
                  </tr>
                  {!r.passed && open.has(r.featureId) ? (
                    <tr className="why"><td colSpan={4}><ul>{r.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></td></tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {md ? <pre className="coverage">{coverageSummary(md)}</pre> : null}
    </div>
  );
}
