import { CatalogSchema, formatCatalog, orderFeatures } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, workspaceFrom } from "../context.js";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("기능 카탈로그를 표로 보여준다")
    .argument("<system>")
    .option("--group <name>", "특정 그룹만")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: { group?: string; json: boolean }, cmd: Command) => {
      try {
        const catalog = await workspaceFrom(cmd).read(system, "catalog.json", CatalogSchema);
        const filtered = opts.group ? { ...catalog, features: catalog.features.filter((f) => f.group === opts.group) } : catalog;
        printJsonOr(opts.json, { ...filtered, order: orderFeatures(filtered).map((o) => ({ index: o.index, id: o.feature.id })) }, () => formatCatalog(filtered));
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
