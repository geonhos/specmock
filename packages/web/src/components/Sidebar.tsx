import type { SystemSummary } from "@specmock/ui-server/api-types";
import { pathFor, type Screen } from "../route";

export function nextScreen(s: SystemSummary): Screen {
  if (!s.steps.analyzed) return "analyze";
  if (!s.steps.selected) return "select";
  if (!s.steps.generated) return "generate";
  return "verify";
}

const DOTS: (keyof SystemSummary["steps"])[] = ["registered", "analyzed", "selected", "generated", "verified"];

export function Sidebar({ systems, current, go }: { systems: SystemSummary[]; current?: string; go: (path: string) => void }) {
  const link = (to: string) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); go(to);
  };
  return (
    <aside className="panel side">
      <div className="panel-head"><h3>시스템</h3></div>
      <nav aria-label="시스템" className="side-nav">
        {systems.map((s) => {
          const to = pathFor(nextScreen(s), s.name);
          return (
            <a key={s.name} href={to} onClick={link(to)} className={`sys${s.name === current ? " on" : ""}`} aria-current={s.name === current ? "page" : undefined}>
              <span className="sys-ic" aria-hidden="true">{s.name.slice(0, 1).toUpperCase()}</span>
              <span className="sys-name">{s.name}</span>
              <span className="dots" aria-hidden="true">{DOTS.map((k) => <i key={k} className={s.steps[k] ? "on" : ""} />)}</span>
            </a>
          );
        })}
        <a href="/new" onClick={link("/new")} className="sys add">+ 스펙 등록</a>
      </nav>
    </aside>
  );
}
