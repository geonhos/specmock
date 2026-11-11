import type { Job } from "@specmock/ui-server/api-types";
import { useEffect, useState } from "react";
import { ApiError, api, type TargetInfo } from "../api";
import { useJob } from "../useJob";
import { Notice } from "./Notice";

/** core RecordResponsesResult(service/record.ts) 중 화면이 쓰는 부분. */
interface RecordDone {
  result: { baseUrl: string; matched: string[]; drifted: unknown[]; statusMismatch: unknown[]; skipped: unknown[]; failed: unknown[] };
  driftMarkdown: string;
  notes: string[];
}
interface Props { system: string; jobs: Job[]; tick: number; refreshJobs: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

/** ⑤ 화면의 "실제 시스템" 카드. target.json 편집은 하지 않는다(브라우저에 비밀을 받지 않는다). */
export function RecordCard({ system, jobs, tick, refreshJobs }: Props) {
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { last, running, seen, watch } = useJob(jobs, system, "record");

  useEffect(() => {
    api.target(system).then((t) => { setTarget(t); setUnreadable(false); }).catch(() => setUnreadable(true));
  }, [system, tick]);

  const start = async () => {
    setError(null);
    try { const r = await api.record(system, mutating); watch(r.jobId); refreshJobs(); } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    }
  };
  const copy = () => { void navigator.clipboard?.writeText(target!.example).then(() => setCopied(true)); };

  const other = jobs.find((j) => j.system === system && j.kind !== "record" && j.state === "running");
  const done = last?.state === "done" ? (last.result as RecordDone | undefined) : undefined;
  const r = done?.result;
  return (
    <section className="record-card" aria-label="실제 시스템">
      <h3 className="cov-h">실제 시스템</h3>
      {error && !(error.code === "busy" && running) ? <Notice message={error.message} hint={error.hint} /> : null}
      {seen?.state === "failed" ? <Notice message={seen.error?.message ?? "녹화에 실패했어요"} hint={seen.error?.hint} /> : null}
      {seen?.state === "cancelled" ? <p className="muted">녹화를 취소했어요.</p> : null}
      {unreadable ? <p className="muted">실제 시스템 설정을 읽지 못했어요.</p> : !target ? null : !target.exists ? (
        <div>
          <p className="muted"><code>.specmock/{system}/target.json</code>을 만들어 주세요. 비밀 값은 <code>{"${환경변수}"}</code>로만 적어요(파일을 커밋하지 마세요).</p>
          <pre className="record-example">{target.example}</pre>
          <button type="button" className="btn-ghost" onClick={copy}>{copied ? "복사했어요" : "예시 복사"}</button>
        </div>
      ) : target.error ? <Notice message={target.error} /> : running ? (
        <div className="progress-row">
          <span className="muted">{running.progress?.message ?? "녹화를 시작했어요"}</span>
          {running.cancellable ? <button type="button" className="btn-ghost" onClick={() => void api.cancel(running.id).then(refreshJobs, (e: unknown) => setError(asError(e)))}>녹화 취소</button> : null}
        </div>
      ) : (
        <div>
          <p className="muted">대상 <code>{target.baseUrl}</code></p>
          <label><input type="checkbox" checked={mutating} onChange={(e) => setMutating(e.target.checked)} /> 변경 요청 포함 (POST·PUT·PATCH·DELETE — 실제 데이터가 바뀔 수 있어요)</label>
          <div><button type="button" className="btn-primary" disabled={!!other} onClick={() => void start()}>녹화</button></div>
        </div>
      )}
      {r && done ? (
        <>
          <p className="summary"><strong>일치 {r.matched.length} · 스펙과 다름 {r.drifted.length} · 상태 불일치 {r.statusMismatch.length} · 건너뜀 {r.skipped.length} · 실패 {r.failed.length}</strong></p>
          <p className="muted">coverage에 반영하려면 verify를 다시 실행하세요.</p>
          {done.notes.length ? <ul className="cov-list">{done.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          <pre className="drift">{done.driftMarkdown}</pre>
        </>
      ) : null}
    </section>
  );
}
