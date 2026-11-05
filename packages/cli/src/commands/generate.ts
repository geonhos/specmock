import { generate } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatGenerate, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("mockspec.json으로 mock 서버 프로젝트를 생성한다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--lang <lang>", "생성 언어", "ts")
    .option("--out <dir>", "출력 디렉터리 (기본 ./mock/<system>)")
    .option("--force", "사용자가 수정한 fixture도 덮어쓴다", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: { lang: string; out?: string; force: boolean; json: boolean }, cmd: Command) => {
      if (opts.lang !== "ts") fail(`'${opts.lang}' 언어는 아직 지원하지 않습니다. (ts만 가능)`);
      const report = await generate(workspaceFrom(cmd), system, { outDir: opts.out, force: opts.force });
      printJsonOr(opts.json, report, () =>
        `${formatGenerate(report)}\n실행: cd ${report.outDir} && npm install && npm start\n검증: specmock verify ${system}`,
      );
    });
}
