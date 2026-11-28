import { List, ListItem } from "@astryxdesign/core/List";
import { Badge } from "@astryxdesign/core/Badge";
import type { FlowSummary, FlowTargetName, StepState } from "@specmock/ui-server/api-types";
import { OUTCOME_LABEL, OUTCOME_STATE, STATE_LABEL, STATE_SYMBOL } from "../flowModel";

const TARGETS: { name: FlowTargetName; label: string }[] = [{ name: "mock", label: "mock" }, { name: "real", label: "실제" }];

function Pill({ state, label }: { state: StepState; label: string }) {
  return <Badge variant="neutral" className={`st st-${state}`} icon={STATE_SYMBOL[state]} label={label} />;
}

/** Pills under a flow name: empty-connection count, missing features, and the last run per target. */
function FlowPills({ f }: { f: FlowSummary }) {
  const ran = TARGETS.some((t) => f.last[t.name]);
  return (
    <span className="flow-pills">
      {f.empty > 0 ? <Pill state="stopped-empty" label={`빈 연결 ${f.empty}`} /> : null}
      {f.missingFeatures.length > 0 ? <Pill state="failed" label="기능 없음" /> : null}
      {ran
        ? TARGETS.map((t) => {
            const o = f.last[t.name];
            return o ? <Pill key={t.name} state={OUTCOME_STATE[o]} label={`${t.label} ${OUTCOME_LABEL[o]}`} />
                     : <Pill key={t.name} state="pending" label={`${t.label} ${STATE_LABEL.pending}`} />;
          })
        : <Pill state="pending" label={STATE_LABEL.pending} />}
    </span>
  );
}

export function FlowList({ flows, current, onPick }: { flows: FlowSummary[]; current: string | null; onPick: (id: string) => void }) {
  return (
    <nav aria-label="흐름" className="panel flow-list">
      <List density="compact">
        {flows.map((f) => (
          <ListItem key={f.id} label={f.name} isSelected={f.id === current}
            onClick={() => onPick(f.id)} description={<FlowPills f={f} />} />
        ))}
      </List>
    </nav>
  );
}
