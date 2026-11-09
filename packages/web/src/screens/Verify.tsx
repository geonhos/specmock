import type { Job, SystemOverview } from "@specmock/ui-server/api-types";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Notice } from "../components/Notice";
import { jobKindLabel } from "../format";
import { pathFor } from "../route";
import { useJob } from "../useJob";
import { parseCoverage, type CoverageData } from "../coverage";

interface ContractResult { featureId: string; name: string; passed: boolean; expectedStatus: number; actualStatus: number | null; errors: string[] }
interface RuntimeCheck { id: string; name: string; passed: boolean; skipped: boolean; request: string | null; errors: string[] }
/** core VerifyMockResult(service/verify.ts). runtime*은 3A에서 더해졌다(없으면 0). */
interface VerifyResult { dir: string; coverageMarkdown: string; result: { total: number; passed: number; failed: number; results: ContractResult[]; runtime?: RuntimeCheck[]; runtimeFailed?: number } }
interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
/** 알아보지 못하는 형식일 때 보이는 원문: MCP coverageSummary와 같은 범위(`## contract test` 앞부분). */
const coverageSummary = (md: string) => md.split("\n## contract test")[0]!.trimEnd();

function Bar({ value, max }: { value: number; max: number }) {
  return <span className="cov-bar" aria-hidden="true"><span style={{ width: `${max ? (value / max) * 100 : 0}%` }} /></span>;
}

/** ⑤ 커버리지: 선택 기능 수, fixture 출처, 신뢰도 분포, 가정(경고)을 카드와 표로 보인다. */
function Coverage({ data }: { data: CoverageData }) {
  const srcMax = Math.max(0, ...data.sources.map((s) => s.count));
  const confMax = Math.max(0, ...data.confidence.map((s) => s.count));
  return (
    <section className="coverage-cards" aria-label="커버리지">
      <div className="cov-top">
        <div className="cov-card"><span className="cov-label">선택 기능</span><strong className="cov-num">{data.selected} / {data.total}</strong></div>
        <div className="cov-card"><span className="cov-label">경고(가정)</span><strong className="cov-num">{data.assumptions.length}</strong></div>
      </div>
      <div className="cov-grid">
        <table className="chunks" aria-label="fixture 출처">
          <thead><tr><th scope="col">fixture 출처 (기본 응답)</th><th scope="col" className="num">개수</th><th scope="col" /></tr></thead>
          <tbody>{data.sources.map((s) => (
            <tr key={s.name}><td title={s.meaning}>{s.name}</td><td className="num">{s.count}</td><td><Bar value={s.count} max={srcMax} /></td></tr>
          ))}</tbody>
        </table>
        <table className="chunks" aria-label="신뢰도 분포">
          <thead><tr><th scope="col">신뢰도</th><th scope="col" className="num">개수</th><th scope="col" /></tr></thead>
          <tbody>{data.confidence.map((s) => (
            <tr key={s.range}><td>{s.range}</td><td className="num">{s.count}</td><td><Bar value={s.count} max={confMax} /></td></tr>
          ))}</tbody>
        </table>
      </div>
      {data.assumptions.length ? (
        <div><h3 className="cov-h">가정</h3><ul className="cov-list">{data.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
      ) : null}
      {data.notMocked.length ? (
        <details><summary>선택하지 않은 기능 {data.notMocked.length}개</summary>
          <ul className="cov-list">{data.notMocked.map((n) => <li key={n.id}><code>{n.id}</code> {n.text}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

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
  const cov = md ? parseCoverage(md) : null;
  const showError = error && !(error.code === "busy" && (running || other));
  const pct = running?.progress?.total ?? 0;
  const notGenerated = !overview.summary.steps.generated;
  return (
    <div className="analyze verify">
      {needsRerun ? <p role="note" className="stale-note">다시 실행 필요 — {stale.select ? "분석이" : stale.generate ? "선택이" : "생성이"} 바뀌었어요.</p> : null}
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
          <p className="summary"><strong>contract 통과 {done.result.passed} · 실패 {done.result.failed} · 런타임 계약 실패 {done.result.runtimeFailed ?? 0}</strong></p>
          <table className="chunks results" aria-label="기능별 결과">
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
      {cov ? <Coverage data={cov} /> : md ? <pre className="coverage">{coverageSummary(md)}</pre> : null}
    </div>
  );
}
