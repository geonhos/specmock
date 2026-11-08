/** core renderCoverage가 쓰는 coverage.md를 화면용 구조로 푼다. core는 문자열만 남기므로(coverage.json 없음) 형식에 기댄다. */
export interface CoverageData {
  selected: number; total: number;
  sources: { name: string; count: number; meaning: string }[];
  confidence: { range: string; count: number }[];
  assumptions: string[];
  notMocked: { id: string; text: string }[];
}

/** `## 제목` 아래 본문 줄들. 제목은 앞부분 일치로 찾는다. */
function section(lines: string[], title: string): string[] | undefined {
  const at = lines.findIndex((l) => l.startsWith(`## ${title}`));
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}
const rows = (body: string[]) => body.filter((l) => l.startsWith("|")).slice(2).map((l) => l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
const bullets = (body: string[]) => body.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

/** 형식을 알아보지 못하면 null(화면은 원문을 그대로 보인다). */
export function parseCoverage(md: string): CoverageData | null {
  const lines = md.split(/\r?\n/);
  const head = /^선택 기능: (\d+) \/ (\d+)\s*$/m.exec(md);
  const src = section(lines, "fixture 출처");
  const conf = section(lines, "신뢰도 분포");
  if (!head || !src || !conf) return null;
  const sources = rows(src).map(([name, count, meaning]) => ({ name: name ?? "", count: Number(count), meaning: meaning ?? "" }));
  const confidence = rows(conf).map(([range, count]) => ({ range: range ?? "", count: Number(count) }));
  if (sources.length === 0 || [...sources, ...confidence].some((r) => Number.isNaN(r.count))) return null;
  const not = section(lines, "선택되지 않은 기능") ?? [];
  return {
    selected: Number(head[1]), total: Number(head[2]), sources, confidence,
    assumptions: bullets(section(lines, "가정") ?? []),
    notMocked: bullets(not).map((b) => { const m = /^`([^`]+)`\s*(.*)$/.exec(b); return { id: m?.[1] ?? b, text: m?.[2] ?? "" }; }),
  };
}
