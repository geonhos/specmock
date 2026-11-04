import { analyze, CatalogSchema, formatCatalog } from "@specmock/core";
import type { Command } from "commander";
import { EXPR_HELP, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerAnalyze(program: Command): void {
  program
    .command("analyze")
    .description("source.json을 분석해 기능 카탈로그(catalog.json)를 만든다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .action(async (system: string, _o, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      await analyze(ws, system);
      const catalog = await ws.read(system, "catalog.json", CatalogSchema);
      process.stdout.write(formatCatalog(catalog) + `\n\n다음: specmock select ${system} <표현식>\n표현식: ${EXPR_HELP}\n`);
    });
}
