import type { Runs } from "../flowModel";

export function Leftovers({ runs }: { runs: Runs }) {
  const rows = (["mock", "real"] as const).flatMap((t) => (runs[t]?.leftovers ?? []).map((l) => ({ ...l, target: t })));
  if (rows.length === 0) return null;
  return (
    <section aria-label="남은 자원" className="leftover">
      <h3>남은 자원</h3>
      <table>
        <thead><tr><th>대상</th><th>자원</th><th>주소</th><th>식별자</th><th>이유</th></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={`${l.target}:${l.stepId}:${l.url}`}>
            <td>{l.target === "mock" ? "mock" : "실제"}</td><td>{l.resource}</td><td><code className="mono">{l.url}</code></td><td>{l.id ?? ""}</td><td>{l.reason}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
