import { List, ListItem } from "@astryxdesign/core/List";
import { Badge } from "@astryxdesign/core/Badge";
import { useId, useRef } from "react";
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

/**
 * ListItem puts the label and the description inside one button, so the button's name would include every pill.
 * It has no prop for aria-describedby, so the flow name is its own button (`interactiveRef`: the row adds no second tab stop)
 * that names the item and points at the pills as its description.
 */
function FlowItem({ f, selected, onPick }: { f: FlowSummary; selected: boolean; onPick: (id: string) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const pillsId = useId();
  return (
    <ListItem label={<button ref={button} type="button" className="flow-name-button" aria-describedby={pillsId} onClick={() => onPick(f.id)}>{f.name}</button>}
      isSelected={selected} interactiveRef={button} description={<span id={pillsId}><FlowPills f={f} /></span>} />
  );
}

export function FlowList({ flows, current, onPick }: { flows: FlowSummary[]; current: string | null; onPick: (id: string) => void }) {
  return (
    <nav aria-label="흐름" className="panel flow-list">
      <List density="compact">
        {flows.map((f) => <FlowItem key={f.id} f={f} selected={f.id === current} onPick={onPick} />)}
      </List>
    </nav>
  );
}
