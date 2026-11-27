import { List, ListItem } from "@astryxdesign/core/List";
import type { SystemSummary } from "@specmock/ui-server/api-types";
import { pathFor } from "../route";

export function Sidebar({ systems, current, go }: { systems: SystemSummary[]; current?: string; go: (path: string) => void }) {
  const link = (to: string) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); go(to);
  };
  return (
    <aside className="panel side">
      <div className="panel-head"><h3>서비스</h3></div>
      <nav aria-label="서비스" className="side-nav">
        <List density="compact">
          {systems.map((s) => {
            const to = pathFor("flows", s.name);
            // No href: Astryx ListItem never calls onClick when it renders an anchor, which made every switch a full page load.
            return <ListItem key={s.name} label={s.name} onClick={() => go(to)} isSelected={s.name === current} />;
          })}
        </List>
        {/* Astryx Button renders a <button>, so the register entry is a plain link styled like a ghost button. */}
        <a href="/new" onClick={link("/new")} className="add-link">+ 서비스 등록</a>
      </nav>
    </aside>
  );
}
