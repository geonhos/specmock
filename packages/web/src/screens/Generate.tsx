import type { Job, SystemOverview } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Notice } from "../components/Notice";
import { jobKindLabel } from "../format";
import { pathFor } from "../route";
import { useJob } from "../useJob";

/** core GenerateReport. CLI의 generate 출력과 같은 정보를 보인다. */
interface GenerateReport {
  outDir: string; written: string[]; preserved: string[]; orphaned: string[]; launch?: string;
  language?: string; attempts?: number; notes?: string[]; userModified?: string[]; skipped?: boolean;
}

/** 언어 선택지. ""는 body에 language를 싣지 않는다(core가 lock의 언어, 없으면 ts를 쓴다). */
const LANGUAGES: { value: string; label: string }[] = [
  { value: "", label: "기존 언어 유지(없으면 TypeScript)" },
  { value: "ts", label: "TypeScript (Hono)" },
  { value: "java", label: "Java (Maven + Javalin)" },
];
interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

export function Generate({ system, jobs, tick, go, refreshJobs }: Props) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState("");
  // 확인 창은 실패한 작업 하나에 한 번만 연다(취소한 뒤 같은 작업으로 다시 열리지 않게 id를 기억).
  const [ask, setAsk] = useState<{ id: string; kind: "overwrite" | "language"; dir: string; language: string; message: string; from?: string } | null>(null);
  const [declined, setDeclined] = useState(false); // 덮어쓰기를 취소했다: 이전 결과를 남기고 안내한다
  const asked = useRef(new Set<string>());
  const sent = useRef<string>("");
  const sentLang = useRef<string>("");
  const { last, running, seen, watch } = useJob(jobs, system, "generate");

  const load = useCallback(() => {
    api.overview(system).then((o) => { setOverview(o); setOutDir((cur) => cur ?? o.defaultOutDir); }).catch((e: unknown) => setError(asError(e)));
  }, [system]);
  useEffect(() => { load(); }, [load, tick]);

  const failedId = seen?.state === "failed" && seen.error?.code === "overwrite-required" ? seen.id : undefined;
  useEffect(() => {
    if (!failedId || asked.current.has(failedId)) return;
    asked.current.add(failedId);
    setAsk({ id: failedId, kind: "overwrite", dir: seen?.input?.outDir ?? sent.current, language: seen?.input?.language ?? sentLang.current, message: seen?.error?.message ?? "" });
  }, [failedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (dir: string, force: boolean, lang: string) => {
    setBusy(true); setError(null); setDeclined(false); sent.current = dir; sentLang.current = lang;
    try { const r = await api.generate(system, dir, force, lang || undefined); watch(r.jobId); refreshJobs(); } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      // 언어를 바꾸는 요청은 작업이 만들어지기 전에 409로 온다: 확인 창을 연다(확인하면 force로 다시 요청).
      if (err.code === "language-change-required") { setAsk({ id: `lang-${Date.now()}`, kind: "language", dir, language: lang, message: err.message, from: /이 디렉터리는 (\S+)로/.exec(err.message)?.[1] }); refreshJobs(); return; }
      setError(err); refreshJobs();
    } finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    setBusy(true); setError(null);
    try { await api.cancel(id); } catch (e) { setError(asError(e)); refreshJobs(); } finally { setBusy(false); }
  };

  if (!overview || outDir === null) return error ? <Notice message={error.message} hint={error.hint} /> : <p className="muted">불러오는 중이에요</p>;

  const other = jobs.find((j) => j.system === system && j.kind !== "generate" && j.state === "running");
  const prevDone = last?.state === "done" ? last : declined ? [...jobs].reverse().find((j) => j.system === system && j.kind === "generate" && j.state === "done") : undefined;
  const done = prevDone?.result as GenerateReport | undefined;
  const failed = seen?.state === "failed" && !failedId ? seen : undefined;
  const selectLocked = busy || !!running;
  const locked = busy || !!running || !outDir.trim();
  return (
    <div className="analyze">
      {error ? <Notice message={error.message} hint={error.hint} /> : null}
      {failed ? <Notice message={failed.error?.message ?? "생성에 실패했어요"} hint={failed.error?.hint} /> : null}
      {seen?.state === "cancelled" ? <p role="status" className="muted">생성을 취소했어요. 출력 디렉터리는 그대로예요.</p> : null}
      {declined ? <p role="status" className="muted">덮어쓰지 않았어요. 기존 파일은 그대로예요.</p> : null}
      {other ? <p role="status" className="muted">다른 작업({jobKindLabel(other.kind)})이 진행 중이에요. 끝나면 이어서 할 수 있어요.</p> : null}
      <label className="field">출력 디렉터리
        <input value={outDir} onChange={(e) => setOutDir(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">언어
        <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={selectLocked}>
          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </label>
      <div className="action-row">
        <button type="button" className="btn-primary" disabled={locked} onClick={() => void start(outDir.trim(), false, language)}>생성</button>
        {running?.cancellable ? <button type="button" className="btn-ghost" onClick={() => void cancel(running.id)}>취소</button> : null}
        {running ? (
          <span role="status" className="muted">
            생성 중이에요.
            {running.progress?.message ? ` · ${running.progress.message}` : ""}
            {running.progress?.total ? ` · 시도 ${running.progress.done ?? 0}/${running.progress.total}` : ""}
          </span>
        ) : null}
      </div>
      {done ? (
        <section className="result" aria-label="생성 결과">
          {done.skipped
            ? <p><strong>변경 없음: {done.outDir} (mockspec이 마지막 생성과 같아요)</strong></p>
            : <p><strong>생성 완료: {done.outDir} ({done.written.length}개 파일)</strong></p>}
          {done.preserved.length ? <p className="muted">보존된 fixture {done.preserved.length}개 (수정 흔적 있음): {done.preserved.join(", ")}</p> : null}
          {done.orphaned.length ? <p className="muted">고아 fixture {done.orphaned.length}개 (선택 해제됐지만 수정 흔적이 있어 남김): {done.orphaned.join(", ")}</p> : null}
          {done.attempts ? <p className="muted">LLM 시도 {done.attempts}회</p> : null}
          {done.userModified?.length ? <p className="muted">사용자가 고친 파일 중 이번 생성이 바꾼 것 {done.userModified.length}개 (확인하세요): {done.userModified.join(", ")}</p> : null}
          {done.notes?.length ? <ul className="notes">{done.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          <ul className="files mono">{done.written.map((f) => <li key={f}>{f}</li>)}</ul>
          <p className="muted">실행</p>
          <pre className="cmd">{done.launch ?? `cd ${done.outDir} && npm install && npm start`}</pre>
          <div><button type="button" className="btn-primary" onClick={() => go(pathFor("verify", system))}>⑤ 검증으로 →</button></div>
        </section>
      ) : null}
      <ConfirmDialog open={!!ask} title={ask?.kind === "language" ? "언어를 바꿀까요?" : "덮어쓸까요?"} confirmLabel={ask?.kind === "language" ? "언어 바꾸기" : "덮어쓰기"} onCancel={() => { setAsk(null); setDeclined(true); }} onConfirm={() => { const a = ask!; setAsk(null); void start(a.dir, true, a.language); }}>
        <p><code>{ask?.dir}</code></p>
        {ask?.kind === "language"
          ? <p>이 디렉터리는 {ask.from ?? "다른 언어"}로 만들어졌습니다. 기존 소스를 지우고 {ask.language}로 다시 만들까요? fixtures·contracts의 수정은 보존됩니다.</p>
          : <p>{ask?.message}</p>}
      </ConfirmDialog>
    </div>
  );
}
