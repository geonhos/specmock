import { maskSecrets, redactSecrets } from "../ingest/mask.js";
import { MAX_RECORD_BYTES, NORMAL_CONTRACT, maskBody, maskValues, recordedHeaders } from "../record/index.js";
import { applyParams } from "../record/target.js";
import type { Contract, Feature, MockSpec } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { joinUrl, runContract } from "../verify/contracts.js";
import type { FlowRun, FlowTargetName, Leftover, StepResult } from "./runTypes.js";
import type { Flow, FlowStep } from "./types.js";

export const FLOW_AUTH_HINT = "토큰과 권한 범위(scope)를 확인하세요.";
export const NOT_CREATED = "이번 실행이 만든 자원이 아니라 삭제하지 않았습니다.";
export const CLEANUP_OFF = "정리를 끈 실행이라 남겨 두었습니다.";
export const NO_DELETE = "삭제 기능이 흐름에 없어 남았습니다.";
export const CANCELLED = "취소되었습니다.";
export const CANCELLED_CREATE = "취소되었습니다. 응답을 받지 못해 서버에 만들어졌는지 알 수 없어 삭제하지 못했습니다.";
export const CANCELLED_NOT_RUN = "취소되어 실행하지 않았습니다.";
export const CANCELLED_LEFT = "취소되어 삭제하지 않았습니다.";
export const SAFETY_SKIP = "안전장치가 켜져 있어 보내지 않았습니다(GET만 보냄).";
const NAME_SLOTS = new Set(["body.name", "body.title"]);
const SAFE = new Set(["GET", "HEAD"]);

export interface FlowTarget {
  name: FlowTargetName;
  baseUrl: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  timeoutMs: number;
  secrets: string[];
}
export interface RunFlowOptions { safety: boolean; cleanup: boolean; signal?: AbortSignal; now?: () => Date }

const pad = (n: number) => String(n).padStart(2, "0");
export function runSuffix(d: Date): string {
  return `-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
function pick(body: unknown, field: string): unknown {
  let v: unknown = body;
  for (const k of field.split(".")) { if (!v || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
}
const lastPathInput = (s: FlowStep) => s.inputs.filter((i) => i.slot.startsWith("path.")).at(-1);

interface Created { stepId: string; resource: string; url: string; id: string | null }

/** 흐름 하나를 대상 하나에 실행한다(설계 §3). 예외를 던지지 않는다(취소도 마찬가지: 정리한 뒤 outcome "cancelled"로 돌려준다). 결과는 마스킹을 마친 값이다. */
export async function runFlow(flow: Flow, spec: MockSpec, target: FlowTarget, opts: RunFlowOptions): Promise<FlowRun> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const suffix = runSuffix(started);
  const mask = (s: string) => maskSecrets(redactSecrets(s, target.secrets));
  const ajv = makeAjv();
  const features = new Map(spec.features.map((f) => [f.id, f]));
  const responses = new Map<string, unknown>();
  const results = new Map<string, StepResult>(flow.steps.map((s) => [s.id, blank(s)]));
  const created: Created[] = [];
  const guarded = target.name === "real" && opts.safety;
  let halt: string | null = null;

  function blank(s: FlowStep): StepResult {
    return { stepId: s.id, featureId: s.featureId, role: s.role, state: "pending", reason: null, missing: [], request: null, response: null, schemaErrors: [], values: {}, durationMs: 0 };
  }
  function contractFor(featureId: string): Contract | undefined {
    const cs = spec.contracts.filter((c) => c.featureId === featureId);
    return cs.find((c) => c.name === NORMAL_CONTRACT) ?? cs[0];
  }

  /** signal: 요청을 끊는 신호. 정리 요청에는 이미 취소된 신호를 넘기지 않는다(시간 제한은 유지). */
  async function exec(step: FlowStep, signal: AbortSignal | undefined): Promise<StepResult> {
    const r = blank(step);
    const feature = features.get(step.featureId);
    const c = contractFor(step.featureId);
    if (!feature || !c) return { ...r, state: "failed", reason: `기능 없음: ${step.featureId}` };
    const values: Record<string, unknown> = {};
    for (const input of step.inputs) {
      const src = input.source;
      if (src.kind === "step") {
        const dep = results.get(src.step);
        if (dep?.state === "skipped-safety") return { ...r, state: "skipped-safety", missing: [], reason: `앞 단계 ${src.step}이(가) 건너뛰어져 값이 없습니다.` };
        const v = responses.has(src.step) ? pick(responses.get(src.step), src.field) : undefined;
        if (v === undefined || v === null) r.missing.push(input.slot); else values[input.slot] = v;
      } else if (src.kind === "empty") {
        const name = input.slot.slice(5);
        // params는 이 흐름이 만들지 않는 경로 변수만 채운다. createdBy가 있으면 앞 단계가 만든 자원을 연결해야 한다(C6).
        if (input.slot.startsWith("path.") && !input.createdBy && Object.hasOwn(target.params, name)) values[input.slot] = target.params[name];
        else r.missing.push(input.slot);
      } else {
        values[input.slot] = step.creates && NAME_SLOTS.has(input.slot) && typeof src.value === "string" ? src.value + suffix : src.value;
      }
    }
    if (guarded && !SAFE.has(feature.method)) return { ...r, state: "skipped-safety", reason: SAFETY_SKIP, missing: [] };
    if (feature.method === "DELETE") {
      const last = lastPathInput(step);
      const ok = last?.source.kind === "step" && created.some((x) => x.stepId === (last.source as { step: string }).step);
      if (!ok) return { ...r, state: "skipped-safety", reason: NOT_CREATED, missing: [] };
    }
    if (r.missing.length > 0) return { ...r, state: "stopped-empty", reason: `입력이 비어 있습니다: ${r.missing.join(", ")}` };

    let p = feature.path;
    for (const [slot, v] of Object.entries(values)) if (slot.startsWith("path.")) p = p.split(`{${slot.slice(5)}}`).join(encodeURIComponent(String(v)));
    const { query } = applyParams(feature, c, target.params);
    const bodyEntries = Object.entries(values).filter(([s]) => s.startsWith("body."));
    const body = feature.request.body === null ? null : Object.fromEntries(bodyEntries.map(([s, v]) => [s.slice(5), v]));
    const t0 = Date.now();
    const run = await runContract(target.baseUrl, c, { headers: target.headers, timeoutMs: target.timeoutMs, signal, ajv, maxBytes: MAX_RECORD_BYTES, path: p, query, body });
    r.durationMs = Date.now() - t0;
    r.values = maskValues(values, mask, target.secrets) as StepResult["values"];
    r.request = {
      method: c.request.method,
      url: mask(run.url || joinUrl(target.baseUrl, p).toString()),
      headers: recordedHeaders(c.request.headers, target),
      body: body === null ? null : (maskValues(body, mask, target.secrets) as StepResult["values"]),
    };
    const shown = run.kind ? maskBody(run.kind, run.body, mask, target.secrets) : null;
    r.response = { status: run.status, kind: shown?.kind ?? run.kind, body: (shown?.body ?? null) as StepResult["values"][string] };
    if (run.failure || run.status === null || run.status < 200 || run.status > 299) {
      const auth = run.status === 401 || run.status === 403 || run.status === 404 ? ` ${FLOW_AUTH_HINT}` : "";
      return { ...r, state: "failed", reason: mask(run.failure ? run.failure.message : `status ${run.status}`) + auth };
    }
    if (run.kind === "json") responses.set(step.id, run.body);
    if (step.creates) {
      const b = (run.kind === "json" ? run.body : null) as Record<string, unknown> | null;
      const id = b && (typeof b.id === "string" || typeof b.number === "number" || typeof b.id === "number") ? String(b.id ?? b.number) : null;
      created.push({ stepId: step.id, resource: step.creates, url: mask(typeof b?.url === "string" ? b.url : run.url), id });
    }
    const errs = run.errors.map(mask);
    return errs.length > 0 ? { ...r, state: "diff", schemaErrors: errs, reason: errs[0]! } : { ...r, state: "success" };
  }

  let cancelled = false;
  for (const step of flow.steps) {
    if (step.role === "cleanup") continue;
    if (cancelled || opts.signal?.aborted) { cancelled = true; results.set(step.id, { ...blank(step), reason: CANCELLED_NOT_RUN }); continue; }
    if (halt) { results.set(step.id, { ...blank(step), reason: halt }); continue; }
    let r: StepResult;
    try { r = await exec(step, opts.signal); } catch (e) {
      r = opts.signal?.aborted
        ? { ...blank(step), state: "failed", reason: step.creates ? CANCELLED_CREATE : CANCELLED }
        : { ...blank(step), state: "failed", reason: mask((e as Error).message) };
    }
    results.set(step.id, r);
    if (opts.signal?.aborted) cancelled = true;
    else if (r.state === "failed" || r.state === "stopped-empty") halt = `앞 단계 ${step.id}에서 멈췄습니다.`;
  }
  if (opts.signal?.aborted) cancelled = true;

  const cleanupSteps = flow.steps.filter((s) => s.role === "cleanup");
  const handled = new Set<string>();
  const reasons = new Map<string, string>(); // 만든 단계 id → 남은 이유
  let interrupted = false;
  const cleaned = new Set<string>();         // 이번 실행에서 지운 자원을 만든 단계 id
  for (const res of [...created].reverse()) {
    if (!opts.cleanup) { reasons.set(res.stepId, CLEANUP_OFF); continue; }
    const del = cleanupSteps.find((s) => { const l = lastPathInput(s); return l?.source.kind === "step" && l.source.step === res.stepId; });
    if (!del) { reasons.set(res.stepId, NO_DELETE); continue; }
    handled.add(del.id);
    // 정리 도중 취소가 오면 이미 보낸 요청만 끝내고 나머지는 남은 자원으로 적는다. 이미 취소된 채 시작한 정리는 끝까지 간다.
    if (!cancelled && opts.signal?.aborted) { interrupted = true; }
    if (interrupted) { results.set(del.id, { ...blank(del), state: "leftover", reason: CANCELLED_LEFT }); reasons.set(res.stepId, CANCELLED_LEFT); continue; }
    let r: StepResult;
    try { r = await exec(del, undefined); } catch (e) { r = { ...blank(del), state: "failed", reason: mask((e as Error).message) }; }
    if (r.state === "success" || r.state === "diff") { results.set(del.id, { ...r, state: "cleaned" }); cleaned.add(res.stepId); }
    else { results.set(del.id, { ...r, state: "leftover" }); reasons.set(res.stepId, r.reason ?? "삭제에 실패했습니다."); }
  }
  if (opts.cleanup) for (const s of cleanupSteps) if (!handled.has(s.id)) results.set(s.id, { ...blank(s), state: "skipped-safety", reason: NOT_CREATED });

  // 상위 자원을 지우면 하위 자원도 지워진다(GitHub: repo 삭제 → issue 삭제). 상위(조상)를 지운 자원은 남은 자원으로 적지 않는다.
  const stepById = new Map(flow.steps.map((s) => [s.id, s]));
  const createdIds = new Set(created.map((c) => c.stepId));
  const parents = (id: string): string[] => (stepById.get(id)?.inputs ?? []).flatMap((i) =>
    i.slot.startsWith("path.") && i.source.kind === "step" && i.source.step !== id && createdIds.has(i.source.step) ? [i.source.step] : []);
  const goneWithParent = (id: string, seen = new Set<string>()): boolean =>
    parents(id).some((p) => !seen.has(p) && (seen.add(p), cleaned.has(p) || goneWithParent(p, seen)));
  const leftovers: Leftover[] = [];
  for (const res of [...created].reverse()) {
    const reason = reasons.get(res.stepId);
    if (reason === undefined || goneWithParent(res.stepId)) continue;
    leftovers.push({ resource: res.resource, stepId: res.stepId, url: res.url, id: res.id, reason });
  }

  const steps = flow.steps.map((s) => results.get(s.id)!);
  const has = (...st: StepResult["state"][]) => steps.some((s) => st.includes(s.state));
  const outcome = cancelled || interrupted ? "cancelled" : has("failed") ? "failed" : has("stopped-empty", "skipped-safety") && steps.some((s) => s.role !== "cleanup" && (s.state === "stopped-empty" || s.state === "skipped-safety")) ? "stopped" : has("diff") ? "diff" : "success";
  return { flowId: flow.id, target: target.name, startedAt: started.toISOString(), finishedAt: now().toISOString(), safety: opts.safety, cleanup: opts.cleanup, suffix, outcome, error: null, steps, leftovers };
}
