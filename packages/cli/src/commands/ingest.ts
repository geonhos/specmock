import { ingest } from "@specmock/core";
import type { Command } from "commander";
import { SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerIngest(program: Command): void {
  program
    .command("ingest")
    .description("스펙 파일/URL을 읽어 .specmock/<system>/source.json 으로 정규화한다")
    .argument("<system>", `${SYSTEM_ARG_HELP}. 디렉터리 이름으로 쓰인다`)
    .argument("<origins...>", "OpenAPI 파일 경로 또는 URL")
    .action(async (system: string, origins: string[], _o, cmd: Command) => {
      const file = await ingest(workspaceFrom(cmd), system, origins);
      process.stdout.write(`source.json 작성: ${file}\n다음: specmock analyze ${system}\n`);
    });
}
