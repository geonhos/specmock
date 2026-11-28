import type { TargetEntry, TargetInfo, TargetPutBody, TargetPutItem } from "@specmock/ui-server/api-types";

/**
 * 화면 ⑥ 설정 폼의 편집용 모델. 서버는 헤더의 직접 적은 값만 `***`로 가려 보낸다(literal). 그 행은 `keep`으로 "파일의 값 그대로"를 뜻하고,
 * 사용자가 값을 새로 입력하면 `keep`이 꺼지며 입력한 값이 파일에 쓰인다. 공통 값·기능별 값은 원문을 그대로 받아 항상 편집할 수 있다.
 */
export interface FormRow { name: string; value: string; /** 서버가 가려 보낸 헤더 값이다(파일에 직접 적힌 값). 공통 값·기능별 값 행은 항상 false. */ literal: boolean; keep: boolean; /** literal 값을 지우기로 했다. */ removed: boolean }
export interface FormModel { baseUrl: string; timeoutSec: string; headers: FormRow[]; params: FormRow[]; features: Record<string, FormRow[]> }

export const DEFAULT_TIMEOUT_SEC = 15;
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ONLY_REFS = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\})+$/;

export const isRef = (v: string): boolean => ONLY_REFS.test(v);
/** `${이름}` 참조가 하나라도 들어 있는지(앞뒤에 다른 글자가 있어도). */
export const hasRef = (v: string): boolean => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v);
export const newRow = (name = "", value = ""): FormRow => ({ name, value, literal: false, keep: false, removed: false });
const fromHeader = (e: TargetEntry): FormRow => ({ name: e.name, value: e.value, literal: e.literal, keep: e.literal, removed: false });
const fromValue = (e: TargetEntry): FormRow => newRow(e.name, e.value);

export function emptyModel(): FormModel {
  return { baseUrl: "", timeoutSec: String(DEFAULT_TIMEOUT_SEC), headers: [], params: [], features: {} };
}

export function modelFromInfo(info: TargetInfo): FormModel {
  const t = info.target;
  if (!t) return emptyModel();
  return {
    baseUrl: t.baseUrl,
    timeoutSec: String(t.timeoutMs / 1000),
    headers: t.headers.map(fromHeader),
    params: t.params.map(fromValue),
    features: Object.fromEntries(Object.entries(t.features).map(([id, es]) => [id, es.map(fromValue)])),
  };
}

const toItems = (rows: FormRow[], dropEmpty: boolean): TargetPutItem[] => rows
  .filter((r) => !r.removed && r.name.trim() !== "" && (r.keep || !dropEmpty || r.value !== ""))
  .map((r) => (r.keep ? { name: r.name.trim(), keep: true as const } : { name: r.name.trim(), value: r.value }));

export const TIMEOUT_HINT = "제한 시간은 0보다 큰 초 단위 숫자입니다";
/** 제한 시간(초)이 비었거나 숫자가 아니거나, ms로 반올림해 1 미만이면 false. 소수(0.5초)는 허용한다. */
export const timeoutValid = (v: string): boolean => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) && n > 0 && Math.round(n * 1000) >= 1; };

/**
 * 선택한 기능(`knownIds`)에 없는 기능 id의 값은 서버가 400으로 막으므로 본문에서 뺀다. 서버는 본문에 없는 id의 기존 값을 파일에 그대로 둔다.
 * `excluded`는 그렇게 파일에 남는 값의 개수다. 파일에 있던 기능(`savedIds`)의 값을 모두 비우면 빈 목록을 보내 파일에서 지운다.
 * 파일에 없던 기능의 빈 목록은 뺀다(보내면 저장하지 않은 변경으로 보인다). `savedIds`를 생략하면 모두 보낸다.
 */
export function toPutBody(m: FormModel, knownIds: ReadonlySet<string>, savedIds?: ReadonlySet<string>): { body: TargetPutBody; excluded: number } {
  const features: TargetPutBody["features"] = {};
  let excluded = 0;
  for (const [id, rows] of Object.entries(m.features)) {
    const items = toItems(rows, true);
    if (!knownIds.has(id)) { excluded += items.length; continue; }
    if (items.length === 0 && savedIds && !savedIds.has(id)) continue;
    features[id] = items;
  }
  const sec = Number(m.timeoutSec);
  return {
    body: {
      baseUrl: m.baseUrl.trim(),
      ...(timeoutValid(m.timeoutSec) ? { timeoutMs: Math.round(sec * 1000) } : {}),
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
