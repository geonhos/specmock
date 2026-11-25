import type { EnvStatus } from "@specmock/ui-server/api-types";
import { ENV_STATUS_LABEL } from "../recordModel";

export interface EnvRow { name: string; status: EnvStatus }
interface Props { rows: EnvRow[]; values: Record<string, string>; busy: boolean; onValue: (name: string, v: string) => void; onUse: (name: string) => void }

/** 환경 변수 이름·상태·입력란. 입력한 값은 서버 메모리에만 남는다(파일·기록에 쓰지 않는다). */
export function EnvTable({ rows, values, busy, onValue, onUse }: Props) {
  if (rows.length === 0) return null;
  return (
    <div className="env">
      <h4 className="kv-h">환경 변수 입력</h4>
      <table className="chunks kv" aria-label="환경 변수">
        <thead><tr><th>이름</th><th>상태</th><th>값</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="mono">{r.name}</td>
              <td className={r.status === "missing" ? "st st-failed" : "st st-done"}>{ENV_STATUS_LABEL[r.status]}</td>
              <td><input type="password" autoComplete="off" aria-label={`${r.name} 값`} value={values[r.name] ?? ""} onChange={(e) => onValue(r.name, e.target.value)} /></td>
              <td><button type="button" className="btn-ghost" aria-label={`${r.name} 이번 세션에 사용`} disabled={busy || !values[r.name]} onClick={() => onUse(r.name)}>이번 세션에 사용</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">입력한 값은 이 서버의 메모리에만 있고 파일·기록에 남지 않습니다. 서버를 다시 켜면 다시 입력합니다</p>
    </div>
  );
}
