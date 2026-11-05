import { findFeature, type Feature } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerShow(program: Command): void {
  program
    .command("show")
    .description("기능 하나의 상세(스키마, 샘플, 근거)를 보여준다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .argument("<featureId>", "기능 id (specmock list로 확인)")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, featureId: string, opts: { json: boolean }, cmd: Command) => {
      let f: Feature;
      try { f = await findFeature(workspaceFrom(cmd), system, featureId); } catch (e) { fail((e as Error).message); }
      printJsonOr(opts.json, f, () => [
        `${f.id}  (${f.group})`,
        `${f.method} ${f.path}`,
        f.title,
        f.summary || undefined,
        `출처 ${f.provenance} · 신뢰도 ${f.confidence.toFixed(1)} · 인증 ${f.auth} · 샘플 ${f.hasExample ? "있음" : "없음"}`,
        f.notes.length ? `주의: ${f.notes.join("; ")}` : undefined,
        "",
        "요청:", JSON.stringify(f.request, null, 2),
        "",
        "응답:", JSON.stringify(f.responses, null, 2),
      ].filter((l) => l !== undefined).join("\n"));
    });
}
