import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import type { FeatureListRow } from "@specmock/ui-server/api-types";
import { groupState, splitPathVars, toggleGroup } from "../selection";

export function PathText({ path, dim }: { path: string; dim: boolean }) {
  return (
    <span className={`ft-path${dim ? " text-3" : ""}`}>
      {splitPathVars(path).map((p, i) => (p.v ? <span key={i} className="var text-3">{p.text}</span> : p.text))}
    </span>
  );
}

export function FeatureTable({ rows, totals, selected, collapsed, onSelect, onToggleCollapse, groups: groupList, onGroupSelect }: {
  /** Visible rows. totals is the full row count per group (before any filter). */
  rows: FeatureListRow[]; totals: ReadonlyMap<string, number>; selected: ReadonlySet<string>; collapsed: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void; onToggleCollapse: (group: string) => void;
  /** Group order. When given, groups whose rows are not fetched yet still get a header (large specs: summary first). */
  groups?: readonly string[];
  /** When given, the group checkbox calls this. Registration uses it to fetch the rows before picking. */
  onGroupSelect?: (group: string) => void;
}) {
  const groups = groupList ?? [...new Set(rows.map((r) => r.group))];
  return (
    <div className="ft" role="group" aria-label="기능 목록">
      {groups.map((g) => {
        const members = rows.filter((r) => r.group === g);
        const open = !collapsed.has(g);
        const n = members.filter((r) => selected.has(r.id)).length;
        const total = totals.get(g) ?? members.length;
        const state = groupState(rows, g, selected);
        return (
          <div key={g} className="ft-section">
            <div className="ft-gsel">
              <CheckboxInput label={`${g} 그룹 전체 선택`} isLabelHidden value={state === "all" ? true : state === "some" ? "indeterminate" : false}
                onChange={() => (onGroupSelect ? onGroupSelect(g) : onSelect(toggleGroup(rows, g, selected)))} />
            </div>
            <Collapsible isOpen={open} onOpenChange={() => onToggleCollapse(g)}
              trigger={<span className="ft-g-name">{g} <span className="ft-g-count">{n} / {members.length || total}{members.length > 0 && total !== members.length ? ` (전체 ${total})` : ""}</span></span>}>
              {members.map((r) => {
                const on = selected.has(r.id);
                const toggle = () => { const next = new Set(selected); if (on) next.delete(r.id); else next.add(r.id); onSelect(next); };
                return (
                  <div key={r.id} className={`ft-row${on ? " sel" : " off"}`}>
                    <CheckboxInput label={`${r.method} ${r.path} 선택`} isLabelHidden value={on} onChange={toggle} />
                    <span className="ft-method" style={{ color: `var(--${r.method.toLowerCase()})` }}>{r.method}</span>
                    <PathText path={r.path} dim={!on} />
                    <span className="ft-id text-3">{r.summary || r.id}</span>
                    <span className="ft-meta text-3">{[r.warnings.length ? `⚠ ${r.warnings.length}` : "", r.codes.join(" ")].filter(Boolean).join("  ")}</span>
                  </div>
                );
              })}
            </Collapsible>
          </div>
        );
      })}
    </div>
  );
}
