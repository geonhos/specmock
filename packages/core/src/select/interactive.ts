import { formatFeatureRow } from "../catalog/format.js";
import { orderFeatures } from "../catalog/order.js";
import type { Catalog } from "../types.js";

export interface ChoiceRow { value: string; name: string; checked: boolean; description?: string }
export interface SeparatorRow { separator: string }
export type InteractiveRow = ChoiceRow | SeparatorRow;

/**
 * inquirer checkbox에 줄 행 목록. 번호·정렬은 list 표(formatCatalog)와 같다.
 * 번호는 항상 전체 카탈로그 기준이고 group은 표시만 거른다.
 */
export function buildChoices(catalog: Catalog, previous: string[] | null, opts: { group?: string } = {}): InteractiveRow[] {
  const ordered = orderFeatures(catalog).filter((o) => opts.group === undefined || o.feature.group === opts.group);
  const idW = Math.max(2, ...ordered.map((o) => o.feature.id.length));
  const pathW = Math.max(4, ...ordered.map((o) => o.feature.path.length));
  const prev = new Set(previous ?? []);
  const rows: InteractiveRow[] = [];
  let group: string | null = null;
  for (const { index, feature: f } of ordered) {
    if (f.group !== group) {
      group = f.group;
      rows.push({ separator: `${group} (${catalog.features.filter((x) => x.group === group).length})` });
    }
    rows.push({
      value: f.id,
      name: formatFeatureRow(index, f, idW, pathW),
      checked: prev.has(f.id),
      description: [f.title, f.summary, f.notes.length ? `주의: ${f.notes.join("; ")}` : ""].filter(Boolean).join(" — "),
    });
  }
  return rows;
}

/**
 * interactive 선택 결과를 저장할 id 목록으로 합친다.
 * 화면에 안 보인 그룹(--group 필터)의 이전 선택은 카탈로그에 아직 있으면 유지하고,
 * 보인 행은 picked만 따른다. 결과는 카탈로그 표시 순서로 정렬해 결정적이다.
 */
export function mergeInteractivePick(input: { catalog: Catalog; previous: string[] | null; shownIds: string[]; picked: string[] }): string[] {
  const shown = new Set(input.shownIds);
  const keep = new Set<string>(input.picked);
  for (const id of input.previous ?? []) if (!shown.has(id)) keep.add(id);
  return orderFeatures(input.catalog).map((o) => o.feature.id).filter((id) => keep.has(id));
}
