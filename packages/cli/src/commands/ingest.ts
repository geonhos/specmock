import { ingest, SourceSchema } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerIngest(program: Command): void {
  program
    .command("ingest")
    .description("스펙 파일/URL(OpenAPI · HTML · Markdown · PDF · 텍스트)을 읽어 .specmock/<system>/source.json 으로 정규화한다")
    .argument("<system>", `${SYSTEM_ARG_HELP}. 디렉터리 이름으로 쓰인다`)
    .argument("<origins...>", "파일 경로 또는 URL")
    .option("--refresh", "이전에 읽은 원문 캐시를 무시하고 다시 읽는다", false)
    .option("--harvest <mode>", "웹 문서의 숨은 콘텐츠 수확(ego-browser): auto | always | never", "auto")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, origins: string[], opts: { refresh: boolean; harvest: string; json: boolean }, cmd: Command) => {
      if (!["auto", "always", "never"].includes(opts.harvest)) fail(`--harvest 값이 올바르지 않습니다: ${opts.harvest} (auto | always | never)`);
      const ws = workspaceFrom(cmd);
      const logs: string[] = [];
      const file = await ingest(ws, system, origins, {
        refresh: opts.refresh,
        harvest: opts.harvest as "auto" | "always" | "never",
        onLog: (m) => { logs.push(m); if (!opts.json) process.stderr.write(m + "\n"); },
      });
      const src = await ws.read(system, "source.json", SourceSchema);
      const inputs = src.inputs.map((i) => ({
        kind: i.kind,
        origin: i.origin,
        chars: i.content.length,
        cached: logs.some((l) => l.startsWith(`${i.origin}: 캐시 재사용`)),
        harvestCandidate: i.harvestCandidate?.reasons ?? [],
        harvested: Boolean(i.harvested),
      }));
      printJsonOr(opts.json, { system, file, inputs }, () => {
        const lines = [`source.json 작성: ${file}`];
        for (const i of inputs) {
          lines.push(`  ${i.kind.padEnd(8)} ${i.origin}  ${i.chars.toLocaleString()}자${i.cached ? "  (캐시)" : ""}`);
          if (i.harvestCandidate.length && !i.harvested) lines.push(`           숨은 콘텐츠 가능성: ${i.harvestCandidate.join(", ")}. 수확하려면 --harvest always`);
        }
        lines.push(`다음: specmock analyze ${system}`);
        return lines.join("\n");
      });
    });
}
