import type { FlowDetail, FlowList, FlowTargetName, Job } from "@specmock/ui-server/api-types";
import type { ApiError } from "./api";

/** One slot = one value plus the seq of the request that last wrote it. */
export type Slot<T> = { seq: number; value: T };
/** THE ordering rule: a response writes a slot only if its request was issued after the one that last wrote it. */
export const write = <T,>(s: Slot<T>, seq: number, value: T): Slot<T> => (seq > s.seq ? { seq, value } : s);

export type FlowEntry = {
  detail: Slot<{ data?: FlowDetail; loadError?: ApiError }>; // GET flow, save response
  action: Slot<ApiError | undefined>; // run, cancel, save, toggle-success clear
};
export type FlowsState = {
  selected: string | null;
  list: Slot<{ data?: FlowList; loadError?: ApiError }>;
  safety: Slot<{ on: boolean | null; loadError?: ApiError }>; // GET safety, toggle
  serviceError: Slot<ApiError | undefined>; // toggle failure; cleared by any success
  flows: Record<string, FlowEntry>; // keyed by flow id
};

export type Action =
  | { type: "pick"; flowId: string }
  | { type: "listLoaded"; seq: number; list: FlowList }
  | { type: "listFailed"; seq: number; error: ApiError }
  | { type: "safetyLoaded"; seq: number; on: boolean }
  | { type: "safetyFailed"; seq: number; error: ApiError }
  | { type: "detailLoaded"; seq: number; flowId: string; detail: FlowDetail }
  | { type: "detailFailed"; seq: number; flowId: string; error: ApiError }
  | { type: "saved"; seq: number; flowId: string; detail: FlowDetail }
  | { type: "actionOk"; seq: number; flowId: string }
  | { type: "actionFailed"; seq: number; flowId: string; error: ApiError }
  | { type: "toggled"; seq: number; on: boolean; flowId: string | null }
  | { type: "toggleFailed"; seq: number; error: ApiError };

export const initial: FlowsState = {
  selected: null,
  list: { seq: 0, value: {} },
  safety: { seq: 0, value: { on: null } },
  serviceError: { seq: 0, value: undefined },
  flows: {},
};

const blank = (): FlowEntry => ({ detail: { seq: 0, value: {} }, action: { seq: 0, value: undefined } });
const withFlow = (s: FlowsState, id: string, f: (e: FlowEntry) => FlowEntry): FlowsState => ({ ...s, flows: { ...s.flows, [id]: f(s.flows[id] ?? blank()) } });
const clearService = (s: FlowsState, seq: number): FlowsState => ({ ...s, serviceError: write(s.serviceError, seq, undefined) });

export function reduce(s: FlowsState, a: Action): FlowsState {
  switch (a.type) {
    case "pick": return { ...s, selected: a.flowId };
    case "listLoaded": return { ...s, selected: s.selected ?? a.list.flows[0]?.id ?? null, list: write(s.list, a.seq, { data: a.list }) };
    case "listFailed": return { ...s, list: write(s.list, a.seq, { data: s.list.value.data, loadError: a.error }) };
    case "safetyLoaded": return { ...s, safety: write(s.safety, a.seq, { on: a.on }) };
    case "safetyFailed": return { ...s, safety: write(s.safety, a.seq, { on: null, loadError: a.error }) };
    case "detailLoaded": return withFlow(s, a.flowId, (e) => ({ ...e, detail: write(e.detail, a.seq, { data: a.detail }) }));
    case "detailFailed": return withFlow(s, a.flowId, (e) => ({ ...e, detail: write(e.detail, a.seq, { data: e.detail.value.data, loadError: a.error }) }));
    case "saved": return clearService(withFlow(s, a.flowId, (e) => ({ detail: write(e.detail, a.seq, { data: a.detail }), action: write(e.action, a.seq, undefined) })), a.seq);
    case "actionOk": return clearService(withFlow(s, a.flowId, (e) => ({ ...e, action: write(e.action, a.seq, undefined) })), a.seq);
    case "actionFailed": return withFlow(s, a.flowId, (e) => ({ ...e, action: write(e.action, a.seq, a.error) }));
    case "toggled": {
      const next = clearService({ ...s, safety: write(s.safety, a.seq, { on: a.on }) }, a.seq);
      return a.flowId ? withFlow(next, a.flowId, (e) => ({ ...e, action: write(e.action, a.seq, undefined) })) : next;
    }
    case "toggleFailed": return { ...s, serviceError: write(s.serviceError, a.seq, a.error) };
  }
}

export type ScreenView = {
  list: FlowList | undefined;
  flows: FlowList["flows"];
  selected: string | null;
  detail: FlowDetail | undefined;
  safety: boolean | null;
  /** Load failures (list, selected flow's detail, safety). */
  loadNotices: ApiError[];
  /** loadNotices, then the service error and the selected flow's action error. */
  notices: ApiError[];
};

export function screenView(s: FlowsState): ScreenView {
  const entry = s.selected ? s.flows[s.selected] : undefined;
  const loadNotices = [s.list.value.loadError, entry?.detail.value.loadError, s.safety.value.loadError].filter((e): e is ApiError => e !== undefined);
  const notices = [...loadNotices, s.serviceError.value, entry?.action.value].filter((e): e is ApiError => e !== undefined);
  return { list: s.list.value.data, flows: s.list.value.data?.flows ?? [], selected: s.selected, detail: entry?.detail.value.data, safety: s.safety.value.on, loadNotices, notices };
}

export type RunView = {
  /** Any flow of the service is running (Run is disabled for all flows). */
  running: boolean;
  runningId: string | undefined;
  cancellable: boolean;
  failed: NonNullable<Job["error"]> | undefined;
  notRun: FlowTargetName[];
};

const notRunOf = (result: unknown): FlowTargetName[] => {
  const n = (result as { notRun?: unknown } | undefined)?.notRun;
  return Array.isArray(n) ? n.filter((t): t is FlowTargetName => t === "mock" || t === "real") : [];
};

/** The last flow job of the service; its notices and Cancel apply only to the flow it was run for (`input.flowId`). */
export function runView(jobs: Job[], system: string, flowId: string | null): RunView {
  const mine = jobs.filter((j) => j.system === system && j.kind === "flow");
  const last = mine[mine.length - 1];
  const running = last?.state === "running";
  const owns = last !== undefined && flowId !== null && last.input?.flowId === flowId;
  return {
    running,
    runningId: running ? last.id : undefined,
    cancellable: running && owns && last.cancellable,
    failed: owns && last.state === "failed" ? last.error : undefined,
    notRun: owns && last.state === "done" ? notRunOf(last.result) : [],
  };
}
