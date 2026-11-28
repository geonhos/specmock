import { Badge } from "@astryxdesign/core/Badge";
import type { FlowDetail, FlowList as FlowListData, FlowRunOutcome, FlowSource, FlowTargetName, Job, StepState } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { FlowChart } from "../components/FlowChart";
import { FlowList } from "../components/FlowList";
import { FlowTopBar } from "../components/FlowTopBar";
import { Leftovers } from "../components/Leftovers";
import { Notice } from "../components/Notice";
import { OUTCOME_LABEL, OUTCOME_STATE } from "../flowModel";
import { useJob } from "../useJob";

export type TargetChoice = "mock" | "real" | "both";
const TARGETS: Record<TargetChoice, FlowTargetName[]> = { mock: ["mock"], real: ["real"], both: ["mock", "real"] };
const TARGET_LABEL: Record<FlowTargetName, string> = { mock: "mock", real: "실제" };
/** Outcome badge colour: reuse the step state colours; a cancelled run stays neutral. */
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
/** A load failure says what failed and what to do; the server's own message goes in the hint. */
const loadError = (message: string, e: unknown) => {
  const err = asError(e);
  return new ApiError(err.status, err.code, message, `(${err.hint ?? err.message}) 화면을 새로 고치거나 서비스를 다시 선택해 주십시오.`);
};
const notRunOf = (result: unknown): FlowTargetName[] => {
  const n = (result as { notRun?: unknown } | undefined)?.notRun;
  return Array.isArray(n) ? n.filter((t): t is FlowTargetName => t === "mock" || t === "real") : [];
};

type Props = { system: string; jobs: Job[]; tick: number; refreshJobs: () => void };

/** Keyed by service so the list, the open flow and the safety state never leak across services. */
export function Flows(p: Props) { return <FlowsOf key={p.system} {...p} />; }

function FlowsOf({ system, jobs, tick, refreshJobs }: Props) {
  const [list, setList] = useState<FlowListData | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  // The selected flow for async callbacks: a closure's `current` is stale and a server echoing the requested id proves nothing.
  const currentRef = useRef<string | null>(null);
  const select = useCallback((id: string) => { currentRef.current = id; setCurrent(id); }, []);
  // job id -> the flow that started it (client memory; `Job` carries no flow id). Lost on reload: then no run notice is shown.
  const jobFlow = useRef(new Map<string, string>());
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [safety, setSafety] = useState<boolean | null>(null); // null: not read yet or the read failed
  const [target, setTarget] = useState<TargetChoice>("mock");
  const [cleanup, setCleanup] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadFailed, setLoadFailed] = useState<{ list?: ApiError; detail?: { flowId: string; error: ApiError }; safety?: ApiError }>({});
  const failLoad = (k: "list" | "safety", e: ApiError | null) => setLoadFailed((f) => ({ ...f, [k]: e ?? undefined }));
  const job = useJob(jobs, system, "flow");
  const seenState = job.seen?.state;

  // Each effect ignores a response that lands after its inputs changed (a newer load or another selected flow).
  useEffect(() => {
    let stale = false;
    api.flows(system).then((l) => { if (stale) return; setList(l); failLoad("list", null); if (currentRef.current === null && l.flows[0]) select(l.flows[0].id); }).catch((e) => { if (!stale) failLoad("list", loadError("흐름 목록을 불러오지 못했습니다.", e)); });
    api.safety(system).then((s) => { if (stale) return; setSafety(s.on); failLoad("safety", null); }).catch((e) => {
      if (stale) return;
      setSafety(null);
      const err = asError(e);
      failLoad("safety", new ApiError(err.status, err.code, "안전장치 상태를 읽지 못했습니다.", `(${err.hint ?? err.message}) 상태를 알 수 없는 동안에는 안전장치를 바꿀 수 없습니다. 화면을 새로 고쳐 주십시오.`));
    });
    return () => { stale = true; };
  }, [system, tick, seenState]);
  useEffect(() => {
    if (!current) return;
    let stale = false;
    api.flow(system, current)
      .then((d) => { if (stale) return; setDetail(d); setLoadFailed((f) => ({ ...f, detail: undefined })); })
      .catch((e) => { if (!stale) setLoadFailed((f) => ({ ...f, detail: { flowId: current, error: loadError("흐름을 불러오지 못했습니다.", e) } })); });
    return () => { stale = true; };
  }, [system, current, tick, seenState]);
  // Only the selected flow's data is shown or acted on; while it is not loaded the chart stays empty.
  const shown = detail && detail.flow.id === current ? detail : null;
  const detailError = loadFailed.detail && loadFailed.detail.flowId === current ? loadFailed.detail.error : undefined;

  const saveInput = useCallback(async (stepId: string, slot: string, source: FlowSource) => {
    const saved = currentRef.current;
    if (!saved) return;
    // The response or the failure of a save belongs to the flow it was sent for; drop it once another flow is selected.
    try { const d = await api.setFlowInput(system, saved, stepId, slot, source); if (currentRef.current === saved) { setDetail(d); setError(null); } } catch (e) { if (currentRef.current === saved) setError(asError(e)); }
  }, [system]);
  const run = async () => {
    if (!current) return;
    try { const { jobId } = await api.runFlow(system, current, TARGETS[target], cleanup); jobFlow.current.set(jobId, current); job.watch(jobId); refreshJobs(); setError(null); } catch (e) { setError(asError(e)); }
  };
  const cancel = async () => {
    if (!job.running) return;
    try { await api.cancel(job.running.id); refreshJobs(); setError(null); } catch (e) { setError(asError(e)); }
  };
  const toggleSafety = async () => {
    if (safety === null) return;
    try { setSafety((await api.setSafety(system, !safety)).on); setError(null); } catch (e) { setError(asError(e)); }
  };

  const loadNotices = ([["list", loadFailed.list], ["detail", detailError], ["safety", loadFailed.safety]] as const).map(([k, e]) => e ? <Notice key={k} message={e.message} hint={e.hint} /> : null);
  if (list && list.flows.length === 0) {
    return (
      <section className="flows-empty">
        {loadNotices}
        <p>고른 기능에서 흐름을 만들지 못했어요.</p>
        <ul>{list.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    );
  }
  // Run notices belong to the flow that was run; a job started before a reload has no known flow, so none is shown.
  const seenHere = job.seen !== undefined && jobFlow.current.get(job.seen.id) === current;
  const notRun = seenState === "done" && seenHere ? notRunOf(job.seen?.result) : [];
  const ranHere = job.running !== undefined && (jobFlow.current.get(job.running.id) ?? current) === current;
  return (
    <div className="flow-layout">
      <FlowList flows={list?.flows ?? []} current={current} onPick={select} />
      <section className="flow-main">
        {loadNotices}
        {error ? <Notice message={error.message} hint={error.hint} /> : null}
        {shown ? (
          <>
            <FlowTopBar name={shown.flow.name} target={target} onTarget={setTarget} cleanup={cleanup} onCleanup={setCleanup}
              safety={safety} onSafety={() => void toggleSafety()} running={job.running !== undefined} cancellable={ranHere && job.running?.cancellable === true}
              blocked={shown.missingFeatures.length > 0} onRun={() => void run()} onCancel={() => void cancel()} />
            {shown.missingFeatures.length > 0 ? <Notice message={`기능 없음: ${shown.missingFeatures.join(", ")}`} hint="기능 선택이 바뀌었어요. 흐름을 다시 추론하세요." /> : null}
            {seenHere && seenState === "failed" && job.seen?.error ? <Notice message={job.seen.error.message} hint={job.seen.error.hint} /> : null}
            {(["mock", "real"] as const).map((t) => shown.runs[t]?.error ? <Notice key={t} message={`${TARGET_LABEL[t]} 실행: ${shown.runs[t]!.error}`} /> : null)}
            <div className="flow-badges">
              {(["mock", "real"] as const).map((t) => { const r = shown.runs[t]; return r ? (
                <span key={t}><span className="muted">{TARGET_LABEL[t]} 결과 </span><Badge variant="neutral" className={`st st-${OUTCOME_STATE[r.outcome]}`} label={OUTCOME_LABEL[r.outcome]} /></span>
              ) : null; })}
            </div>
            {notRun.length > 0 ? <p className="notrun">{`실행하지 않은 대상: ${notRun.map((t) => TARGET_LABEL[t]).join(", ")}`}</p> : null}
            <FlowChart flow={shown.flow} features={shown.features} runs={shown.runs} empty={shown.empty} onSave={saveInput} />
            <Leftovers runs={shown.runs} />
          </>
        ) : null}
      </section>
    </div>
  );
}
