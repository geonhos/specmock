import type { FeatureListRow } from "@specmock/ui-server/api-types";
import { Fragment, useState } from "react";
import { NONE, type FormRow, type Outcome } from "../recordModel";
import { splitPathVars } from "../selection";
import { PathText } from "./FeatureTable";

export const isSafeMethod = (method: string) => method === "GET" || method === "HEAD";
const pathVars = (path: string) => splitPathVars(path).filter((p) => p.v).map((p) => p.text.slice(1, -1));
const kindClass = (k: Outcome["kind"]) => (k === "matched" ? "st-done" : k === "none" || k === "skipped" ? "st-pending" : "st-failed");

interface Props {
  rows: FeatureListRow[];
  selected: ReadonlySet<string>;
  allowMutating: boolean;
  outcomes: ReadonlyMap<string, Outcome>;
  values: Record<string, FormRow[]>;
  onSelect: (id: string, on: boolean) => void;
  onValue: (id: string, name: string, value: string) => void;
}

/** 기능 표: 선택·기능·요청·필요한 값(경로 변수)·지난 결과. 변경 요청은 "변경 요청 포함"을 켜기 전까지 흐리고 고를 수 없다. */
export function RecordTable({ rows, selected, allowMutating, outcomes, values, onSelect, onValue }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <table className="chunks results record-table" aria-label="녹화할 기능">
      <thead><tr><th scope="col">선택</th><th scope="col">기능</th><th scope="col">요청</th><th scope="col">필요한 값</th><th scope="col" className="st">지난 결과</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const locked = !isSafeMethod(r.method) && !allowMutating;
          const o = outcomes.get(r.id) ?? NONE;
          const vars = pathVars(r.path);
          return (
            <Fragment key={r.id}>
              <tr className={locked ? "dim" : undefined}>
                <td><input type="checkbox" aria-label={`${r.id} 선택`} checked={selected.has(r.id)} disabled={locked} onChange={(e) => onSelect(r.id, e.target.checked)} /></td>
                <td>{r.summary || r.id} <span className="muted mono">{r.id}</span></td>
                <td><span className="ft-method">{r.method}</span> <PathText path={r.path} dim={locked} /></td>
                <td>
                  {vars.length ? vars.map((v) => {
                    const cur = values[r.id]?.find((x) => x.name === v);
                    return <input key={v} className="var-input" aria-label={`${r.id} ${v}`} placeholder={cur?.keep ? "***" : v} value={cur?.keep ? "" : cur?.value ?? ""} onChange={(e) => onValue(r.id, v, e.target.value)} />;
                  }) : <span className="text-3">—</span>}
                </td>
                <td className={`st ${kindClass(o.kind)}`}>
                  {o.label}
                  {o.details.length ? <> <button type="button" className="link" aria-expanded={open.has(r.id)} onClick={() => toggle(r.id)}>{open.has(r.id) ? "이유 닫기" : "이유 보기"}</button></> : null}
                </td>
              </tr>
              {o.details.length && open.has(r.id) ? <tr className="why"><td colSpan={5}><ul>{o.details.map((d, i) => <li key={i}>{d}</li>)}</ul></td></tr> : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
