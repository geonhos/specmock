import { hasRef, newRow, TIMEOUT_HINT, timeoutValid, type FormModel, type FormRow } from "../recordModel";

interface RowsProps { rows: FormRow[]; label: string; addLabel: string; onChange: (rows: FormRow[]) => void }

function RowsEditor({ rows, label, addLabel, onChange }: RowsProps) {
  const set = (i: number, p: Partial<FormRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="kv-block">
      <h4 className="kv-h">{label}</h4>
      {rows.length ? (
        <table className="chunks kv" aria-label={label}>
          <thead><tr><th>이름</th><th>값</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const n = i + 1;
              const asInput = !r.literal || (!r.keep && !r.removed);
              return (
                <tr key={i}>
                  <td><input aria-label={`${label} ${n} 이름`} value={r.name} readOnly={r.literal} onChange={(e) => set(i, { name: e.target.value })} /></td>
                  <td>
                    {asInput ? (
                      <>
                        <input aria-label={`${label} ${n} 값`} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
                        {hasRef(r.value) ? <span className="kv-tag">환경 변수</span> : r.value !== "" ? <span className="muted kv-hint">이 값은 파일에 그대로 남습니다. {"${이름}"} 참조를 권합니다</span> : null}
                      </>
                    ) : <span className="mono">{r.removed ? "지움" : "***"}</span>}
                    {r.literal ? (
                      <span className="kv-choice" role="group" aria-label={`${r.name} 처리`}>
                        <button type="button" className="btn-ghost" aria-pressed={r.keep} aria-label={`${r.name} 그대로 유지`} onClick={() => set(i, { keep: true, removed: false })}>그대로 유지</button>
                        <button type="button" className="btn-ghost" aria-pressed={r.removed} aria-label={`${r.name} 지우기`} onClick={() => set(i, { keep: false, removed: true })}>지우기</button>
                        <button type="button" className="btn-ghost" aria-pressed={asInput} aria-label={`${r.name} 새 값 입력`} onClick={() => set(i, { keep: false, removed: false, value: "" })}>새 값 입력</button>
                      </span>
                    ) : null}
                  </td>
                  <td>{r.literal ? null : <button type="button" className="btn-ghost" aria-label={`${label} ${n} 삭제`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>삭제</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <button type="button" className="btn-ghost" onClick={() => onChange([...rows, newRow()])}>{addLabel}</button>
    </div>
  );
}

/** 기본 주소·제한 시간·헤더·공통 값. 기능별 값은 기능 표에서 입력한다. */
export function TargetForm({ model, onChange }: { model: FormModel; onChange: (m: FormModel) => void }) {
  return (
    <div className="form target-form">
      <label className="field"><span>주소</span><input value={model.baseUrl} placeholder="https://api.example.com/v2" onChange={(e) => onChange({ ...model, baseUrl: e.target.value })} /></label>
      <label className="field"><span>제한 시간(초)</span><input inputMode="decimal" value={model.timeoutSec} aria-invalid={!timeoutValid(model.timeoutSec)} aria-describedby={timeoutValid(model.timeoutSec) ? undefined : "timeout-hint"} onChange={(e) => onChange({ ...model, timeoutSec: e.target.value })} />
        {timeoutValid(model.timeoutSec) ? null : <span id="timeout-hint" className="muted kv-hint">{TIMEOUT_HINT}</span>}
      </label>
      <RowsEditor rows={model.headers} label="헤더" addLabel="+ 헤더" onChange={(headers) => onChange({ ...model, headers })} />
      <RowsEditor rows={model.params} label="공통 값" addLabel="+ 값" onChange={(params) => onChange({ ...model, params })} />
    </div>
  );
}
