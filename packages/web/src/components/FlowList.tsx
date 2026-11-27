import { List, ListItem } from "@astryxdesign/core/List";
import type { FlowSummary } from "@specmock/ui-server/api-types";
import { OUTCOME_LABEL, STATE_LABEL } from "../flowModel";

export function FlowList({ flows, current, onPick }: { flows: FlowSummary[]; current: string | null; onPick: (id: string) => void }) {
  return (
    <nav aria-label="흐름" className="panel flow-list">
      <List density="compact">
        {flows.map((f) => (
          <ListItem key={f.id} label={f.name} href={`#${f.id}`} isSelected={f.id === current}
            onClick={(e) => { e.preventDefault(); onPick(f.id); }}
            description={`빈 연결 ${f.empty}${f.missingFeatures.length > 0 ? " · 기능 없음" : ""} · mock ${f.last.mock ? OUTCOME_LABEL[f.last.mock] : STATE_LABEL.pending} · 실제 ${f.last.real ? OUTCOME_LABEL[f.last.real] : STATE_LABEL.pending}`} />
        ))}
      </List>
    </nav>
  );
}
