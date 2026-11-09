// packages/core/src/record/drift.ts
import { maskSecrets } from "../ingest/mask.js";
import type { HttpMethod } from "../types.js";

interface Base { featureId: string; method: HttpMethod; path: string }
export type DriftEntry =
  | (Base & { kind: "matched" })
  | (Base & { kind: "drifted"; status: number; errors: string[] })
  | (Base & { kind: "statusMismatch"; expected: number; actual: number; hint?: string })
  | (Base & { kind: "skipped" })
  | (Base & { kind: "failed"; reason: string });

export const DRIFT_FILE = "drift.md";

export function statusHint(status: number): string | undefined {
  if (status === 401 || status === 403) return "인증 헤더를 확인하세요";
  if (status === 404) return "`target.json`의 `params`로 실제 값을 지정하세요";
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** drift.md 본문. 문자열 전체를 maskSecrets에 통과시킨다. baseUrl은 계정 정보·query가 없음을 target.ts가 보장한다. */
export function renderDrift(system: string, baseUrl: string, at: Date, entries: DriftEntry[]): string {
  const of = <K extends DriftEntry["kind"]>(k: K) => entries.filter((e): e is Extract<DriftEntry, { kind: K }> => e.kind === k);
  const drifted = of("drifted"), mismatch = of("statusMismatch"), skipped = of("skipped"), failed = of("failed");
  const head = (e: Base) => `- ${e.featureId} ${e.method} ${e.path}`;
  const section = (title: string, lines: string[]) => [`## ${title}`, ...(lines.length ? lines : ["(없음)"]), ""];
  const lines = [
    `# ${system} 실제 시스템 대조 (${localStamp(at)}, ${baseUrl})`,
    `요청 ${entries.length} · 일치 ${of("matched").length} · 스펙과 다름 ${drifted.length} · 상태 불일치 ${mismatch.length} · 건너뜀(변경 요청) ${skipped.length} · 실패 ${failed.length}`,
    "",
    ...section("스펙과 다름", drifted.map((e) => `${head(e)} → ${e.status}. ${e.errors.join("; ")}`)),
    ...section("상태 불일치", mismatch.map((e) => `${head(e)} → 기대 ${e.expected}, 실제 ${e.actual}.${e.hint ? ` ${e.hint}` : ""}`)),
    ...section("건너뜀", skipped.map((e) => `${head(e)} — 변경 요청(기본 제외). 포함하려면 CLI \`--allow-mutating\`, MCP \`allowMutating\`, Web '변경 요청 포함'`)),
    ...section("실패", failed.map((e) => `${head(e)} — ${e.reason}`)),
  ];
  return maskSecrets(lines.join("\n"));
}
