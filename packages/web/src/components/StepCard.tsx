import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { FlowSource, FlowStep } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { flowDiff, resultOf, type Runs } from "../flowModel";
import { InputEditor } from "./InputEditor";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export function StepCard({ step, before, runs, onSave }: { step: FlowStep; before: FlowStep[]; runs: Runs; onSave: (stepId: string, slot: string, source: FlowSource) => Promise<void> }) {
  const [full, setFull] = useState(false);
  const mock = resultOf(runs.mock, step.id), real = resultOf(runs.real, step.id);
  const diff = mock?.response && real?.response ? flowDiff(mock.response.body, real.response.body) : [];
  const sent = (real ?? mock)?.request;
  return (
    <Card role="region" aria-label={`${step.id} 결과`} className="flow-detail">
      {step.inputs.map((x) => <InputEditor key={x.slot} stepId={step.id} input={x} before={before} onSave={onSave} />)}
      {sent ? (
        <div>
          <div className="sub">보낸 요청</div>
          <code className="mono">{sent.method} {sent.url}</code>
          {sent.body !== null ? <CodeBlock code={pretty(sent.body)} language="json" /> : null}
        </div>
      ) : null}
      {mock || real ? (
        <>
          {mock && real ? <p>{diff.length === 0 ? "차이 난 필드 없음" : `차이 난 필드: ${diff.join(", ")}`}</p> : null}
          {[mock, real].map((r) => r?.reason ? <p key={r === mock ? "m" : "r"} className="muted">{r.reason}</p> : null)}
          <div className="action-row"><Button size="sm" variant="secondary" label={full ? "차이만 보기" : "전체 보기"} onClick={() => setFull(!full)} /></div>
          {full ? (
            <div className="two">
              <div><div className="sub">mock 응답 {mock?.response?.status ?? ""}</div>{mock?.response ? <CodeBlock code={pretty(mock.response.body)} language="json" /> : <p className="muted">없음</p>}</div>
              <div><div className="sub">실제 응답 {real?.response?.status ?? ""}</div>{real?.response ? <CodeBlock code={pretty(real.response.body)} language="json" /> : <p className="muted">없음</p>}</div>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
