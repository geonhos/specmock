import type { Job, SystemOverview } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Notice } from "../components/Notice";
import { jobKindLabel } from "../format";
import { pathFor } from "../route";
import { useJob } from "../useJob";

/** core GenerateReport. CLI의 "생성 완료: <outDir> (N개 파일)"과 같은 정보를 보인다. */
interface GenerateReport { outDir: string; written: string[]; preserved: string[]; orphaned: string[] }
interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

export function Generate({ system, jobs, tick, go, refreshJobs }: Props) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  // 확인 창은 실패한 작업 하나에 한 번만 연다(취소한 뒤 같은 작업으로 다시 열리지 않게 id를 기억).
  const [ask, setAsk] = useState<{ id: string; dir: string; message: string } | null>(null);
  const asked = useRef(new Set<string>());
  const sent = useRef<string>("");
  const { last, running, seen, watch } = useJob(jobs, system, "generate");

  const load = useCallback(() => {
    api.overview(system).then((o) => { setOverview(o); setOutDir((cur) => cur ?? o.defaultOutDir); }).catch((e: unknown) => setError(asError(e)));
  }, [system]);
  useEffect(() => { load(); }, [load, tick]);

  const failedId = seen?.state === "failed" && seen.error?.code === "overwrite-required" ? seen.id : undefined;
  useEffect(() => {
    if (!failedId || asked.current.has(failedId)) return;
    asked.current.add(failedId);
    setAsk({ id: failedId, dir: sent.current, message: seen?.error?.message ?? "" });
  }, [failedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (dir: string, force: boolean) => {
    setBusy(true); setError(null); sent.current = dir;
    try { const r = await api.generate(system, dir, force); watch(r.jobId); refreshJobs(); } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    } finally { setBusy(false); }
  };

  if (!overview || outDir === null) return error ? <Notice message={error.message} hint={error.hint} /> : <p className="muted">불러오는 중이에요</p>;

  const other = jobs.find((j) => j.system === system && j.kind !== "generate" && j.state === "running");
  const done = last?.state === "done" ? (last.result as GenerateReport | undefined) : undefined;
  const failed = seen?.state === "failed" && !failedId ? seen : undefined;
  const locked = busy || !!running || !outDir.trim();
  return (
    <div className="analyze">
      {error ? <Notice message={error.message} hint={error.hint} /> : null}
      {failed ? <Notice message={failed.error?.message ?? "생성에 실패했어요"} hint={failed.error?.hint} /> : null}
      {other ? <p role="status" className="muted">다른 작업({jobKindLabel(other.kind)})이 진행 중이에요. 끝나면 이어서 할 수 있어요.</p> : null}
      <label className="field">출력 디렉터리
        <input value={outDir} onChange={(e) => setOutDir(e.target.value)} spellCheck={false} />
      </label>
      <div className="action-row">
        <button type="button" className="btn-primary" disabled={locked} onClick={() => void start(outDir.trim(), false)}>생성</button>
        {running ? <span role="status" className="muted">생성 중이에요. 파일을 쓰는 중이라 멈출 수 없어요.</span> : null}
      </div>
      {done ? (
        <section className="result" aria-label="생성 결과">
          <p><strong>생성 완료: {done.outDir} ({done.written.length}개 파일)</strong></p>
          {done.preserved.length ? <p className="muted">보존된 fixture {done.preserved.length}개 (수정 흔적 있음): {done.preserved.join(", ")}</p> : null}
          {done.orphaned.length ? <p className="muted">고아 fixture {done.orphaned.length}개 (선택 해제됐지만 수정 흔적이 있어 남김): {done.orphaned.join(", ")}</p> : null}
          <ul className="files mono">{done.written.map((f) => <li key={f}>{f}</li>)}</ul>
          <p className="muted">실행</p>
          <pre className="cmd">cd {done.outDir} && npm install && npm start</pre>
          <div><button type="button" className="btn-primary" onClick={() => go(pathFor("verify", system))}>⑤ 검증으로 →</button></div>
        </section>
      ) : null}
      <ConfirmDialog open={!!ask} title="덮어쓸까요?" confirmLabel="덮어쓰기" onCancel={() => setAsk(null)} onConfirm={() => { const a = ask!; setAsk(null); void start(a.dir, true); }}>
        <p><code>{ask?.dir}</code></p>
        <p>{ask?.message}</p>
      </ConfirmDialog>
    </div>
  );
}
