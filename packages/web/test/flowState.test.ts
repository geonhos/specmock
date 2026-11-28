// @vitest-environment node
import type { FlowDetail, FlowList, Job } from "@specmock/ui-server/api-types";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { type Action, type FlowsState, initial, reduce, runView, screenView, write } from "../src/flowState";

const err = (message: string) => new ApiError(0, "failed", message);
const list = (...ids: string[]) => ({ flows: ids.map((id) => ({ id, name: `name ${id}` })), notes: [] }) as unknown as FlowList;
const detail = (id: string, tag = "") => ({ flow: { id, name: `name ${id}${tag}` }, missingFeatures: [], runs: {} }) as unknown as FlowDetail;
const play = (...actions: Action[]): FlowsState => actions.reduce(reduce, initial);
const msgs = (s: FlowsState) => screenView(s).notices.map((n) => n.message);
const shownName = (s: FlowsState) => (screenView(s).detail?.flow as { name?: string } | undefined)?.name;
const names = (s: FlowsState) => screenView(s).flows.map((f) => (f as { name: string }).name);

describe("write", () => {
  it.each([
    ["a newer seq replaces", { seq: 1, value: "a" }, 2, { seq: 2, value: "b" }],
    ["an older seq after a newer one is dropped", { seq: 3, value: "a" }, 2, { seq: 3, value: "a" }],
    ["an equal seq is dropped", { seq: 2, value: "a" }, 2, { seq: 2, value: "a" }],
  ])("%s", (_n, slot, seq, want) => { expect(write(slot, seq, "b")).toEqual(want); });
});

type Row = [string, Action[], (s: FlowsState) => void];
const rows: Row[] = [
  ["1 listLoaded selects the first flow", [{ type: "listLoaded", seq: 1, list: list("A", "B") }],
    (s) => { expect(screenView(s).selected).toBe("A"); expect(names(s)).toEqual(["name A", "name B"]); }],
  ["2 a list reload keeps the picked flow", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "pick", flowId: "B" }, { type: "listLoaded", seq: 2, list: list("A", "B") }],
    (s) => { expect(screenView(s).selected).toBe("B"); }],
  ["3 an older list response does not replace a newer one", [{ type: "listLoaded", seq: 3, list: list("new") }, { type: "listLoaded", seq: 1, list: list("old") }],
    (s) => { expect(names(s)).toEqual(["name new"]); }],
  ["4 listFailed keeps the data and shows a notice; listLoaded clears it", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "listFailed", seq: 2, error: err("list failed") }],
    (s) => {
      expect(msgs(s)).toEqual(["list failed"]); expect(names(s)).toEqual(["name A"]);
      const after = reduce(s, { type: "listLoaded", seq: 3, list: list("A") });
      expect(msgs(after)).toEqual([]);
    }],
  ["5 safety failed, loaded, failed again", [{ type: "safetyFailed", seq: 1, error: err("safety failed") }],
    (s) => {
      expect(s.safety.value.on).toBeNull(); expect(msgs(s)).toEqual(["safety failed"]);
      const ok = reduce(s, { type: "safetyLoaded", seq: 2, on: true });
      expect(ok.safety.value.on).toBe(true); expect(msgs(ok)).toEqual([]);
      const again = reduce(ok, { type: "safetyFailed", seq: 3, error: err("safety failed") });
      expect(again.safety.value.on).toBeNull(); expect(msgs(again)).toEqual(["safety failed"]);
    }],
  ["6 a late detail for A does not show on B", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "pick", flowId: "B" }, { type: "detailLoaded", seq: 3, flowId: "B", detail: detail("B") }, { type: "detailLoaded", seq: 2, flowId: "A", detail: detail("A") }],
    (s) => { expect(shownName(s)).toBe("name B"); expect((s.flows.A!.detail.value.data!.flow as { name: string }).name).toBe("name A"); }],
  ["7 A's load failure does not show on B before B responds", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "detailFailed", seq: 2, flowId: "A", error: err("A load failed") }, { type: "pick", flowId: "B" }],
    (s) => { expect(msgs(s)).toEqual([]); expect(screenView(s).detail).toBeUndefined(); }],
  ["8 B's load failure shows its own notice and not A's chart", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "detailLoaded", seq: 2, flowId: "A", detail: detail("A") }, { type: "pick", flowId: "B" }, { type: "detailFailed", seq: 3, flowId: "B", error: err("B load failed") }],
    (s) => { expect(msgs(s)).toEqual(["B load failed"]); expect(screenView(s).detail).toBeUndefined(); }],
  ["9 a failed reload keeps A's old detail with the notice", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "detailLoaded", seq: 2, flowId: "A", detail: detail("A") }, { type: "detailFailed", seq: 3, flowId: "A", error: err("reload failed") }],
    (s) => { expect(shownName(s)).toBe("name A"); expect(msgs(s)).toEqual(["reload failed"]); }],
  ["10 an older failure after a newer success is dropped", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "detailLoaded", seq: 3, flowId: "A", detail: detail("A") }, { type: "detailFailed", seq: 1, flowId: "A", error: err("old failure") }],
    (s) => { expect(msgs(s)).toEqual([]); expect(shownName(s)).toBe("name A"); }],
  ["11 a save for A landing after picking B leaves B alone", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "detailLoaded", seq: 2, flowId: "B", detail: detail("B") }, { type: "pick", flowId: "B" }, { type: "saved", seq: 5, flowId: "A", detail: detail("A", " saved") }],
    (s) => { expect(shownName(s)).toBe("name B"); expect((s.flows.A!.detail.value.data!.flow as { name: string }).name).toBe("name A saved"); }],
  ["12 a save failure after leaving A shows when A is picked again", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "pick", flowId: "B" }, { type: "actionFailed", seq: 5, flowId: "A", error: err("save failed") }],
    (s) => { expect(msgs(s)).toEqual([]); expect(msgs(reduce(s, { type: "pick", flowId: "A" }))).toEqual(["save failed"]); }],
  ["13 a run failure on A shows on A only", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "actionFailed", seq: 2, flowId: "A", error: err("run failed") }],
    (s) => {
      expect(msgs(s)).toEqual(["run failed"]);
      const b = reduce(s, { type: "pick", flowId: "B" }); expect(msgs(b)).toEqual([]);
      expect(msgs(reduce(b, { type: "pick", flowId: "A" }))).toEqual(["run failed"]);
    }],
  ["14 a success on B keeps A's error; a success on A clears it", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "actionFailed", seq: 2, flowId: "A", error: err("A failed") }, { type: "actionOk", seq: 3, flowId: "B" }],
    (s) => { expect(msgs(s)).toEqual(["A failed"]); expect(msgs(reduce(s, { type: "actionOk", seq: 4, flowId: "A" }))).toEqual([]); }],
  ["15 a cancel failure on A shows; a cancel success clears it", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "actionFailed", seq: 2, flowId: "A", error: err("cancel failed") }],
    (s) => { expect(msgs(s)).toEqual(["cancel failed"]); expect(msgs(reduce(s, { type: "actionOk", seq: 3, flowId: "A" }))).toEqual([]); }],
  ["16 a toggle failure shows on every flow; any success clears it", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "toggleFailed", seq: 2, error: err("toggle failed") }],
    (s) => {
      expect(msgs(s)).toEqual(["toggle failed"]);
      expect(msgs(reduce(s, { type: "pick", flowId: "B" }))).toEqual(["toggle failed"]);
      expect(msgs(reduce(s, { type: "actionOk", seq: 3, flowId: "A" }))).toEqual([]);
    }],
  ["17 a toggle success clears the sent flow's error and the service error, not another flow's", [{ type: "listLoaded", seq: 1, list: list("A", "B") }, { type: "actionFailed", seq: 2, flowId: "A", error: err("A failed") }, { type: "actionFailed", seq: 3, flowId: "B", error: err("B failed") }, { type: "toggleFailed", seq: 4, error: err("toggle failed") }, { type: "toggled", seq: 5, on: false, flowId: "A" }],
    (s) => {
      expect(msgs(s)).toEqual([]); expect(s.safety.value.on).toBe(false);
      expect(msgs(reduce(s, { type: "pick", flowId: "B" }))).toEqual(["B failed"]);
    }],
  ["18 an older success does not clear a newer service error", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "toggleFailed", seq: 5, error: err("toggle failed") }, { type: "actionOk", seq: 4, flowId: "A" }],
    (s) => { expect(msgs(s)).toEqual(["toggle failed"]); }],
  ["19 a detail reload keeps the action error", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "actionFailed", seq: 2, flowId: "A", error: err("run failed") }, { type: "detailLoaded", seq: 3, flowId: "A", detail: detail("A") }],
    (s) => { expect(msgs(s)).toEqual(["run failed"]); expect(shownName(s)).toBe("name A"); }],
  ["20 saved clears the flow's action error, its load error and the service error", [{ type: "listLoaded", seq: 1, list: list("A") }, { type: "actionFailed", seq: 2, flowId: "A", error: err("save failed") }, { type: "detailFailed", seq: 3, flowId: "A", error: err("load failed") }, { type: "toggleFailed", seq: 4, error: err("toggle failed") }, { type: "saved", seq: 5, flowId: "A", detail: detail("A") }],
    (s) => { expect(msgs(s)).toEqual([]); expect(shownName(s)).toBe("name A"); }],
];
describe("reduce", () => {
  it.each(rows)("%s", (_n, actions, check) => { check(play(...actions)); });
});

const job = (o: Partial<Job> & { id: string }): Job => ({ system: "s", kind: "flow", state: "done", cancellable: true, startedAt: "t", ...o }) as Job;
const failedErr = { code: "failed", message: "job failed", hint: "retry" };
type RunRow = [string, Job[], string, Partial<ReturnType<typeof runView>>];
const runRows: RunRow[] = [
  ["no flow job → nothing", [], "A", { running: false, cancellable: false, failed: undefined, notRun: [] }],
  ["a running job of A: A running and cancellable", [job({ id: "1", state: "running", input: { flowId: "A" } })], "A", { running: true, cancellable: true, runningId: "1" }],
  ["a running job of A: B is running but cannot cancel", [job({ id: "1", state: "running", input: { flowId: "A" } })], "B", { running: true, cancellable: false }],
  ["a done job of A with notRun: A has it, B has none", [job({ id: "1", input: { flowId: "A" }, result: { notRun: ["real"] } })], "A", { running: false, notRun: ["real"] }],
  ["a done job of A with notRun: B has none", [job({ id: "1", input: { flowId: "A" }, result: { notRun: ["real"] } })], "B", { notRun: [] }],
  ["a failed job of A: A has the notice", [job({ id: "1", state: "failed", input: { flowId: "A" }, error: failedErr })], "A", { failed: failedErr }],
  ["a failed job of A: B has none", [job({ id: "1", state: "failed", input: { flowId: "A" }, error: failedErr })], "B", { failed: undefined }],
  ["a job of another system or kind is ignored", [job({ id: "1", system: "other", state: "running", input: { flowId: "A" } }), job({ id: "2", kind: "verify", state: "running", input: { flowId: "A" } })], "A", { running: false, cancellable: false }],
  ["a running job without a flow id: Run is disabled, Cancel shows nowhere", [job({ id: "1", state: "running" })], "A", { running: true, cancellable: false }],
  ["a finished job without a flow id attaches to no flow", [job({ id: "1", state: "failed", error: failedErr }), job({ id: "2", result: { notRun: ["real"] } })], "A", { failed: undefined, notRun: [] }],
  ["a failed job without a flow id shows no notice", [job({ id: "1", state: "failed", error: failedErr })], "A", { failed: undefined, notRun: [] }],
  ["only the last flow job counts", [job({ id: "1", state: "failed", input: { flowId: "A" }, error: failedErr }), job({ id: "2", input: { flowId: "A" } })], "A", { failed: undefined, running: false }],
  ["a running job with cancellable false is not cancellable", [job({ id: "1", state: "running", cancellable: false, input: { flowId: "A" } })], "A", { running: true, cancellable: false }],
  ["no selected flow: running shows, nothing attaches", [job({ id: "1", state: "running", input: { flowId: "A" } })], "", { running: true, cancellable: false }],
];
describe("runView", () => {
  it.each(runRows)("%s", (_n, jobs, flowId, want) => { expect(runView(jobs, "s", flowId || null)).toMatchObject(want); });
});
