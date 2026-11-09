// packages/core/src/record/index.ts
import type { GenerateReport } from "../generate/generator.js";
import { maskHeaders, maskSecrets, redactSecrets } from "../ingest/mask.js";
import type { OnEvent } from "../service/events.js";
import { RecordedSchema, type HttpMethod, type MockSpec } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { featureInputHash } from "../util/specHash.js";
import { mergeHeaders, runContract } from "../verify/contracts.js";
import type { Workspace } from "../workspace.js";
import { DRIFT_FILE, renderDrift, statusHint, type DriftEntry } from "./drift.js";
import { pruneRecorded, recordedName } from "./recorded.js";
import { applyParams, type Target } from "./target.js";

export const MAX_RECORD_BYTES = 1_048_576;
const NORMAL_CONTRACT = "정상 요청";
const SAFE_METHODS = new Set<HttpMethod>(["GET", "HEAD"]);

export interface RecordOptions {
  /** POST·PUT·PATCH·DELETE 등도 보낸다. */
  allowMutating?: boolean;
  /** 이 기능만. 현재 mockspec에 없는 id는 오류. */
  features?: string[];
  /** 실행이 끝난 뒤, 이번 대상 기능(보냈거나 실패한 것) 중 새로 쓰지 않은 옛 녹화를 지운다. 건너뜀 기능·중단 시 유지. */
  refresh?: boolean;
  onEvent?: OnEvent;
  signal?: AbortSignal;
  /** 테스트용 시계. */
  now?: () => Date;
}

/** 설계 §4.1. applied는 서비스가 채운다(설계 대비 결정 D5: generate는 null일 수 있다). */
export interface RecordResult {
  system: string;
  baseUrl: string;
  recorded: string[];
  matched: string[];
  drifted: { featureId: string; errors: string[] }[];
  statusMismatch: { featureId: string; expected: number; actual: number; hint?: string }[];
  skipped: { featureId: string; reason: "mutating" }[];
  failed: { featureId: string; reason: string }[];
  driftPath: string;
  applied: { selected: number; generate: GenerateReport | null } | null;
}

export interface RecordRun { result: RecordResult; driftMarkdown: string }

/** 파싱된 JSON 값의 문자열 값(과 키 아닌 값)에만 마스킹을 적용한다. 숫자·불리언·null은 그대로 둔다. */
function maskValues(v: unknown, mask: (s: string) => string): unknown {
  if (typeof v === "string") return mask(v);
  if (Array.isArray(v)) return v.map((x) => maskValues(x, mask));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValues(x, mask)]));
  return v;
}

/** 바디에 비밀이 섞였을 수 있을 때: raw는 텍스트에, JSON은 문자열 값에만 적용한다(JSON 이스케이프·숫자 보존). */
function maskBody(kind: "json" | "raw" | "empty" | "truncated", body: unknown, mask: (s: string) => string): { kind: "json" | "raw"; body: unknown } | null {
  if (kind === "raw") {
    const b = body as { raw: string; contentType: string };
    return { kind: "raw", body: { raw: mask(b.raw), contentType: b.contentType } };
  }
  if (kind !== "json") return null;
  return { kind: "json", body: maskValues(body, mask) };
}

/** 표시용 경로. query는 이름 기반(token·key 등)으로 값을 가린다. */
function display(p: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(maskHeaders(query)).toString();
  return qs ? `${p}?${qs}` : p;
}

function redactValues(r: Record<string, string>, secrets: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, redactSecrets(v, secrets)]));
}

/** 녹화 파일의 요청 헤더. target에서 온 헤더는 이름과 무관하게 전부 `***`(이름은 남김), contract 헤더는 값을 유지한다. */
function recordedHeaders(contractHeaders: Record<string, string>, target: Target): Record<string, string> {
  const fromTarget = Object.fromEntries(Object.keys(target.headers).map((k) => [k, "***"]));
  return maskHeaders(mergeHeaders(redactValues(contractHeaders, target.secrets), fromTarget));
}

/** 요청·응답에서 온 텍스트 필드만 가린다. featureId·driftPath·baseUrl·system·recorded·matched는 건드리지 않는다. */
function redactResult(r: RecordResult, red: (s: string) => string): RecordResult {
  return {
    ...r,
    drifted: r.drifted.map((d) => ({ ...d, errors: d.errors.map(red) })),
    statusMismatch: r.statusMismatch.map((m) => (m.hint ? { ...m, hint: red(m.hint) } : m)),
    failed: r.failed.map((f) => ({ ...f, reason: red(f.reason) })),
  };
}

/** mockspec의 정상 요청 contract를 target에 순서대로 보내 녹화하고 drift.md를 쓴다. 잠금은 잡지 않는다. */
export async function record(ws: Workspace, system: string, spec: MockSpec, target: Target, opts: RecordOptions = {}): Promise<RecordRun> {
  const known = new Set(spec.features.map((f) => f.id));
  const want = opts.features && opts.features.length > 0 ? new Set(opts.features) : null;
  if (want) {
    const unknown = [...want].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`알 수 없는 기능 id: ${unknown.join(", ")}`);
  }
  const byId = new Map(spec.features.map((f) => [f.id, f]));
  const targets = spec.contracts.filter((c) => c.name === NORMAL_CONTRACT && (!want || want.has(c.featureId)));
  for (const c of targets) recordedName(c.featureId);   // 안전하지 않은 id는 요청 전에 거부

  const red = (t: string) => maskSecrets(redactSecrets(t, target.secrets));
  const now = opts.now ?? (() => new Date());
  const ajv = makeAjv();
  const entries: DriftEntry[] = [];
  const result: RecordResult = {
    system, baseUrl: target.baseUrl, recorded: [], matched: [], drifted: [], statusMismatch: [], skipped: [], failed: [],
    driftPath: ws.file(system, DRIFT_FILE), applied: null,
  };
  let sent = 0;
  for (const [i, c] of targets.entries()) {
    opts.signal?.throwIfAborted();
    const featureId = c.featureId;
    const method = c.request.method;
    const { path: p, query } = applyParams(byId.get(featureId), c, target.params);
    const shown = red(display(p, query));
    opts.onEvent?.({ stage: "record", message: `${featureId} ${method} ${shown}`, done: i + 1, total: targets.length });
    const base = { featureId, method, path: shown };
    if (!opts.allowMutating && !SAFE_METHODS.has(method)) {
      result.skipped.push({ featureId, reason: "mutating" });
      entries.push({ ...base, kind: "skipped" });
      continue;
    }
    const first = sent === 0;
    const r = await runContract(target.baseUrl, c, { headers: target.headers, timeoutMs: target.timeoutMs, signal: opts.signal, ajv, maxBytes: MAX_RECORD_BYTES, path: p, query });
    // 요청 불가(invalid)는 실제로 보내지 않았으므로 첫 전송에 세지 않는다.
    if (r.failure?.kind !== "invalid") sent++;
    if (r.status === null || r.kind === null) {
      const f = r.failure ?? { kind: "network" as const, message: "unknown" };
      if (f.kind === "network" && first) {
        throw new Error(red(`실제 시스템에 연결하지 못했습니다(${f.message}): ${target.baseUrl}. baseUrl을 확인하세요`));
      }
      const reason = red(f.kind === "timeout" ? `시간 초과(${target.timeoutMs}ms)` : f.kind === "invalid" ? `요청 불가: ${f.message}` : `연결 실패: ${f.message}`);
      result.failed.push({ featureId, reason });
      entries.push({ ...base, kind: "failed", reason });
      continue;
    }
    const statusMatch = r.status === c.expect.status;
    // 출처 기반 마스킹은 모든 바디에, 패턴 기반은 비2xx·raw에만(정상 JSON 바디의 오탐 방지).
    const patterned = r.kind === "raw" || !statusMatch;
    const masked = maskBody(r.kind, r.body, (t) => (patterned ? maskSecrets(redactSecrets(t, target.secrets)) : redactSecrets(t, target.secrets)));
    const kind = r.kind;   // 마스킹은 kind를 바꾸지 않는다(JSON은 문자열 값만 치환)
    const body = masked ? masked.body : r.body;
    await ws.write(system, recordedName(featureId), RecordedSchema, {
      featureId,
      recordedAt: now().toISOString(),
      mockspecHash: featureInputHash(spec, featureId),
      request: { method, path: red(p), query: redactValues(maskHeaders(query), target.secrets), headers: recordedHeaders(c.request.headers, target) },
      response: {
        status: r.status, kind, headers: r.headers, bytes: r.bytes,
        ...(kind === "truncated" ? { truncated: true as const } : { body }),
      },
      contract: { expectedStatus: c.expect.status, statusMatch, schemaErrors: r.schemaErrors.map(red) },
    });
    result.recorded.push(featureId);

    if (!statusMatch) {
      const hint = statusHint(r.status);
      result.statusMismatch.push({ featureId, expected: c.expect.status, actual: r.status, ...(hint ? { hint } : {}) });
      entries.push({ ...base, kind: "statusMismatch", expected: c.expect.status, actual: r.status, ...(hint ? { hint } : {}) });
    } else if (r.kind === "truncated" || r.kind === "raw") {
      const reason = red(r.kind === "truncated"
        ? `응답이 1MB를 넘어 저장하지 않았습니다(${r.bytes}바이트)`
        : `바디가 JSON이 아닙니다(content-type: ${r.headers["content-type"] ?? "없음"})`);
      result.failed.push({ featureId, reason });
      entries.push({ ...base, kind: "failed", reason });
    } else if (r.schemaErrors.length > 0) {
      const errors = r.schemaErrors.map(red);
      result.drifted.push({ featureId, errors });
      entries.push({ ...base, kind: "drifted", status: r.status, errors });
    } else {
      result.matched.push(featureId);
      entries.push({ ...base, kind: "matched" });
    }
  }
  if (opts.refresh) {
    const wrote = new Set(result.recorded);
    const skipped = new Set(result.skipped.map((s) => s.featureId));
    await pruneRecorded(ws, system, targets.map((c) => c.featureId).filter((id) => !skipped.has(id) && !wrote.has(id)));
  }
  const driftMarkdown = red(renderDrift(system, target.baseUrl, now(), entries));
  await ws.writeText(system, DRIFT_FILE, driftMarkdown);
  return { result: redactResult(result, red), driftMarkdown };
}

export { DRIFT_FILE } from "./drift.js";
export { readTarget, TARGET_EXAMPLE, TARGET_FILE, type Target } from "./target.js";
export { RECORDED_DIR, readRecorded, isSafeFeatureId } from "./recorded.js";
