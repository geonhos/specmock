import { analyze, CatalogSchema, formatCatalog } from "@specmock/core";
import type { Command } from "commander";
import { EXPR_HELP, fail, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerAnalyze(program: Command): void {
  program
    .command("analyze")
    .description("source.json을 분석해 기능 카탈로그(catalog.json)를 만든다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .action(async (system: string, _o, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      const outcome = await analyze(ws, system);
      if (outcome.mode === "needs-llm") fail("문서 입력은 LLM 추출이 필요합니다. (--llm 옵션은 다음 작업에서 추가됩니다)");
      const catalog = await ws.read(system, "catalog.json", CatalogSchema);
      process.stdout.write(formatCatalog(catalog) + `\n\n다음: specmock select ${system} <표현식>\n표현식: ${EXPR_HELP}\n`);
    });
}
