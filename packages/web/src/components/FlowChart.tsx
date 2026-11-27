import { Badge } from "@astryxdesign/core/Badge";
import type { Flow, FlowSource } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { BASIS_LABEL, edgeLabel, resultOf, stepView, type Runs } from "../flowModel";
import { BASIS_VARIANT } from "./InputEditor";
import { StatePill } from "./StatePill";
import { StepCard } from "./StepCard";

const ROLE_LABEL = { prep: "준비", main: "본 단계", cleanup: "정리" } as const;

export function FlowChart({ flow, runs, empty, onSave }: { flow: Flow; runs: Runs; empty: string[]; onSave: (stepId: string, slot: string, source: FlowSource) => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="flow-chart">
      {flow.steps.map((s, i) => {
        const v = stepView(s, runs, empty);
        const result = resultOf(runs.mock, s.id) ?? resultOf(runs.real, s.id);
        const edges = s.inputs.filter((x) => x.source.kind === "step");
        const last = i === flow.steps.length - 1;
        return (
          <li key={s.id} className="flow-item">
            <div className="flow-rail"><span className="flow-n">{i + 1}</span>{last ? null : <i />}</div>
            <div className="flow-node">
              {i > 0 && edges.length > 0 ? (
                <div className="flow-edge">
                  {edges.map((x) => (
                    <span key={x.slot}>
                      {edgeLabel(x, result)}
                      {/* The rule is the default, so only Claude Code and user choices get a badge. */}
                      {x.basis !== "rule" ? <> <Badge className="flow-edge-badge" variant={BASIS_VARIANT[x.basis]} label={BASIS_LABEL[x.basis]} /></> : null}
                    </span>
                  ))}
                </div>
              ) : null}
              <button type="button" className="flow-node-btn" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="flow-path">{s.id}</span>
                <span className="muted">{s.featureId}</span>
                <span className="flow-role">{ROLE_LABEL[s.role]}</span>
                {v.mock === "pending" && !runs.real ? <StatePill state="pending" /> : (
                  <>
                    <span className="muted">mock</span><StatePill state={v.mock} />
                    {runs.real ? <><span className="muted">실제</span><StatePill state={v.real} /></> : null}
                  </>
                )}
                {v.needsInput ? <span className="mono">입력 필요</span> : null}
              </button>
              {open === s.id ? <StepCard step={s} before={flow.steps.slice(0, i)} runs={runs} onSave={onSave} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
