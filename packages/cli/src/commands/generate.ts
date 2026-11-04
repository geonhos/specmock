import { generate } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, workspaceFrom } from "../context.js";

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("mockspec.json으로 mock 서버 프로젝트를 생성한다")
    .argument("<system>")
    .option("--lang <lang>", "생성 언어", "ts")
    .option("--out <dir>", "출력 디렉터리 (기본 ./mock/<system>)")
    .option("--force", "사용자가 수정한 fixture도 덮어쓴다", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: { lang: string; out?: string; force: boolean; json: boolean }, cmd: Command) => {
      try {
        if (opts.lang !== "ts") fail(`'${opts.lang}' 언어는 아직 지원하지 않습니다. (ts만 가능)`);
        const report = await generate(workspaceFrom(cmd), system, { outDir: opts.out, force: opts.force });
        printJsonOr(opts.json, report, () => {
          const kept = report.preserved.length ? `\n보존된 fixture ${report.preserved.length}개 (수정 흔적 있음): ${report.preserved.join(", ")}` : "";
          const orphaned = report.orphaned.length ? `\n고아 fixture ${report.orphaned.length}개 (선택 해제됐지만 수정 흔적이 있어 남김): ${report.orphaned.join(", ")}` : "";
          return `생성 완료: ${report.outDir} (${report.written.length}개 파일)${kept}${orphaned}\n실행: cd ${report.outDir} && npm install && npm start\n검증: specmock verify ${system}`;
        });
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
