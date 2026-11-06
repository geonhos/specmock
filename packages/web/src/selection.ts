/** 선택 화면의 순수 로직. 행 모양은 FeatureRow(id·group·method·path)에 summary가 있으면 검색에 쓴다. */
export interface RowLike { id: string; group: string; method: string; path: string; summary?: string }
export type GroupState = "none" | "some" | "all";
export interface RowFilter { q?: string; method?: string | null; group?: string | null }

export function groupState(rows: readonly RowLike[], group: string, selected: ReadonlySet<string>): GroupState {
  const ids = rows.filter((r) => r.group === group).map((r) => r.id);
  const n = ids.filter((id) => selected.has(id)).length;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

/** none/some → all, all → none. rows에는 필터로 보이는 행만 넘긴다. 보이지 않는 행의 선택은 건드리지 않는다. */
export function toggleGroup(rows: readonly RowLike[], group: string, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const ids = rows.filter((r) => r.group === group).map((r) => r.id);
  if (groupState(rows, group, selected) === "all") for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

export function filterRows<T extends RowLike>(rows: readonly T[], f: RowFilter): T[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.group && r.group !== f.group) return false;
    if (f.method && r.method !== f.method) return false;
    if (q && ![r.path, r.id, r.summary ?? ""].some((s) => s.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** "/pets/{petId}" → [{text:"/pets/"}, {text:"{petId}", v:true}] */
export function splitPathVars(path: string): { text: string; v: boolean }[] {
  return path.split(/(\{[^}]*\})/).filter((s) => s !== "").map((text) => ({ text, v: text.startsWith("{") && text.endsWith("}") }));
}

export const sameIds = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((i) => y.has(i));
};
