// packages/core/src/record/index.ts
import type { GenerateReport } from "../generate/generator.js";
import { maskHeaders, maskSecrets } from "../ingest/mask.js";
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
  /** 실행이 끝난 뒤 이번에 쓰지 않은 기존 녹화를 지운다(중단되면 유지). */
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

/** 바디 텍스트에 비밀이 섞였을 수 있을 때: JSON이면 문자열화→마스킹→재파싱, 실패하면 raw로. */
function maskBody(kind: "json" | "raw" | "empty" | "truncated", body: unknown, contentType: string): { kind: "json" | "raw"; body: unknown } | null {
  if (kind === "raw") {
    const b = body as { raw: string; contentType: string };
    return { kind: "raw", body: { raw: maskSecrets(b.raw), contentType: b.contentType } };
  }
  if (kind !== "json") return null;
  const masked = maskSecrets(JSON.stringify(body));
  try { return { kind: "json", body: JSON.parse(masked) }; } catch { return { kind: "raw", body: { raw: masked, contentType } }; }
}

function display(p: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return qs ? `${p}?${qs}` : p;
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
    const shown = maskSecrets(display(p, query));
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
        throw new Error(maskSecrets(`실제 시스템에 연결하지 못했습니다(${f.message}): ${target.baseUrl}. baseUrl을 확인하세요`));
      }
      const reason = maskSecrets(f.kind === "timeout" ? `시간 초과(${target.timeoutMs}ms)` : f.kind === "invalid" ? `요청 불가: ${f.message}` : `연결 실패: ${f.message}`);
      result.failed.push({ featureId, reason });
      entries.push({ ...base, kind: "failed", reason });
      continue;
    }
    const statusMatch = r.status === c.expect.status;
    const masked = r.kind === "raw" || !statusMatch ? maskBody(r.kind, r.body, r.headers["content-type"] ?? "") : null;
    const kind = masked?.kind ?? r.kind;
    const body = masked ? masked.body : r.body;
    await ws.write(system, recordedName(featureId), RecordedSchema, {
      featureId,
      recordedAt: now().toISOString(),
      mockspecHash: featureInputHash(spec, featureId),
      request: { method, path: p, query: maskHeaders(query), headers: maskHeaders(mergeHeaders(c.request.headers, target.headers)) },
      response: {
        status: r.status, kind, headers: r.headers, bytes: r.bytes,
        ...(kind === "truncated" ? { truncated: true as const } : { body }),
      },
      contract: { expectedStatus: c.expect.status, statusMatch, schemaErrors: r.schemaErrors.map(maskSecrets) },
    });
    result.recorded.push(featureId);

    if (!statusMatch) {
      const hint = statusHint(r.status);
      result.statusMismatch.push({ featureId, expected: c.expect.status, actual: r.status, ...(hint ? { hint } : {}) });
      entries.push({ ...base, kind: "statusMismatch", expected: c.expect.status, actual: r.status, ...(hint ? { hint } : {}) });
    } else if (r.kind === "truncated" || r.kind === "raw") {
      const reason = r.kind === "truncated"
        ? `응답이 1MB를 넘어 저장하지 않았습니다(${r.bytes}바이트)`
        : `바디가 JSON이 아닙니다(content-type: ${r.headers["content-type"] ?? "없음"})`;
      result.failed.push({ featureId, reason });
      entries.push({ ...base, kind: "failed", reason });
    } else if (r.schemaErrors.length > 0) {
      const errors = r.schemaErrors.map(maskSecrets);
      result.drifted.push({ featureId, errors });
      entries.push({ ...base, kind: "drifted", status: r.status, errors });
    } else {
      result.matched.push(featureId);
      entries.push({ ...base, kind: "matched" });
    }
  }
  if (opts.refresh) await pruneRecorded(ws, system, new Set(result.recorded));
  const driftMarkdown = renderDrift(system, target.baseUrl, now(), entries);
  await ws.writeText(system, DRIFT_FILE, driftMarkdown);
  return { result, driftMarkdown };
}

export { DRIFT_FILE } from "./drift.js";
export { readTarget, TARGET_EXAMPLE, TARGET_FILE, type Target } from "./target.js";
export { RECORDED_DIR, readRecorded, isSafeFeatureId } from "./recorded.js";
