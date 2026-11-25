import type { EnvStatus, FeatureListRow, Job, RecordLast } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type TargetInfo } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EnvTable, type EnvRow } from "../components/EnvTable";
import { Notice } from "../components/Notice";
import { isSafeMethod, RecordTable } from "../components/RecordTable";
import { TargetForm } from "../components/TargetForm";
import { emptyModel, modelFromInfo, newRow, outcomesFromJob, outcomesFromLast, refNames, timeoutValid, toPutBody, type FormModel, type Outcome, type RecordDone } from "../recordModel";
import { useJob } from "../useJob";

interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
const isSafe = isSafeMethod;
const COUNT_KINDS: [Outcome["kind"], string][] = [["matched", "일치"], ["drifted", "스펙과 다름"], ["mismatch", "상태 불일치"], ["skipped", "건너뜀"], ["failed", "실패"]];

/** 화면 ⑥ 녹화: 실제 서버 설정(A) → 기능 선택·실행(B) → 결과(C). 이름이 Record면 TypeScript의 Record<K,V>를 가려서 RecordScreen이다. */
export function RecordScreen({ system, jobs, refreshJobs, onChanged }: Props) {
  const [info, setInfo] = useState<TargetInfo | null>(null);
  const [model, setModel] = useState<FormModel>(emptyModel());
  const [snap, setSnap] = useState("");
  const [rows, setRows] = useState<FeatureListRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apply, setApply] = useState(true);
  const [allowMutating, setAllowMutating] = useState(false);
  const [confirmMut, setConfirmMut] = useState(false);
  const [lastSaved, setLastSaved] = useState<RecordLast | null>(null);
  const [lastFailed, setLastFailed] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [sessionNames, setSessionNames] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { last, running, seen, watch } = useJob(jobs, system, "record");

  const known = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
  const savedIds = useMemo(() => new Set(Object.keys(info?.target?.features ?? {})), [info]);
  const put = useMemo(() => toPutBody(model, known, savedIds), [model, known, savedIds]);

  useEffect(() => {
    let live = true;
    setInfo(null); setRows(null);
    void Promise.all([api.target(system), api.features(system), api.selection(system), api.recordLast(system).catch(() => "failed" as const)]).then(([t, f, sel, rl]) => {
      if (!live) return;
      const ids = new Set(sel?.resolved ?? []);
      const table = f.rows.filter((r) => ids.has(r.id));
      const m = modelFromInfo(t);
      setInfo(t); setModel(m); setRows(table);
      setSnap(JSON.stringify(toPutBody(m, new Set(table.map((r) => r.id)), new Set(Object.keys(t.target?.features ?? {}))).body));
      setSelected(new Set(table.filter((r) => isSafe(r.method)).map((r) => r.id)));
      setLastSaved(rl === "failed" ? null : rl); setLastFailed(rl === "failed"); setFormOpen(!t.exists);
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
      setInfo(t); setModel(m); setSnap(JSON.stringify(toPutBody(m, known, new Set(Object.keys(t.target?.features ?? {}))).body));
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
      const r = await api.record(system, { features: [...selected], allowMutating, apply });
      watch(r.jobId); refreshJobs();
    } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    }
  }, [system, selected, allowMutating, apply, watch, refreshJobs]);

  const setMutating = (on: boolean) => {
    setAllowMutating(on);
    if (!on) setSelected((s) => new Set([...s].filter((id) => isSafe(rows?.find((r) => r.id === id)?.method ?? "GET"))));
  };
  const setValue = (id: string, name: string, value: string) => setModel((m) => {
    const list = m.features[id] ?? [];
    const next = list.some((r) => r.name === name)
      ? list.map((r) => (r.name === name ? { ...r, value, keep: false, removed: false } : r))
      : [...list, newRow(name, value)];
    return { ...m, features: { ...m.features, [id]: next } };
  });

  const doneJob = last?.state === "done" ? (last.result as RecordDone | undefined) : undefined;
  const outcomes = useMemo(
    () => (doneJob ? outcomesFromJob(doneJob) : lastSaved?.exists ? outcomesFromLast(lastSaved) : new Map<string, Outcome>()),
    [doneJob, lastSaved],
  );
  const counts = COUNT_KINDS.map(([k, label]) => `${label} ${[...outcomes.values()].filter((o) => o.kind === k).length}`).join(" · ");
  const drift = doneJob ? doneJob.driftMarkdown : lastSaved?.driftMarkdown;
  const hasResult = !!doneJob || !!lastSaved?.exists;
  const applied = doneJob?.result.applied;

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
        {put.excluded > 0 ? <p className="muted">선택하지 않은 기능의 값 {put.excluded}개는 파일에 그대로 남습니다</p> : null}
        <div className="action-row"><button type="button" className="btn-primary" disabled={busy || model.baseUrl.trim() === "" || !timeoutValid(model.timeoutSec)} onClick={() => void save()}>저장</button></div>
      </details>
      <section className="record-features" aria-label="기능 표">
        <div className="action-row">
          <h3 className="kv-h">녹화할 기능</h3>
          <label><input type="checkbox" checked={allowMutating} onChange={(e) => (e.target.checked ? setConfirmMut(true) : setMutating(false))} /> 변경 요청 포함</label>
        </div>
        {rows && rows.length === 0 ? <p className="muted">선택한 기능이 없습니다. ③ 기능 선택에서 먼저 골라 주세요.</p> : null}
        {rows && rows.length ? (
          <RecordTable rows={rows} selected={selected} allowMutating={allowMutating} outcomes={outcomes} values={model.features}
            onSelect={(id, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })} onValue={setValue} />
        ) : null}
      </section>
      <ConfirmDialog open={confirmMut} title="변경 요청을 포함할까요?" confirmLabel="변경 요청 포함" onCancel={() => setConfirmMut(false)} onConfirm={() => { setConfirmMut(false); setMutating(true); }}>
        <p>POST·PUT·PATCH·DELETE 요청은 실제 서버의 데이터를 바꿀 수 있습니다.</p>
      </ConfirmDialog>
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
      {lastFailed && !doneJob ? <p className="muted" role="status">지난 결과를 불러오지 못했습니다</p> : null}
      {hasResult ? (
        <section className="result" aria-label="녹화 결과">
          <p className="summary"><strong>{counts}</strong></p>
          {doneJob ? <p className="muted">{applied ? `mock에 반영했습니다(선택한 기능 ${applied.selected}개${applied.generate?.written ? `, 파일 ${applied.generate.written.length}개 다시 생성` : ""})` : "mock에 반영하지 않았습니다"}</p>
            : lastSaved?.recordedAt ? <p className="muted">마지막 녹화 {lastSaved.recordedAt}</p> : null}
          {doneJob?.notes.length ? <ul className="cov-list">{doneJob.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          {drift ? <details><summary>drift.md 원문</summary><pre className="drift">{drift}</pre></details> : null}
        </section>
      ) : null}
    </div>
  );
}
