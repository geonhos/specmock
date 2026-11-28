import { Badge } from "@astryxdesign/core/Badge";
import type { FlowSource, FlowTargetName, Job } from "@specmock/ui-server/api-types";
import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { FlowChart } from "../components/FlowChart";
import { FlowList } from "../components/FlowList";
import { FlowTopBar } from "../components/FlowTopBar";
import { Leftovers } from "../components/Leftovers";
import { Notice } from "../components/Notice";
import { OUTCOME_LABEL, OUTCOME_STATE } from "../flowModel";
import { initial, reduce, runView, screenView } from "../flowState";

export type TargetChoice = "mock" | "real" | "both";
const TARGETS: Record<TargetChoice, FlowTargetName[]> = { mock: ["mock"], real: ["real"], both: ["mock", "real"] };
const TARGET_LABEL: Record<FlowTargetName, string> = { mock: "mock", real: "실제" };
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));
/** A load failure says what failed and what to do; the server's own message goes in the hint. */
const loadError = (message: string, e: unknown) => {
  const err = asError(e);
  return new ApiError(err.status, err.code, message, `(${err.hint ?? err.message}) 화면을 새로 고치거나 서비스를 다시 선택해 주십시오.`);
};

type Props = { system: string; jobs: Job[]; tick: number; refreshJobs: () => void };

/** Keyed by service so the list, the open flow and the safety state never leak across services. */
export function Flows(p: Props) { return <FlowsOf key={p.system} {...p} />; }

function FlowsOf({ system, jobs, tick, refreshJobs }: Props) {
  // All server-backed state lives in the store, keyed by flow id; see flowState.ts for the one ordering rule.
  const [state, dispatch] = useReducer(reduce, initial);
  const counter = useRef(0);
  const nextSeq = () => ++counter.current; // every request takes its seq when it is sent
  const [target, setTarget] = useState<TargetChoice>("mock");
  const [cleanup, setCleanup] = useState(true);
  const view = screenView(state);
  const { selected } = view;
  const rv = runView(jobs, system, selected);
  // Any change of the last flow job (start, progress end, finish) reloads what the job may have changed.
  const lastJob = jobs.filter((j) => j.system === system && j.kind === "flow").at(-1);
  const jobKey = lastJob ? `${lastJob.id}:${lastJob.state}` : "";

  useEffect(() => {
    const listSeq = nextSeq();
    api.flows(system).then((list) => dispatch({ type: "listLoaded", seq: listSeq, list }), (e) => dispatch({ type: "listFailed", seq: listSeq, error: loadError("흐름 목록을 불러오지 못했습니다.", e) }));
    const safetySeq = nextSeq();
    api.safety(system).then((r) => dispatch({ type: "safetyLoaded", seq: safetySeq, on: r.on }), (e) => {
      const err = asError(e);
      dispatch({ type: "safetyFailed", seq: safetySeq, error: new ApiError(err.status, err.code, "안전장치 상태를 읽지 못했습니다.", `(${err.hint ?? err.message}) 상태를 알 수 없는 동안에는 안전장치를 바꿀 수 없습니다. 화면을 새로 고쳐 주십시오.`) });
    });
  }, [system, tick, jobKey]);
  useEffect(() => {
    if (!selected) return;
    const seq = nextSeq();
    api.flow(system, selected).then((detail) => dispatch({ type: "detailLoaded", seq, flowId: selected, detail }), (e) => dispatch({ type: "detailFailed", seq, flowId: selected, error: loadError("흐름을 불러오지 못했습니다.", e) }));
  }, [system, selected, tick, jobKey]);

  // Each handler takes its seq and the flow id when it sends, so a late response lands in that flow's entry.
  const saveInput = async (stepId: string, slot: string, source: FlowSource) => {
    if (!selected) return;
    const flowId = selected; const seq = nextSeq();
    try { dispatch({ type: "saved", seq, flowId, detail: await api.setFlowInput(system, flowId, stepId, slot, source) }); } catch (e) { dispatch({ type: "actionFailed", seq, flowId, error: asError(e) }); }
  };
  const run = async () => {
    if (!selected) return;
    const flowId = selected; const seq = nextSeq();
    try { await api.runFlow(system, flowId, TARGETS[target], cleanup); refreshJobs(); dispatch({ type: "actionOk", seq, flowId }); } catch (e) { dispatch({ type: "actionFailed", seq, flowId, error: asError(e) }); }
  };
  const cancel = async () => {
    if (!rv.runningId || !selected) return;
    const flowId = selected; const seq = nextSeq();
    try { await api.cancel(rv.runningId); refreshJobs(); dispatch({ type: "actionOk", seq, flowId }); } catch (e) { dispatch({ type: "actionFailed", seq, flowId, error: asError(e) }); }
  };
  const toggleSafety = async () => {
    if (view.safety === null) return;
    const flowId = selected; const seq = nextSeq();
    try { dispatch({ type: "toggled", seq, flowId, on: (await api.setSafety(system, !view.safety)).on }); } catch (e) { dispatch({ type: "toggleFailed", seq, error: asError(e) }); }
  };

  const notices = (list: typeof view.notices) => list.map((e, i) => <Notice key={i} message={e.message} hint={e.hint} />);
  if (view.list && view.flows.length === 0) {
    return (
      <section className="flows-empty">
        {notices(view.loadNotices)}
        <p>고른 기능에서 흐름을 만들지 못했어요.</p>
        <ul>{view.list.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    );
  }
  const shown = view.detail;
  return (
    <div className="flow-layout">
      <FlowList flows={view.flows} current={selected} onPick={(flowId) => dispatch({ type: "pick", flowId })} />
      <section className="flow-main">
        {notices(view.notices)}
        {shown ? (
          <>
            <FlowTopBar name={shown.flow.name} target={target} onTarget={setTarget} cleanup={cleanup} onCleanup={setCleanup}
              safety={view.safety} onSafety={() => void toggleSafety()} running={rv.running} cancellable={rv.cancellable}
              blocked={shown.missingFeatures.length > 0} onRun={() => void run()} onCancel={() => void cancel()} />
            {shown.missingFeatures.length > 0 ? <Notice message={`기능 없음: ${shown.missingFeatures.join(", ")}`} hint="기능 선택이 바뀌었어요. 흐름을 다시 추론하세요." /> : null}
            {rv.failed ? <Notice message={rv.failed.message} hint={rv.failed.hint} /> : null}
            {(["mock", "real"] as const).map((t) => shown.runs[t]?.error ? <Notice key={t} message={`${TARGET_LABEL[t]} 실행: ${shown.runs[t]!.error}`} /> : null)}
            <div className="flow-badges">
              {(["mock", "real"] as const).map((t) => { const r = shown.runs[t]; return r ? (
                <span key={t}><span className="muted">{TARGET_LABEL[t]} 결과 </span><Badge variant="neutral" className={`st st-${OUTCOME_STATE[r.outcome]}`} label={OUTCOME_LABEL[r.outcome]} /></span>
              ) : null; })}
            </div>
            {rv.notRun.length > 0 ? <p className="notrun">{`실행하지 않은 대상: ${rv.notRun.map((t) => TARGET_LABEL[t]).join(", ")}`}</p> : null}
            <FlowChart flow={shown.flow} features={shown.features} runs={shown.runs} empty={shown.empty} onSave={saveInput} />
            <Leftovers runs={shown.runs} />
          </>
        ) : null}
      </section>
    </div>
  );
}
