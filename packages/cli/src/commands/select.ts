import { select } from "@specmock/core";
import type { Command } from "commander";
import { EXPR_HELP, fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerSelect(program: Command): void {
  program
    .command("select")
    .description("필요한 기능을 골라 selection.json과 mockspec.json을 만든다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .argument("<exprs...>", `선택 표현식: ${EXPR_HELP}`)
    .option("--add", "기존 선택에 추가", false)
    .option("--remove", "기존 선택에서 제거", false)
    .option("--json", "JSON으로 출력", false)
    // `-listPets`처럼 '-'로 시작하는 제외 항목을 별도 인자로 받기 위해 알 수 없는 옵션을 표현식으로 흘려보낸다.
    .allowUnknownOption()
    .action(async (system: string, exprs: string[], opts: { add: boolean; remove: boolean; json: boolean }, cmd: Command) => {
      try {
        const ws = workspaceFrom(cmd);
        const result = await select(ws, system, exprs, { add: opts.add, remove: opts.remove });
        printJsonOr(opts.json, result, () => {
          let warn = "";
          if (result.catalogChanged) {
            const d = result.catalogDiff;
            const ids = (xs: string[]) => (xs.length ? ` (${xs.slice(0, 5).join(", ")}${xs.length > 5 ? ", …" : ""})` : "");
            warn = "\n주의: 카탈로그가 이전 선택 이후 바뀌었습니다.";
            if (d) {
              warn += ` 추가 ${d.added.length}${ids(d.added)} · 삭제 ${d.removed.length}${ids(d.removed)}`;
              if (d.removedSelected.length) warn += `\n선택했던 기능 중 사라짐: ${d.removedSelected.join(", ")}`;
            }
            warn += "\nspecmock list로 확인하세요.";
          }
          return `선택 ${result.resolved.length}개: ${result.resolved.join(", ")}${warn}\n다음: specmock generate ${system}`;
        });
      } catch (e) {
        const message = (e as Error).message;
        const hint = /알 수 없는 기능 id/.test(message) && (opts.add || opts.remove)
          ? `\n이전 선택에 저장된 id가 바뀐 카탈로그에 없을 수 있습니다. 새로 선택하세요: specmock select ${system} <표현식>`
          : "";
        fail(message + hint);
      }
    });
}
