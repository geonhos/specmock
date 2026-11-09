import { formatCatalog, runPipeline, verifyFailed } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatDiff, formatGenerate, formatMerge, formatVerify, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

interface Opts { select: string; lang: string; out?: string; verify: boolean; llm?: string; model?: string; refresh: boolean; json: boolean }

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("ingest → analyze → select → generate → verify를 한 번에 실행한다. 문서 입력은 --llm claude-code 가 필요하다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .argument("<origins...>", "파일 경로 또는 URL")
    .option("--select <expr>", "선택 표현식", "all")
    .option("--lang <lang>", "생성 언어", "ts")
    .option("--out <dir>", "출력 디렉터리")
    .option("--no-verify", "contract test를 건너뛴다")
    .option("--llm <adapter>", "문서 입력일 때 LLM 어댑터 (claude-code만 가능. 세션 모드는 run 대신 analyze로 단계별 진행)")
    .option("--model <model>", "claude-code 어댑터의 모델 (예: sonnet, opus)")
    .option("--refresh", "이미 있는 extracted/*.json을 무시하고 다시 추출한다", false)
    .option("--json", "마지막에 JSON 하나만 출력 (진행 상황은 stderr)", false)
    .action(async (system: string, origins: string[], opts: Opts, cmd: Command) => {
      if (opts.lang !== "ts") fail(`'${opts.lang}' 언어는 아직 지원하지 않습니다. (ts만 가능)`);
      if (opts.llm === "session") fail("run은 세션 모드를 지원하지 않습니다. specmock analyze <system> 으로 단계별로 진행하거나 --llm claude-code 를 쓰세요.");
      if (opts.llm !== undefined && opts.llm !== "claude-code") fail(`알 수 없는 LLM 어댑터: ${opts.llm} (claude-code)`);
      const ws = workspaceFrom(cmd);
      // --json이면 중간 stdout을 모두 막고 마지막에 JSON 하나만 낸다.
      const out = (s: string) => { if (!opts.json) process.stdout.write(s); };
      const r = await runPipeline(ws, system, origins, {
        select: opts.select, outDir: opts.out, verify: opts.verify,
        llm: opts.llm as "claude-code" | undefined, model: opts.model, refresh: opts.refresh,
        onEvent: (e) => process.stderr.write(e.message + "\n"),
        onStage: (s) => {
          if (s.stage === "catalog") {
            out(formatCatalog(s.catalog) + "\n");
            for (const line of [s.diff ? formatDiff(s.diff) : "", s.merge ? formatMerge(s.merge) : ""]) if (line) out(line + "\n");
            out("\n");
          } else if (s.stage === "select") {
            out(`선택 ${s.selection.resolved.length}개\n`);
          } else if (s.stage === "generate") {
            out(formatGenerate(s.report) + "\n");
            if (!opts.verify) out(`verify 생략. 실행: cd ${s.report.outDir} && npm install && npm start\n`);
          } else {
            out(formatVerify(s.result, s.coverageFile) + "\n");
          }
        },
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ system, catalog: { features: r.catalog.features.length }, selected: r.selection.resolved, generate: r.generate, verify: r.verify, coverage: r.coverageFile, extract: r.extract, merge: r.merge }, null, 2) + "\n");
      }
      // process.exit는 파이프로 흘러가는 stdout을 잘라먹을 수 있으므로 exitCode만 설정하고 자연 종료한다.
      if (r.extractFailed || (r.verify && verifyFailed(r.verify))) process.exitCode = 2;
    });
}
