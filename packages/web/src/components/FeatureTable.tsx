import type { FeatureRow } from "@specmock/ui-server/api-types";
import { groupState, splitPathVars, toggleGroup } from "../selection";
import { TriCheckbox } from "./TriCheckbox";

export function PathText({ path, dim }: { path: string; dim: boolean }) {
  return (
    <span className={`ft-path${dim ? " text-3" : ""}`}>
      {splitPathVars(path).map((p, i) => (p.v ? <span key={i} className="var text-3">{p.text}</span> : p.text))}
    </span>
  );
}

export function FeatureTable({ rows, selected, collapsed, openId, onSelect, onToggleCollapse, onOpen }: {
  rows: FeatureRow[]; selected: ReadonlySet<string>; collapsed: ReadonlySet<string>; openId: string | null;
  onSelect: (next: Set<string>) => void; onToggleCollapse: (group: string) => void; onOpen: (id: string) => void;
}) {
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="ft" role="group" aria-label="기능 목록">
      {groups.map((g) => {
        const members = rows.filter((r) => r.group === g);
        const open = !collapsed.has(g);
        const n = members.filter((r) => selected.has(r.id)).length;
        return (
          <div key={g} className="ft-section">
            <div className="ft-g" onClick={() => onToggleCollapse(g)}>
              <TriCheckbox state={groupState(rows, g, selected)} label={`${g} 그룹 전체 선택`} onToggle={() => onSelect(toggleGroup(rows, g, selected))} />
              <button type="button" className="ft-g-name" aria-expanded={open}>
                <span className="ft-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>{g}
              </button>
              <span className="ft-g-count">{n}/{members.length}</span>
            </div>
            {open ? members.map((r) => {
              const on = selected.has(r.id);
              const toggle = () => { const next = new Set(selected); if (on) next.delete(r.id); else next.add(r.id); onSelect(next); };
              return (
                <div key={r.id} className={`ft-row${on ? " sel" : " off"}${openId === r.id ? " open" : ""}`} onClick={() => onOpen(r.id)}>
                  <TriCheckbox state={on ? "all" : "none"} label={`${r.method} ${r.path} 선택`} onToggle={toggle} />
                  <span className="ft-method" style={{ color: `var(--${r.method.toLowerCase()})` }}>{r.method}</span>
                  <button type="button" className="ft-open" aria-current={openId === r.id ? "true" : undefined}><PathText path={r.path} dim={!on} /></button>
                  <span className="ft-id text-3">{r.id}</span>
                  <span className="ft-meta text-3">{r.warnings.length ? `⚠ ${r.warnings.length}` : r.provenance}</span>
                </div>
              );
            }) : null}
          </div>
        );
      })}
    </div>
  );
}
