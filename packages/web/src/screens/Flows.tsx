import { Badge } from "@astryxdesign/core/Badge";
import type { FlowDetail, FlowList as FlowListData, FlowRunOutcome, FlowSource, FlowTargetName, Job, StepState } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { FlowChart } from "../components/FlowChart";
import { FlowList } from "../components/FlowList";
import { FlowTopBar } from "../components/FlowTopBar";
import { Leftovers } from "../components/Leftovers";
import { Notice } from "../components/Notice";
import { OUTCOME_LABEL } from "../flowModel";
import { useJob } from "../useJob";

export type TargetChoice = "mock" | "real" | "both";
const TARGETS: Record<TargetChoice, FlowTargetName[]> = { mock: ["mock"], real: ["real"], both: ["mock", "real"] };
const TARGET_LABEL: Record<FlowTargetName, string> = { mock: "mock", real: "실제" };
/** Outcome badge colour: reuse the step state colours; a cancelled run stays neutral. */
const OUTCOME_STATE: Record<FlowRunOutcome, StepState> = { success: "success", diff: "diff", failed: "failed", stopped: "stopped-empty", cancelled: "pending" };
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
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
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [safety, setSafety] = useState(true);
  const [target, setTarget] = useState<TargetChoice>("mock");
  const [cleanup, setCleanup] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const job = useJob(jobs, system, "flow");
  const seenState = job.seen?.state;

  useEffect(() => {
    api.flows(system).then((l) => { setList(l); setCurrent((c) => c ?? l.flows[0]?.id ?? null); }).catch((e) => setError(asError(e)));
    api.safety(system).then((s) => setSafety(s.on)).catch(() => undefined);
  }, [system, tick, seenState]);
  useEffect(() => {
    if (current) api.flow(system, current).then(setDetail).catch((e) => setError(asError(e)));
  }, [system, current, tick, seenState]);

  const saveInput = useCallback(async (stepId: string, slot: string, source: FlowSource) => {
    if (!current) return;
    try { setDetail(await api.setFlowInput(system, current, stepId, slot, source)); setError(null); } catch (e) { setError(asError(e)); }
  }, [system, current]);
  const run = async () => {
    if (!current) return;
    try { const { jobId } = await api.runFlow(system, current, TARGETS[target], cleanup); job.watch(jobId); refreshJobs(); setError(null); } catch (e) { setError(asError(e)); }
  };
  const cancel = async () => {
    if (!job.running) return;
    try { await api.cancel(job.running.id); refreshJobs(); } catch (e) { setError(asError(e)); }
  };
  const toggleSafety = async () => {
    try { setSafety((await api.setSafety(system, !safety)).on); } catch (e) { setError(asError(e)); }
  };

  if (list && list.flows.length === 0) {
    return (
      <section className="flows-empty">
        <p>고른 기능에서 흐름을 만들지 못했어요.</p>
        <ul>{list.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    );
  }
  const notRun = seenState === "done" ? notRunOf(job.seen?.result) : [];
  return (
    <div className="flow-layout">
      <FlowList flows={list?.flows ?? []} current={current} onPick={setCurrent} />
      <section className="flow-main">
        {detail ? (
          <>
            <FlowTopBar name={detail.flow.name} target={target} onTarget={setTarget} cleanup={cleanup} onCleanup={setCleanup}
              safety={safety} onSafety={() => void toggleSafety()} running={job.running !== undefined} cancellable={job.running?.cancellable === true}
              blocked={detail.missingFeatures.length > 0} onRun={() => void run()} onCancel={() => void cancel()} />
            {detail.missingFeatures.length > 0 ? <Notice message={`기능 없음: ${detail.missingFeatures.join(", ")}`} hint="기능 선택이 바뀌었어요. 흐름을 다시 추론하세요." /> : null}
            {error ? <Notice message={error.message} hint={error.hint} /> : null}
            {seenState === "failed" && job.seen?.error ? <Notice message={job.seen.error.message} hint={job.seen.error.hint} /> : null}
            {(["mock", "real"] as const).map((t) => detail.runs[t]?.error ? <Notice key={t} message={`${TARGET_LABEL[t]} 실행: ${detail.runs[t]!.error}`} /> : null)}
            <div className="flow-badges">
              {(["mock", "real"] as const).map((t) => { const r = detail.runs[t]; return r ? (
                <span key={t}><span className="muted">{TARGET_LABEL[t]} 결과 </span><Badge variant="neutral" className={`st st-${OUTCOME_STATE[r.outcome]}`} label={OUTCOME_LABEL[r.outcome]} /></span>
              ) : null; })}
            </div>
            {notRun.length > 0 ? <p className="notrun">{`실행하지 않은 대상: ${notRun.map((t) => TARGET_LABEL[t]).join(", ")}`}</p> : null}
            <FlowChart flow={detail.flow} runs={detail.runs} empty={detail.empty} onSave={saveInput} />
            <Leftovers runs={detail.runs} />
          </>
        ) : null}
      </section>
    </div>
  );
}
