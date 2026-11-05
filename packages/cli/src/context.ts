import path from "node:path";
import { Workspace, type GenerateReport, type VerifyResult } from "@specmock/core";
import type { Command } from "commander";

export const SYSTEM_ARG_HELP = "시스템 이름 (ingest 때 준 이름)";
export const EXPR_HELP =
  "all | 1,3-5 | getPet | users.* (id 글롭) | group:<그룹명> | method:GET | has:example | confidence>=0.8 | -제외 | @selection.json";

export function workspaceFrom(cmd: Command): Workspace {
  const opts = cmd.optsWithGlobals() as { workspace?: string };
  return new Workspace(path.resolve(opts.workspace ?? ".specmock"));
}

export function printJsonOr(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : text()) + "\n");
}

export function fail(message: string): never {
  process.stderr.write(`오류: ${message}\n`);
  process.exit(1);
}

/** generate 결과의 공통 출력: 생성 위치·파일 수와 보존/고아 fixture 안내. */
export function formatGenerate(report: GenerateReport): string {
  const lines = [`생성 완료: ${report.outDir} (${report.written.length}개 파일)`];
  if (report.preserved.length) lines.push(`보존된 fixture ${report.preserved.length}개 (수정 흔적 있음): ${report.preserved.join(", ")}`);
  if (report.orphaned.length) lines.push(`고아 fixture ${report.orphaned.length}개 (선택 해제됐지만 수정 흔적이 있어 남김): ${report.orphaned.join(", ")}`);
  return lines.join("\n");
}

/** verify 결과의 공통 출력: 통과/실패 수, 실패한 contract 목록, coverage.md 경로. */
export function formatVerify(result: VerifyResult, coveragePath: string): string {
  const lines = [`contract: 통과 ${result.passed} / 실패 ${result.failed} / 전체 ${result.total}`];
  for (const r of result.results.filter((x) => !x.passed)) lines.push(`  ✗ ${r.featureId} [${r.name}] ${r.errors.join("; ")}`);
  lines.push(`coverage: ${coveragePath}`);
  return lines.join("\n");
}
