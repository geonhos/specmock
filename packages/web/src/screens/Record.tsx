import type { EnvStatus, FeatureListRow, Job } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type TargetInfo } from "../api";
import { EnvTable, type EnvRow } from "../components/EnvTable";
import { Notice } from "../components/Notice";
import { TargetForm } from "../components/TargetForm";
import { emptyModel, modelFromInfo, refNames, toPutBody, type FormModel } from "../recordModel";
import { useJob } from "../useJob";

interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
const isSafe = (method: string) => method === "GET" || method === "HEAD";

/** 화면 ⑥ 녹화: 실제 서버 설정(A) → 기능 선택·실행(B) → 결과(C). 이름이 Record면 TypeScript의 Record<K,V>를 가려서 RecordScreen이다. */
export function RecordScreen({ system, jobs, refreshJobs, onChanged }: Props) {
  const [info, setInfo] = useState<TargetInfo | null>(null);
  const [model, setModel] = useState<FormModel>(emptyModel());
  const [snap, setSnap] = useState("");
  const [rows, setRows] = useState<FeatureListRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apply, setApply] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [sessionNames, setSessionNames] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { running, seen, watch } = useJob(jobs, system, "record");

  const known = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
  const put = useMemo(() => toPutBody(model, known), [model, known]);

  useEffect(() => {
    let live = true;
    setInfo(null); setRows(null);
    void Promise.all([api.target(system), api.features(system), api.selection(system)]).then(([t, f, sel]) => {
      if (!live) return;
      const ids = new Set(sel?.resolved ?? []);
      const table = f.rows.filter((r) => ids.has(r.id));
      const m = modelFromInfo(t);
      setInfo(t); setModel(m); setRows(table);
      setSnap(JSON.stringify(toPutBody(m, new Set(table.map((r) => r.id))).body));
      setSelected(new Set(table.filter((r) => isSafe(r.method)).map((r) => r.id)));
      setFormOpen(!t.exists);
    }).catch((e: unknown) => { if (live) setError(asError(e)); });
    return () => { live = false; };
  }, [system]);

  const exists = !!info?.exists && !info.error;
  const dirty = JSON.stringify(put.body) !== snap;
  const envRows: EnvRow[] = useMemo(() => {
    const server = new Map((info?.env ?? []).map((e) => [e.name, e.status] as const));
    const names = [...new Set([...server.keys(), ...refNames(model, known)])];
    return names.map((name) => ({ name, status: (server.get(name) ?? (sessionNames.has(name) ? "session" : "missing")) as EnvStatus }));
  }, [info, model, known, sessionNames]);
  const missing = envRows.filter((e) => e.status === "missing").length;
  const otherRunning = jobs.some((j) => j.system === system && j.kind !== "record" && j.state === "running");

  const why = !info || !rows ? "불러오는 중이에요"
    : !exists ? "먼저 대상 서버 설정을 저장하세요"
      : dirty ? "설정을 먼저 저장하세요"
        : missing > 0 ? `환경 변수 ${missing}개가 미설정입니다`
          : selected.size === 0 ? "녹화할 기능을 선택하세요"
            : running ? "녹화가 실행 중입니다"
              : otherRunning ? "다른 작업이 실행 중입니다" : null;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const t = await api.putTarget(system, put.body);
      const m = modelFromInfo(t);
      setInfo(t); setModel(m); setSnap(JSON.stringify(toPutBody(m, known).body));
      onChanged();
    } catch (e) { setError(asError(e)); } finally { setBusy(false); }
  };
  const useEnv = async (name: string) => {
    setBusy(true); setError(null);
    try {
      await api.setEnv(system, { [name]: envValues[name] ?? "" });
      setSessionNames((s) => new Set(s).add(name));
      setEnvValues((v) => ({ ...v, [name]: "" }));
      setInfo(await api.target(system));
    } catch (e) { setError(asError(e)); } finally { setBusy(false); }
  };
  const start = useCallback(async () => {
    setError(null);
    try {
      const r = await api.record(system, { features: [...selected], allowMutating: false, apply });
      watch(r.jobId); refreshJobs();
    } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    }
  }, [system, selected, apply, watch, refreshJobs]);

  const total = running?.progress?.total ?? 0;
  const done = running?.progress?.done ?? 0;
  return (
    <div className="analyze record">
      {error && !(error.code === "busy" && running) ? <Notice message={error.message} hint={error.hint} /> : null}
      {info?.error ? <Notice message={info.error} /> : null}
      <details className="target-box" aria-label="대상 서버 설정" open={formOpen} onToggle={(e) => setFormOpen(e.currentTarget.open)}>
        <summary>대상 서버 설정</summary>
        <TargetForm model={model} onChange={setModel} />
        <EnvTable rows={envRows} values={envValues} busy={busy} onValue={(n, v) => setEnvValues((x) => ({ ...x, [n]: v }))} onUse={(n) => void useEnv(n)} />
        {put.excluded > 0 ? <p className="muted">선택하지 않은 기능의 값 {put.excluded}개는 저장에서 제외됩니다</p> : null}
        <div className="action-row"><button type="button" className="btn-primary" disabled={busy || model.baseUrl.trim() === ""} onClick={() => void save()}>저장</button></div>
      </details>
      <div className="ft-cta record-bar">
        <label><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> mock에 반영</label>
        {running ? (
          <div className="progress-row">
            <div className="progress" role="progressbar" aria-label="녹화 진행" aria-valuemin={0} aria-valuenow={done} aria-valuemax={total}>
              <div className="progress-fill" style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%` }} />
            </div>
            <span className="muted">{done}/{total}</span>
            {running.cancellable ? <button type="button" className="btn-ghost" onClick={() => void api.cancel(running.id).then(refreshJobs, (e: unknown) => setError(asError(e)))}>취소</button> : null}
          </div>
        ) : null}
        <button type="button" className="btn-primary" disabled={!!why} aria-describedby={why ? "record-why" : undefined} onClick={() => void start()}>선택한 {selected.size}개 녹화</button>
        {why ? <span id="record-why" className="muted ft-why">{why}</span> : null}
      </div>
      {seen?.state === "failed" ? <Notice message={seen.error?.message ?? "녹화에 실패했습니다"} hint={seen.error?.hint} /> : null}
      {seen?.state === "cancelled" ? <p className="muted">녹화를 취소했습니다.</p> : null}
    </div>
  );
}
