#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@specmock/core";
import { registerAnalyze } from "./commands/analyze.js";
import { registerGenerate } from "./commands/generate.js";
import { registerIngest } from "./commands/ingest.js";
import { registerList } from "./commands/list.js";
import { registerRun } from "./commands/run.js";
import { registerSelect } from "./commands/select.js";
import { registerUi } from "./commands/ui.js";
import { registerShow } from "./commands/show.js";
import { registerVerify } from "./commands/verify.js";

const program = new Command();
program
  .name("specmock")
  .description("스펙에서 필요한 기능만 골라 mock 서버를 생성한다")
  .version(VERSION)
  .option("--workspace <dir>", "상태 파일 디렉터리", ".specmock");

registerIngest(program);
registerAnalyze(program);
registerList(program);
registerShow(program);
registerSelect(program);
registerGenerate(program);
registerVerify(program);
registerRun(program);
registerUi(program);

program.parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`오류: ${e.message}\n`);
  // GenerationFailedError(5)처럼 종료 코드를 가진 오류는 그 값을 쓴다.
  process.exit((e as { exitCode?: number }).exitCode ?? 1);
});
