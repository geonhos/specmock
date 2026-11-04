import { analyze, CatalogSchema, formatCatalog, generate, ingest, MockSpecSchema, renderCoverage, select, verify } from "@specmock/core";
import type { Command } from "commander";
import { fail, workspaceFrom } from "../context.js";

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("OpenAPI 입력에 대해 ingest → analyze → select → generate → verify를 한 번에 실행한다")
    .argument("<system>")
    .argument("<origins...>")
    .option("--select <expr>", "선택 표현식", "all")
    .option("--lang <lang>", "생성 언어", "ts")
    .option("--out <dir>", "출력 디렉터리")
    .option("--no-verify", "contract test를 건너뛴다")
    .action(async (system: string, origins: string[], opts: { select: string; lang: string; out?: string; verify: boolean }, cmd: Command) => {
      try {
        if (opts.lang !== "ts") fail(`'${opts.lang}' 언어는 아직 지원하지 않습니다. (ts만 가능)`);
        const ws = workspaceFrom(cmd);
        await ingest(ws, system, origins);
        await analyze(ws, system);
        const catalog = await ws.read(system, "catalog.json", CatalogSchema);
        process.stdout.write(formatCatalog(catalog) + "\n\n");
        const sel = await select(ws, system, [opts.select]);
        process.stdout.write(`선택 ${sel.resolved.length}개\n`);
        const report = await generate(ws, system, { outDir: opts.out });
        process.stdout.write(`생성 완료: ${report.outDir}\n`);
        if (opts.verify) {
          const result = await verify(report.outDir, { onLog: (m) => process.stderr.write(m + "\n") });
          const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
          const saved = await ws.writeText(system, "coverage.md", renderCoverage(spec, result));
          process.stdout.write(`contract: 통과 ${result.passed} / 실패 ${result.failed}\ncoverage: ${saved}\n`);
          if (result.failed > 0) process.exit(2);
        } else {
          process.stdout.write(`verify 생략. 실행: cd ${report.outDir} && npm install && npm start\n`);
        }
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
