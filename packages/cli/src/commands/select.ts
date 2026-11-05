import { buildChoices, CatalogSchema, select, SelectionSchema } from "@specmock/core";
import type { Command } from "commander";
import { EXPR_HELP, fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerSelect(program: Command): void {
  program
    .command("select")
    .description("필요한 기능을 골라 selection.json과 mockspec.json을 만든다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .argument("[exprs...]", `선택 표현식: ${EXPR_HELP} (--interactive에서는 생략)`)
    .option("--add", "기존 선택에 추가", false)
    .option("--remove", "기존 선택에서 제거", false)
    .option("--interactive", "체크박스로 고른다 (TTY 필요, 이전 선택은 미리 체크)", false)
    .option("--group <name>", "--interactive에서 이 그룹만 보여준다")
    .option("--json", "JSON으로 출력", false)
    // `-listPets`처럼 '-'로 시작하는 제외 항목을 별도 인자로 받기 위해 알 수 없는 옵션을 표현식으로 흘려보낸다.
    .allowUnknownOption()
    .action(async (system: string, exprs: string[], opts: { add: boolean; remove: boolean; interactive: boolean; group?: string; json: boolean }, cmd: Command) => {
      if (opts.group !== undefined && !opts.interactive) fail("--group은 --interactive와 함께만 쓸 수 있습니다.");
      if (opts.interactive) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) fail("--interactive는 터미널에서만 쓸 수 있습니다. 파이프나 스크립트에서는 표현식을 쓰세요.");
        if (exprs.length) fail("--interactive와 표현식은 함께 쓸 수 없습니다.");
        if (opts.add || opts.remove) fail("--interactive는 --add/--remove와 함께 쓸 수 없습니다.");
      } else if (exprs.length === 0) {
        fail("선택 표현식을 주거나 --interactive를 쓰세요.");
      }
      try {
        const ws = workspaceFrom(cmd);
        if (opts.interactive) {
          const { default: checkbox, Separator } = await import("@inquirer/checkbox");
          const catalog = await ws.read(system, "catalog.json", CatalogSchema);
          if (opts.group !== undefined && !catalog.features.some((f) => f.group === opts.group)) {
            fail(`알 수 없는 그룹: ${opts.group} (${[...new Set(catalog.features.map((f) => f.group))].join(", ")})`);
          }
          const prev = (await ws.exists(system, "selection.json")) ? (await ws.read(system, "selection.json", SelectionSchema)).resolved : null;
          const rows = buildChoices(catalog, prev, { group: opts.group });
          // 표시되지 않은 그룹의 이전 선택은 보존한다(--group으로 일부만 보여줄 때 나머지가 사라지면 안 된다).
          const shown = new Set(rows.flatMap((r) => ("value" in r ? [r.value] : [])));
          const hidden = (prev ?? []).filter((id) => !shown.has(id) && catalog.features.some((f) => f.id === id));
          const picked = await checkbox<string>({
            message: `${system}: mock으로 만들 기능을 고르세요 (space 선택 · a 전체 · i 반전 · enter 확정)`,
            choices: rows.map((r) => ("separator" in r ? new Separator(`── ${r.separator} ──`) : r)),
            pageSize: 20,
            loop: false,
            required: true,
          });
          exprs = [...hidden, ...picked]; // id 목록을 표현식으로 넘긴다 (selection.json에 그대로 저장되어 재현 가능)
        }
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
