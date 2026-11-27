import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { FlowInput, FlowSource, FlowStep } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { BASIS_LABEL } from "../flowModel";

type Kind = "user" | "step";
export const BASIS_VARIANT = { rule: "neutral", claude: "purple", user: "blue" } as const;
/** Text the user typed: the JSON value when it parses, otherwise a string. */
const parseValue = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

export function InputEditor({ stepId, input, before, onSave }: { stepId: string; input: FlowInput; before: FlowStep[]; onSave: (stepId: string, slot: string, source: FlowSource) => Promise<void> }) {
  const src = input.source;
  // A parent resource created by an earlier step starts on the "earlier step" source (C6).
  const [kind, setKind] = useState<Kind>(src.kind === "step" || (src.kind === "empty" && input.createdBy) ? "step" : "user");
  const [value, setValue] = useState(src.kind === "user" || src.kind === "fixed" ? (typeof src.value === "string" ? src.value : JSON.stringify(src.value)) : "");
  const [step, setStep] = useState(src.kind === "step" ? src.step : input.createdBy ?? before[0]?.id ?? "");
  const [field, setField] = useState(src.kind === "step" ? src.field : "");
  const save = () => void onSave(stepId, input.slot, kind === "user" ? { kind: "user", value: parseValue(value) as never } : { kind: "step", step, field });
  const kinds = [{ value: "user", label: "직접 입력" }, ...(before.length > 0 ? [{ value: "step", label: "앞 단계 응답" }] : [])];
  return (
    <div className={`in${src.kind === "empty" ? " empty-slot" : ""}`}>
      <div>
        <div className="sub mono">{input.slot}</div>
        <Badge variant={BASIS_VARIANT[input.basis]} label={BASIS_LABEL[input.basis]} />
      </div>
      <div className="in-fields">
        <Selector label={`${input.slot} 출처`} isLabelHidden options={kinds} value={kind} onChange={(v) => setKind(v as Kind)} />
        {kind === "user" ? (
          <TextInput label={`${input.slot} 값`} isLabelHidden value={value} onChange={setValue} />
        ) : (
          <>
            <Selector label={`${input.slot} 앞 단계`} isLabelHidden options={before.map((b) => b.id)} value={step} onChange={setStep} />
            <TextInput label={`${input.slot} 응답 필드`} isLabelHidden value={field} onChange={setField} placeholder="number, owner.login" />
          </>
        )}
      </div>
      <Button size="sm" variant="secondary" label={`${input.slot} 저장`} onClick={save} />
    </div>
  );
}
