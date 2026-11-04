import type { Fixture, MockSpec } from "../types.js";
import type { VerifyResult } from "./index.js";

const SOURCES: Fixture["source"][] = ["spec-example", "doc-sample", "schema-generated", "empty"];

export function renderCoverage(spec: MockSpec, result: VerifyResult | null): string {
  const total = spec.features.length + spec.notMocked.length;
  const primary = spec.features.map((f) => f.fixtures.filter((x) => x.status >= 200 && x.status < 300).sort((a, b) => a.status - b.status)[0] ?? f.fixtures[0]);
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, primary.filter((p) => p.source === s).length]));
  const conf = {
    "1.0": spec.features.filter((f) => f.confidence >= 1).length,
    "0.8 이상": spec.features.filter((f) => f.confidence >= 0.8 && f.confidence < 1).length,
    "0.5 이상": spec.features.filter((f) => f.confidence >= 0.5 && f.confidence < 0.8).length,
    "0.5 미만": spec.features.filter((f) => f.confidence < 0.5).length,
  };

  const lines: string[] = [];
  lines.push(`# ${spec.system} coverage`);
  lines.push("");
  lines.push(`선택 기능: ${spec.features.length} / ${total}`);
  lines.push("");
  lines.push("## fixture 출처 (기본 응답 기준)");
  lines.push("");
  lines.push("| 출처 | 개수 | 의미 |");
  lines.push("|---|---|---|");
  lines.push(`| spec-example | ${bySource["spec-example"]} | 스펙의 example 그대로. 실제 모양에 가장 가깝다 |`);
  lines.push(`| doc-sample | ${bySource["doc-sample"]} | 문서에서 추출한 샘플 |`);
  lines.push(`| schema-generated | ${bySource["schema-generated"]} | 스키마로 생성. 구조는 맞지만 값은 임의 |`);
  lines.push(`| empty | ${bySource["empty"]} | 스키마 없음. 빈 객체 |`);
  lines.push("");
  lines.push("## 신뢰도 분포");
  lines.push("");
  lines.push("| 구간 | 개수 |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(conf)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## 가정 (assumptions)");
  lines.push("");
  if (spec.assumptions.length === 0) lines.push("없음");
  for (const a of spec.assumptions) lines.push(`- ${a}`);
  lines.push("");
  lines.push("## contract test");
  lines.push("");
  if (!result) {
    lines.push("실행하지 않음 (`specmock verify` 로 실행)");
  } else {
    lines.push(`contract: 통과 ${result.passed} / 실패 ${result.failed} / 전체 ${result.total}`);
    const failed = result.results.filter((r) => !r.passed);
    if (failed.length > 0) {
      lines.push("");
      lines.push("| feature | case | expected | actual | errors |");
      lines.push("|---|---|---|---|---|");
      for (const r of failed) lines.push(`| ${r.featureId} | ${r.name} | ${r.expectedStatus} | ${r.actualStatus ?? "-"} | ${r.errors.join("; ")} |`);
    }
  }
  lines.push("");
  lines.push("## 선택되지 않은 기능");
  lines.push("");
  if (spec.notMocked.length === 0) lines.push("없음");
  for (const n of spec.notMocked) lines.push(`- \`${n.id}\` ${n.method} ${n.path}`);
  lines.push("");
  return lines.join("\n");
}
