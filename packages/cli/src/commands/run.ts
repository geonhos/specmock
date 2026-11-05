import { analyze, CatalogSchema, createAdapter, extract, formatCatalog, generate, ingest, merge, MockSpecSchema, prepare, renderCoverage, select, verify, type VerifyResult } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatGenerate, formatVerify, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

interface Opts { select: string; lang: string; out?: string; verify: boolean; llm?: string; json: boolean }

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
    .option("--json", "마지막에 JSON 하나만 출력 (진행 상황은 stderr)", false)
    .action(async (system: string, origins: string[], opts: Opts, cmd: Command) => {
      if (opts.lang !== "ts") fail(`'${opts.lang}' 언어는 아직 지원하지 않습니다. (ts만 가능)`);
      if (opts.llm !== undefined && opts.llm !== "claude-code" && opts.llm !== "session") fail(`알 수 없는 LLM 어댑터: ${opts.llm} (claude-code)`);
      const ws = workspaceFrom(cmd);
      // --json이면 중간 stdout을 모두 막고 마지막에 JSON 하나만 낸다.
      const out = (s: string) => { if (!opts.json) process.stdout.write(s); };
      await ingest(ws, system, origins, { onLog: (m) => process.stderr.write(m + "\n") });
      const outcome = await analyze(ws, system);
      if (outcome.mode === "needs-llm") {
        if (opts.llm !== "claude-code") fail("문서 입력은 run에서 --llm claude-code 가 필요합니다. 세션 모드는 specmock analyze <system> 으로 단계별로 진행하세요.");
        const req = await prepare(ws, system);
        if (req.chunks.length === 0) process.stderr.write("경고: 추출할 청크가 없습니다 (문서 내용이 비어 있음)\n");
        const ex = await extract(ws, system, createAdapter("claude-code"), { onProgress: (p) => process.stderr.write(`추출 ${p.done}/${p.total}\n`) });
        if (ex.failed.length) process.stderr.write(`경고: 청크 ${ex.failed.length}개 추출 실패. 첫 오류: ${ex.failed[0]!.error}\n`);
        await merge(ws, system);
      }
      const catalog = await ws.read(system, "catalog.json", CatalogSchema);
      out(formatCatalog(catalog) + "\n\n");
      const sel = await select(ws, system, [opts.select]);
      out(`선택 ${sel.resolved.length}개\n`);
      const report = await generate(ws, system, { outDir: opts.out });
      out(formatGenerate(report) + "\n");

      let result: VerifyResult | null = null;
      let coverage: string | null = null;
      if (!opts.verify) {
        out(`verify 생략. 실행: cd ${report.outDir} && npm install && npm start\n`);
      } else {
        result = await verify(report.outDir, { onLog: (m) => process.stderr.write(m + "\n") });
        const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
        coverage = await ws.writeText(system, "coverage.md", renderCoverage(spec, result));
        out(formatVerify(result, coverage) + "\n");
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify({ system, catalog: { features: catalog.features.length }, selected: sel.resolved, generate: report, verify: result, coverage }, null, 2) + "\n");
      }
      // process.exit는 파이프로 흘러가는 stdout을 잘라먹을 수 있으므로 exitCode만 설정하고 자연 종료한다.
      if (result && result.failed > 0) process.exitCode = 2;
    });
}
