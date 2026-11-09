// packages/cli/src/commands/record.ts
import { APPLY_FAILED, recordResponses, type RecordResponsesResult, type RecordResult } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function recordFailed(r: RecordResult): boolean {
  return r.drifted.length + r.statusMismatch.length + r.failed.length > 0;
}

export function applyFailed(v: RecordResponsesResult): boolean {
  return v.notes.some((n) => n.startsWith(APPLY_FAILED));
}

export function formatRecord(v: RecordResponsesResult): string {
  const r = v.result;
  const total = r.matched.length + r.drifted.length + r.statusMismatch.length + r.skipped.length + r.failed.length;
  const lines = [`녹화: 요청 ${total} · 일치 ${r.matched.length} · 스펙과 다름 ${r.drifted.length} · 상태 불일치 ${r.statusMismatch.length} · 건너뜀 ${r.skipped.length} · 실패 ${r.failed.length}`];
  for (const d of r.drifted) lines.push(`  ✗ ${d.featureId} 스펙과 다름: ${d.errors.join("; ")}`);
  for (const m of r.statusMismatch) lines.push(`  ✗ ${m.featureId} 상태 불일치: 기대 ${m.expected}, 실제 ${m.actual}${m.hint ? `. ${m.hint}` : ""}`);
  for (const f of r.failed) lines.push(`  ✗ ${f.featureId} 실패: ${f.reason}`);
  if (r.skipped.length) lines.push(`  건너뜀(변경 요청, --allow-mutating으로 포함): ${r.skipped.map((s) => s.featureId).join(", ")}`);
  lines.push(`녹화 파일: ${r.recorded.length}개`);
  lines.push(`drift: ${v.driftPath}`);
  if (r.applied) {
    const g = r.applied.generate;
    lines.push(`반영: select ${r.applied.selected}개${g ? ` · generate ${g.outDir} (파일 ${g.written.length}개)` : ""}`);
  }
  for (const n of v.notes) lines.push(`- ${n}`);
  return lines.join("\n");
}

export function registerRecord(program: Command): void {
  program
    .command("record")
    .description("mockspec의 정상 요청을 target.json의 실제 시스템에 보내 응답을 녹화하고 drift.md를 쓴다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--allow-mutating", "POST·PUT·PATCH·DELETE 요청도 보낸다(실제 데이터가 바뀔 수 있음)", false)
    .option("--feature <id...>", "이 기능만 녹화")
    .option("--refresh", "기존 녹화를 모두 지우고 다시 녹화", false)
    .option("--no-apply", "녹화·drift만 하고 select·generate를 다시 실행하지 않는다")
    .option("--json", "RecordResult를 JSON으로 출력", false)
    .action(async (system: string, opts: { allowMutating: boolean; feature?: string[]; refresh: boolean; apply: boolean; json: boolean }, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      let v: RecordResponsesResult;
      try {
        v = await recordResponses(ws, system, {
          allowMutating: opts.allowMutating, features: opts.feature, refresh: opts.refresh, apply: opts.apply,
          onEvent: (e) => process.stderr.write(e.message + "\n"),
        });
      } catch (e) { fail((e as Error).message); }
      printJsonOr(opts.json, v.result, () => formatRecord(v));
      // verify와 같이 exitCode만 설정한다(stdout 파이프 잘림 방지).
      if (recordFailed(v.result) || applyFailed(v)) process.exitCode = 2;
    });
}
