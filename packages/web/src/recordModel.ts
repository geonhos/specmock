import type { EnvStatus, RecordLast, TargetEntry, TargetInfo, TargetPutBody, TargetPutItem } from "@specmock/ui-server/api-types";

/**
 * 화면 ⑥ 설정 폼의 편집용 모델. 서버가 `***`로 가려 보낸 값(literal)은 `keep`으로 "파일의 값 그대로"를 뜻하고,
 * 사용자가 값을 새로 입력하면 `keep`이 꺼지며 입력한 값이 파일에 쓰인다.
 */
export interface FormRow { name: string; value: string; /** 서버가 가려 보낸 값이다(파일에 직접 적힌 값). */ literal: boolean; keep: boolean; /** literal 값을 지우기로 했다. */ removed: boolean }
export interface FormModel { baseUrl: string; timeoutSec: string; headers: FormRow[]; params: FormRow[]; features: Record<string, FormRow[]> }

export const DEFAULT_TIMEOUT_SEC = 15;
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ONLY_REFS = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\})+$/;

export const isRef = (v: string): boolean => ONLY_REFS.test(v);
/** `${이름}` 참조가 하나라도 들어 있는지(앞뒤에 다른 글자가 있어도). */
export const hasRef = (v: string): boolean => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v);
export const newRow = (name = "", value = ""): FormRow => ({ name, value, literal: false, keep: false, removed: false });
const fromEntry = (e: TargetEntry): FormRow => ({ name: e.name, value: e.value, literal: e.literal, keep: e.literal, removed: false });

export function emptyModel(): FormModel {
  return { baseUrl: "", timeoutSec: String(DEFAULT_TIMEOUT_SEC), headers: [], params: [], features: {} };
}

export function modelFromInfo(info: TargetInfo): FormModel {
  const t = info.target;
  if (!t) return emptyModel();
  return {
    baseUrl: t.baseUrl,
    timeoutSec: String(t.timeoutMs / 1000),
    headers: t.headers.map(fromEntry),
    params: t.params.map(fromEntry),
    features: Object.fromEntries(Object.entries(t.features).map(([id, es]) => [id, es.map(fromEntry)])),
  };
}

const toItems = (rows: FormRow[], dropEmpty: boolean): TargetPutItem[] => rows
  .filter((r) => !r.removed && r.name.trim() !== "" && (r.keep || !dropEmpty || r.value !== ""))
  .map((r) => (r.keep ? { name: r.name.trim(), keep: true as const } : { name: r.name.trim(), value: r.value }));

/** 선택한 기능(`knownIds`)에 없는 기능 id의 값은 서버가 400으로 막으므로 본문에서 뺀다. */
export function toPutBody(m: FormModel, knownIds: ReadonlySet<string>): { body: TargetPutBody; excluded: number } {
  const features: TargetPutBody["features"] = {};
  let excluded = 0;
  for (const [id, rows] of Object.entries(m.features)) {
    const items = toItems(rows, true);
    if (items.length === 0) continue;
    if (!knownIds.has(id)) { excluded += items.length; continue; }
    features[id] = items;
  }
  const sec = Number(m.timeoutSec);
  return {
    body: {
      baseUrl: m.baseUrl.trim(),
      ...(Number.isFinite(sec) && sec > 0 ? { timeoutMs: Math.round(sec * 1000) } : {}),
      headers: toItems(m.headers, false),
      params: toItems(m.params, false),
      features,
    },
    excluded,
  };
}

/** 폼에 입력된 값(저장 전 포함)에서 `${이름}` 참조를 모두 뽑는다. */
export function refNames(m: FormModel, knownIds: ReadonlySet<string>): string[] {
  const rows = [...m.headers, ...m.params, ...Object.entries(m.features).filter(([id]) => knownIds.has(id)).flatMap(([, r]) => r)];
  const names = new Set<string>();
  for (const r of rows) {
    if (r.removed || r.keep) continue;
    for (const x of r.value.matchAll(REF)) names.add(x[1]!);
  }
  return [...names];
}

export const ENV_STATUS_LABEL: Record<EnvStatus, string> = { process: "설정됨(서버)", session: "설정됨(화면 입력)", missing: "미설정" };

export type OutcomeKind = "matched" | "drifted" | "mismatch" | "skipped" | "failed" | "none";
export interface Outcome { kind: OutcomeKind; label: string; /** 펼치면 보이는 이유. */ details: string[] }
export const NONE: Outcome = { kind: "none", label: "미녹화", details: [] };

/** core RecordResponsesResult 중 화면이 쓰는 부분(service/record.ts). */
export interface RecordDone {
  result: {
    baseUrl: string; matched: string[];
    drifted: { featureId: string; errors: string[] }[];
    statusMismatch: { featureId: string; expected: number; actual: number; hint?: string }[];
    skipped: { featureId: string }[];
    failed: { featureId: string; reason: string }[];
    applied: { selected: number; generate: { written?: string[] } | null } | null;
  };
  driftMarkdown: string;
  notes: string[];
}

/** 이번 job 결과 → 기능별 결과. */
export function outcomesFromJob(d: RecordDone): Map<string, Outcome> {
  const m = new Map<string, Outcome>();
  for (const id of d.result.matched) m.set(id, { kind: "matched", label: "일치", details: [] });
  for (const e of d.result.drifted) m.set(e.featureId, { kind: "drifted", label: "스펙과 다름", details: e.errors });
  for (const e of d.result.statusMismatch) m.set(e.featureId, { kind: "mismatch", label: `상태 불일치(기대 ${e.expected}, 실제 ${e.actual})`, details: e.hint ? [e.hint] : [] });
  for (const e of d.result.skipped) m.set(e.featureId, { kind: "skipped", label: "건너뜀(변경 요청)", details: [] });
  for (const e of d.result.failed) m.set(e.featureId, { kind: "failed", label: "실패", details: [e.reason] });
  return m;
}

/** 저장된 drift.md와 recorded 목록 → 기능별 결과. drift.md 항목은 `- <id> <METHOD> <path> …` 줄이다. 어느 구역에도 없는 녹화는 일치로 본다. */
export function outcomesFromLast(last: RecordLast): Map<string, Outcome> {
  const m = new Map<string, Outcome>();
  for (const r of last.recorded) m.set(r.featureId, { kind: "matched", label: "일치", details: [] });
  let section = "";
  for (const line of (last.driftMarkdown ?? "").split("\n")) {
    if (line.startsWith("## ")) { section = line.slice(3).trim(); continue; }
    const x = /^- (\S+) [A-Z]+ \S+ ?(.*)$/.exec(line);
    if (!x) continue;
    const [, id, rest = ""] = x;
    if (section === "스펙과 다름") m.set(id!, { kind: "drifted", label: "스펙과 다름", details: rest.replace(/^→ \d+\.\s*/, "").split("; ").filter(Boolean) });
    else if (section === "상태 불일치") {
      const s = /기대 (\d+), 실제 (\d+)\.\s*(.*)$/.exec(rest);
      m.set(id!, { kind: "mismatch", label: s ? `상태 불일치(기대 ${s[1]}, 실제 ${s[2]})` : "상태 불일치", details: s?.[3] ? [s[3]] : [] });
    } else if (section === "건너뜀") m.set(id!, { kind: "skipped", label: "건너뜀(변경 요청)", details: [] });
    else if (section === "실패") m.set(id!, { kind: "failed", label: "실패", details: [rest.replace(/^— /, "")] });
  }
  return m;
}
