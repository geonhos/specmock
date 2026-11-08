import type { ChunkSummary } from "@specmock/core";

export function ChunkTable({ chunks, failed }: { chunks: ChunkSummary[]; failed: ReadonlySet<number> }) {
  return (
    <table className="chunks">
      <thead><tr><th>제목</th><th className="num">글자 수</th><th>상태</th></tr></thead>
      <tbody>
        {chunks.map((c) => {
          const state = failed.has(c.index) ? "failed" : c.done ? "done" : "pending";
          return (
            <tr key={c.index}>
              <td>{c.heading}</td>
              <td className="num">{c.chars.toLocaleString("en-US")}</td>
              <td className={`st st-${state}`}>{state === "failed" ? "실패" : state === "done" ? "완료" : "대기"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
