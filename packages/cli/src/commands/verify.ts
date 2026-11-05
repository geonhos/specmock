import { defaultMockDir, GenerateInfoSchema, MockSpecSchema, renderCoverage, verify, type Workspace } from "@specmock/core";
import type { Command } from "commander";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail, formatVerify, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

/** 마지막 generate가 기록한 출력 위치. generate.json이 없으면 undefined. */
async function lastGeneratedDir(ws: Workspace, system: string): Promise<string | undefined> {
  if (!(await ws.exists(system, "generate.json"))) return undefined;
  return (await ws.read(system, "generate.json", GenerateInfoSchema)).outDir;
}

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
      const dir = path.resolve(opts.dir ?? (await lastGeneratedDir(ws, system)) ?? defaultMockDir(system));
      await stat(dir).catch(() => fail(`${dir} 이(가) 없습니다. 먼저 specmock generate ${system} 을 실행하거나 --dir 로 경로를 지정하세요.`));
      const result = await verify(dir, { onLog: (m) => process.stderr.write(m + "\n") });
      const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
      const md = renderCoverage(spec, result);
      const saved = await ws.writeText(system, "coverage.md", md);
      if (opts.report) await writeFile(opts.report, md, "utf8");
      printJsonOr(opts.json, { ...result, coverage: saved }, () => formatVerify(result, saved));
      // process.exit는 파이프로 흘러가는 stdout을 잘라먹을 수 있으므로 exitCode만 설정하고 자연 종료한다.
      if (result.failed > 0) {
        process.exitCode = 2;
        return;
      }
    });
}
