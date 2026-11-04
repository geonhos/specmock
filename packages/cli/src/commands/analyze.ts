import { analyze, CatalogSchema, formatCatalog } from "@specmock/core";
import type { Command } from "commander";
import { fail, workspaceFrom } from "../context.js";

export function registerAnalyze(program: Command): void {
  program
    .command("analyze")
    .description("source.json을 분석해 기능 카탈로그(catalog.json)를 만든다")
    .argument("<system>")
    .action(async (system: string, _o, cmd: Command) => {
      try {
        const ws = workspaceFrom(cmd);
        await analyze(ws, system);
        const catalog = await ws.read(system, "catalog.json", CatalogSchema);
        process.stdout.write(formatCatalog(catalog) + `\n\n다음: specmock select ${system} <표현식>  (예: all, users.*, 1-5)\n`);
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
