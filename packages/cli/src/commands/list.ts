import { CatalogSchema, formatCatalog, orderFeatures } from "@specmock/core";
import type { Command } from "commander";
import { printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("기능 카탈로그를 표로 보여준다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--group <name>", "특정 그룹만 (번호는 전체 기준으로 유지된다)")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: { group?: string; json: boolean }, cmd: Command) => {
      const catalog = await workspaceFrom(cmd).read(system, "catalog.json", CatalogSchema);
      // 번호는 select가 쓰는 전역 번호와 같아야 하므로 전체 카탈로그에서 매긴 뒤 그룹만 거른다.
      const order = orderFeatures(catalog)
        .filter((o) => !opts.group || o.feature.group === opts.group)
        .map((o) => ({ index: o.index, id: o.feature.id }));
      printJsonOr(opts.json, { ...catalog, group: opts.group, order }, () => formatCatalog(catalog, { group: opts.group }));
    });
}
