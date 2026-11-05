import path from "node:path";
import { Workspace, type AnalyzeRequest, type CatalogDiff, type GenerateReport, type MergeResult, type VerifyResult } from "@specmock/core";
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

export function formatDiff(diff: CatalogDiff): string {
  if (diff.previousAt === null) return "";
  const list = (ids: string[]) => (ids.length ? ` (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""})` : "");
  return `이전 카탈로그 대비: 추가 ${diff.added.length}${list(diff.added)} · 삭제 ${diff.removed.length}${list(diff.removed)} · 변경 ${diff.changed.length}${list(diff.changed)}`;
}

/** 세션 모드 안내. Claude Code 스킬이 이 출력을 그대로 따라간다. */
export function formatPrepared(system: string, req: AnalyzeRequest, wsDir: string): string {
  const lines = [
    `LLM 추출 준비 완료: ${req.chunks.length}개 청크 (${wsDir}/analyze-request.json)`,
    "",
    "다음 중 하나:",
    `  a) specmock analyze ${system} --llm claude-code     # 로컬 claude CLI로 자동 추출`,
    "  b) Claude Code 세션에서 직접 추출:",
    `     1. ${wsDir}/analyze-request.json 의 prompt 와 schema 를 읽는다`,
    `     2. 청크마다 ${wsDir}/${req.chunks[0]?.file ?? "chunks/000.md"} … 를 읽고 schema 대로 ${wsDir}/extracted/NNN.json 을 쓴다 (한 번에 하나)`,
    `     3. specmock analyze ${system} --merge`,
    "",
    "청크:",
    ...req.chunks.map((c) => `  ${c.file}  ${c.heading}  (${c.chars.toLocaleString()}자)`),
  ];
  return lines.join("\n");
}

export function formatMerge(r: MergeResult): string {
  const parts = [`기능 ${r.features}개`];
  if (r.rejected) parts.push(`거절 ${r.rejected}건 (catalog.json의 rejected 참고)`);
  if (r.missingChunks.length) parts.push(`미추출 청크 ${r.missingChunks.length}개`);
  if (r.invalidChunks.length) parts.push(`형식 오류 청크 ${r.invalidChunks.length}개`);
  return parts.join(" · ");
}
