import { CatalogSchema } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, workspaceFrom } from "../context.js";

export function registerShow(program: Command): void {
  program
    .command("show")
    .description("기능 하나의 상세(스키마, 샘플, 근거)를 보여준다")
    .argument("<system>")
    .argument("<featureId>")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, featureId: string, opts: { json: boolean }, cmd: Command) => {
      try {
        const catalog = await workspaceFrom(cmd).read(system, "catalog.json", CatalogSchema);
        const f = catalog.features.find((x) => x.id === featureId);
        if (!f) fail(`알 수 없는 기능 id: ${featureId}`);
        printJsonOr(opts.json, f, () => [
          `${f.id}  (${f.group})`,
          `${f.method} ${f.path}`,
          f.title,
          f.summary,
          `출처 ${f.provenance} · 신뢰도 ${f.confidence} · 인증 ${f.auth} · 샘플 ${f.hasExample ? "있음" : "없음"}`,
          f.notes.length ? `주의: ${f.notes.join("; ")}` : "",
          "",
          "요청:", JSON.stringify(f.request, null, 2),
          "",
          "응답:", JSON.stringify(f.responses, null, 2),
        ].filter((l) => l !== undefined).join("\n"));
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
