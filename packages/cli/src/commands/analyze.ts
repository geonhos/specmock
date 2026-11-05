import { analyzeSpec, CatalogSchema, formatCatalog, type CatalogDiff } from "@specmock/core";
import type { Command } from "commander";
import { EXPR_HELP, fail, formatDiff, formatMerge, formatPrepared, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

interface Opts { llm?: string; model?: string; prepare: boolean; merge: boolean; refresh: boolean; json: boolean }

export function registerAnalyze(program: Command): void {
  program
    .command("analyze")
    .description("source.json을 분석해 기능 카탈로그(catalog.json)를 만든다. 문서 입력은 LLM 추출을 거친다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--llm <adapter>", "문서 입력의 LLM 어댑터: session(기본, Claude Code 세션이 직접 추출) | claude-code(로컬 claude CLI로 자동 추출)")
    .option("--model <model>", "claude-code 어댑터의 모델 (예: sonnet, opus)")
    .option("--prepare", "청크와 analyze-request.json만 만들고 멈춘다", false)
    .option("--merge", "prepare 없이 extracted/*.json을 합쳐 카탈로그만 만든다", false)
    .option("--refresh", "다시 추출한다. claude-code: 이미 있는 extracted/*.json을 무시. session/--prepare: prepare 전에 extracted/ 의 기존 결과(NNN.json, manifest.json)를 모두 지움", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: Opts, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      if (opts.prepare && opts.merge) fail("--prepare와 --merge는 함께 쓸 수 없습니다.");
      const llm = opts.llm ?? "session";
      if (llm !== "session" && llm !== "claude-code") fail(`알 수 없는 LLM 어댑터: ${llm} (session | claude-code)`);

      if (opts.merge && (opts.llm !== undefined || opts.refresh || opts.model !== undefined)) fail("--merge 는 다른 옵션과 함께 쓸 수 없습니다. (--llm, --model, --refresh 제외)");
      if (opts.model !== undefined && llm === "session") process.stderr.write("경고: --model 은 --llm claude-code 에서만 쓰입니다. 무시합니다.\n");

      const printCatalog = async (diff: CatalogDiff | undefined, extra: Record<string, unknown> = {}, summary?: string, incomplete = false) => {
        const catalog = await ws.read(system, "catalog.json", CatalogSchema);
        printJsonOr(opts.json, { mode: "catalog", ...extra, diff, catalog }, () => {
          const head = [formatCatalog(catalog), diff ? formatDiff(diff) : "", summary ?? ""].filter((x) => x !== "");
          const next = incomplete
            ? [`다음: 실패/미추출 청크만 다시 추출 — specmock analyze ${system} --llm claude-code (claude 로그인·모델 확인). 또는 세션에서 extracted/NNN.json 을 채운 뒤 specmock analyze ${system} --merge`]
            : [`다음: specmock select ${system} <표현식>`, `표현식: ${EXPR_HELP}`];
          return [...head, "", ...next].join("\n");
        });
      };

      const r = await analyzeSpec(ws, system, {
        step: opts.merge ? "merge" : opts.prepare ? "prepare" : "auto",
        llm: llm as "session" | "claude-code",
        model: opts.model,
        refresh: opts.refresh,
        onEvent: (e) => process.stderr.write(e.message + "\n"),
      });
      if (r.mode === "prepared") {
        // 세션 어댑터는 extract를 호출하지 않는다(Claude Code 세션이 직접 extracted/를 쓴다). 안내만 출력하고 끝낸다.
        return printJsonOr(
          opts.json,
          { mode: "prepared", chunks: r.request.chunks.length, request: ws.file(system, "analyze-request.json"), chunkFiles: r.request.chunks.map((c) => ws.file(system, c.file)) },
          () => formatPrepared(system, r.request, ws.dir(system)),
        );
      }
      if (r.via === "openapi") return printCatalog(r.diff);
      if (r.via === "merge") return printCatalog(r.merge.diff, { merge: r.merge }, formatMerge(r.merge), r.incomplete);
      await printCatalog(r.merge.diff, { extract: r.extract, merge: r.merge }, formatMerge(r.merge), r.incomplete);
      // process.exit는 stdout을 잘라먹을 수 있어 exitCode만 설정한다.
      if (r.extract.failed.length) process.exitCode = 2;
    });
}
