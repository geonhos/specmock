import type { GroupState } from "../selection";

/** 원형 체크박스. checked는 true/false/"mixed". 클릭이 행으로 번지지 않는다. */
export function TriCheckbox({ state, label, onToggle }: { state: GroupState; label: string; onToggle: () => void }) {
  const cls = state === "all" ? "on" : state === "some" ? "part" : "";
  return (
    <span
      role="checkbox"
      tabIndex={0}
      aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
      aria-label={label}
      className={`cb ${cls}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onToggle(); }
      }}
    />
  );
}
