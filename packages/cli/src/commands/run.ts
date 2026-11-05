import { analyze, CatalogSchema, formatCatalog, generate, ingest, MockSpecSchema, renderCoverage, select, verify } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatGenerate, formatVerify, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("OpenAPI 입력에 대해 ingest → analyze → select → generate → verify를 한 번에 실행한다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .argument("<origins...>", "OpenAPI 파일 경로 또는 URL")
    .option("--select <expr>", "선택 표현식", "all")
    .option("--lang <lang>", "생성 언어", "ts")
    .option("--out <dir>", "출력 디렉터리")
    .option("--no-verify", "contract test를 건너뛴다")
    .action(async (system: string, origins: string[], opts: { select: string; lang: string; out?: string; verify: boolean }, cmd: Command) => {
      if (opts.lang !== "ts") fail(`'${opts.lang}' 언어는 아직 지원하지 않습니다. (ts만 가능)`);
      const ws = workspaceFrom(cmd);
      await ingest(ws, system, origins);
      const outcome = await analyze(ws, system);
      if (outcome.mode === "needs-llm") fail("문서 입력은 LLM 추출이 필요합니다. (--llm 옵션은 다음 작업에서 추가됩니다)");
      const catalog = await ws.read(system, "catalog.json", CatalogSchema);
      process.stdout.write(formatCatalog(catalog) + "\n\n");
      const sel = await select(ws, system, [opts.select]);
      process.stdout.write(`선택 ${sel.resolved.length}개\n`);
      const report = await generate(ws, system, { outDir: opts.out });
      process.stdout.write(formatGenerate(report) + "\n");
      if (!opts.verify) {
        process.stdout.write(`verify 생략. 실행: cd ${report.outDir} && npm install && npm start\n`);
        return;
      }
      const result = await verify(report.outDir, { onLog: (m) => process.stderr.write(m + "\n") });
      const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
      const saved = await ws.writeText(system, "coverage.md", renderCoverage(spec, result));
      process.stdout.write(formatVerify(result, saved) + "\n");
      // process.exit는 파이프로 흘러가는 stdout을 잘라먹을 수 있으므로 exitCode만 설정하고 자연 종료한다.
      if (result.failed > 0) {
        process.exitCode = 2;
        return;
      }
    });
}
