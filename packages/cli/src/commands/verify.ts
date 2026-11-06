import { verifyMock, type VerifyMockResult } from "@specmock/core";
import type { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { fail, formatVerify, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("mock 서버를 띄워 contract test를 실행하고 coverage.md를 쓴다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--dir <dir>", "mock 디렉터리 (기본: 마지막 generate --out 경로, 없으면 ./mock/<system>)")
    .option("--report <path>", "coverage.md 추가 저장 경로")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: { dir?: string; report?: string; json: boolean }, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      let v: VerifyMockResult;
      try {
        v = await verifyMock(ws, system, { dir: opts.dir, onEvent: (e) => process.stderr.write(e.message + "\n") });
      } catch (e) { fail((e as Error).message); }
      if (opts.report) await writeFile(opts.report, v.coverageMarkdown, "utf8");
      printJsonOr(opts.json, { ...v.result, coverage: v.coverageFile }, () => formatVerify(v.result, v.coverageFile));
      // process.exit는 파이프로 흘러가는 stdout을 잘라먹을 수 있으므로 exitCode만 설정하고 자연 종료한다.
      if (v.result.failed > 0) process.exitCode = 2;
    });
}
