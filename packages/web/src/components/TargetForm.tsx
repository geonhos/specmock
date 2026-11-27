import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { hasRef, newRow, TIMEOUT_HINT, timeoutValid, type FormModel, type FormRow } from "../recordModel";

interface RowsProps { rows: FormRow[]; label: string; addLabel: string; onChange: (rows: FormRow[]) => void }

function RowsEditor({ rows, label, addLabel, onChange }: RowsProps) {
  const set = (i: number, p: Partial<FormRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="kv-block" role="group" aria-label={label}>
      <h4 className="kv-h">{label}</h4>
      {rows.map((r, i) => {
        const n = i + 1;
        const asInput = !r.literal || (!r.keep && !r.removed);
        return (
          <div key={i} className="kv-row">
            <TextInput label={`${label} ${n} 이름`} isLabelHidden value={r.name} isReadOnly={r.literal} onChange={(v) => set(i, { name: v })} />
            {asInput ? (
              <div className="kv-val">
                <TextInput label={`${label} ${n} 값`} isLabelHidden value={r.value} onChange={(v) => set(i, { value: v })} />
                {hasRef(r.value) ? <span className="kv-tag">환경 변수</span> : r.value !== "" ? <span className="muted kv-hint">이 값은 파일에 그대로 남습니다. {"${이름}"} 참조를 권합니다</span> : null}
              </div>
            ) : <span className="mono">{r.removed ? "지움" : "***"}</span>}
            {r.literal ? (
              <span className="kv-choice" role="group" aria-label={`${r.name} 처리`}>
                <Button variant="ghost" size="sm" aria-pressed={r.keep} label={`${r.name} 그대로 유지`} onClick={() => set(i, { keep: true, removed: false })} />
                <Button variant="ghost" size="sm" aria-pressed={r.removed} label={`${r.name} 지우기`} onClick={() => set(i, { keep: false, removed: true })} />
                <Button variant="ghost" size="sm" aria-pressed={asInput} label={`${r.name} 새 값 입력`} onClick={() => set(i, { keep: false, removed: false, value: "" })} />
              </span>
            ) : <Button variant="ghost" size="sm" label={`${label} ${n} 삭제`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />}
          </div>
        );
      })}
      <Button variant="ghost" size="sm" label={addLabel} onClick={() => onChange([...rows, newRow()])} />
    </div>
  );
}

/** 기본 주소·제한 시간·헤더·공통 값. 기능별 값은 기능 표에서 입력한다. */
export function TargetForm({ model, onChange }: { model: FormModel; onChange: (m: FormModel) => void }) {
  return (
    <div className="form target-form">
      <TextInput label="주소" value={model.baseUrl} placeholder="https://api.example.com/v2" onChange={(v) => onChange({ ...model, baseUrl: v })} />
      <TextInput label="제한 시간(초)" inputMode="decimal" value={model.timeoutSec} description={timeoutValid(model.timeoutSec) ? undefined : TIMEOUT_HINT} onChange={(v) => onChange({ ...model, timeoutSec: v })} />
      <RowsEditor rows={model.headers} label="헤더" addLabel="+ 헤더" onChange={(headers) => onChange({ ...model, headers })} />
      <RowsEditor rows={model.params} label="공통 값" addLabel="+ 값" onChange={(params) => onChange({ ...model, params })} />
    </div>
  );
}
