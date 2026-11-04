import { select } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, workspaceFrom } from "../context.js";

export function registerSelect(program: Command): void {
  program
    .command("select")
    .description("필요한 기능을 골라 selection.json과 mockspec.json을 만든다")
    .argument("<system>")
    .argument("<exprs...>", "선택 표현식: all | 1,3-5 | users.* | users.get | method:GET | has:example | confidence>=0.8 | -제외 | @selection.json")
    .option("--add", "기존 선택에 추가", false)
    .option("--remove", "기존 선택에서 제거", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, exprs: string[], opts: { add: boolean; remove: boolean; json: boolean }, cmd: Command) => {
      try {
        const ws = workspaceFrom(cmd);
        const result = await select(ws, system, exprs, { add: opts.add, remove: opts.remove });
        printJsonOr(opts.json, result, () => {
          const warn = result.catalogChanged ? "\n주의: 카탈로그가 이전 선택 이후 바뀌었습니다. specmock list로 확인하세요." : "";
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
