import { assertLanguage, finalizeGeneration, generate, prepareGeneration } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatGenerate, parseAttempts, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

interface Opts { lang?: string; llm: string; model?: string; maxAttempts?: string; finalize: boolean; out?: string; force: boolean; json: boolean }

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("mockspec.json으로 mock 서버 프로젝트를 생성한다. ts는 템플릿, java는 LLM(claude-code)이 만들고 빌드·검증까지 통과한 것만 반영한다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--lang <lang>", "생성 언어 (ts | java). 생략하면 기존 디렉터리의 언어, 없으면 ts")
    .option("--llm <adapter>", "ts가 아닌 언어의 생성 방식: claude-code(기본, 여기서 끝까지) | session(지시서만 쓰고 대화에서 작성)", "claude-code")
    .option("--model <model>", "claude-code 어댑터의 모델 (예: sonnet, opus)")
    .option("--max-attempts <n>", "LLM 생성의 최대 시도 횟수 (기본 3)")
    .option("--finalize", "--llm session 뒤 대화에서 쓴 파일을 확정한다(보호 경로·범위 검사, fixtures·contracts·lock 작성)", false)
    .option("--out <dir>", "출력 디렉터리 (기본 ./mock/<system>)")
    .option("--force", "사용자가 수정한 fixture도 덮어쓴다. specmock이 만들지 않은(specmock.lock.json 없는) 비어 있지 않은 디렉터리도 덮어쓴다(package.json·src 등 교체, routes·contracts 정리). 언어를 바꿀 때도 필요하다(fixtures·contracts 밖의 기존 소스 삭제)", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: Opts, cmd: Command) => {
      if (opts.llm !== "claude-code" && opts.llm !== "session") fail(`알 수 없는 LLM 어댑터: ${opts.llm} (claude-code, session)`);
      if (opts.lang !== undefined) assertLanguage(opts.lang);
      const maxAttempts = parseAttempts(opts.maxAttempts);
      const ws = workspaceFrom(cmd);

      if (opts.finalize) {
        const r = await finalizeGeneration(ws, system);
        if (!r.ok) {
          if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
          fail(`확정 거부(${r.reason}): ${r.errors.join("; ")}`);
        }
        printJsonOr(opts.json, r, () => [
          `확정: ${r.outDir} (${r.written.length}개 파일)`,
          ...r.warnings.map((w) => `경고: ${w}`),
          `검증: specmock verify ${system}`,
        ].join("\n"));
        return;
      }

      if (opts.llm === "session") {
        const p = await prepareGeneration(ws, system, { outDir: opts.out, force: opts.force, language: opts.lang });
        printJsonOr(opts.json, p, () => [
          `${p.reused ? "지시서가 이미 최신입니다" : "지시서를 썼습니다"}: ${p.requestPath}`,
          `출력 위치: ${p.outDir} (${p.language})`,
          ...p.nextSteps,
        ].join("\n"));
        return;
      }

      const report = await generate(ws, system, {
        outDir: opts.out, force: opts.force, language: opts.lang, model: opts.model, maxAttempts,
        onProgress: (e) => process.stderr.write(e.message + "\n"),
      });
      printJsonOr(opts.json, report, () =>
        `${formatGenerate(report)}\n실행: ${report.launch}\n검증: specmock verify ${system}`,
      );
    });
}
