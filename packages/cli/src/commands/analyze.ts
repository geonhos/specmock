import { analyze, CatalogSchema, createAdapter, extract, formatCatalog, merge, prepare, type AdapterName, type CatalogDiff } from "@specmock/core";
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
    .option("--refresh", "이미 있는 extracted/*.json을 무시하고 다시 추출한다", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: Opts, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      if (opts.prepare && opts.merge) fail("--prepare와 --merge는 함께 쓸 수 없습니다.");
      const llm = opts.llm ?? "session";
      if (llm !== "session" && llm !== "claude-code") fail(`알 수 없는 LLM 어댑터: ${llm} (session | claude-code)`);

      const printCatalog = async (diff: CatalogDiff | undefined, extra: Record<string, unknown> = {}, summary?: string) => {
        const catalog = await ws.read(system, "catalog.json", CatalogSchema);
        printJsonOr(opts.json, { mode: "catalog", ...extra, diff, catalog }, () => {
          const head = [formatCatalog(catalog), diff ? formatDiff(diff) : "", summary ?? ""].filter((x) => x !== "");
          return [...head, "", `다음: specmock select ${system} <표현식>`, `표현식: ${EXPR_HELP}`].join("\n");
        });
      };

      if (opts.merge) {
        const r = await merge(ws, system);
        return printCatalog(r.diff, { merge: r }, formatMerge(r));
      }

      const outcome = await analyze(ws, system);
      if (outcome.mode === "openapi") return printCatalog(outcome.diff);

      const req = await prepare(ws, system);
      if (req.chunks.length === 0) process.stderr.write("경고: 추출할 청크가 없습니다 (문서 내용이 비어 있음)\n");
      // 세션 어댑터는 extract를 호출하지 않는다(Claude Code 세션이 직접 extracted/를 쓴다). 안내만 출력하고 끝낸다.
      if (llm === "session" || opts.prepare) {
        return printJsonOr(
          opts.json,
          { mode: "prepared", chunks: req.chunks.length, request: ws.file(system, "analyze-request.json"), chunkFiles: req.chunks.map((c) => c.file) },
          () => formatPrepared(system, req, ws.dir(system)),
        );
      }

      const adapter = createAdapter(llm as AdapterName, { claude: { model: opts.model } });
      const ex = await extract(ws, system, adapter, {
        refresh: opts.refresh,
        onProgress: (p) => process.stderr.write(`추출 ${p.done}/${p.total} (청크 ${p.chunk}: ${p.status})\n`),
      });
      if (ex.failed.length) process.stderr.write(`경고: 청크 ${ex.failed.length}개 추출 실패. 첫 오류: ${ex.failed[0]!.error}\n`);
      const r = await merge(ws, system);
      await printCatalog(r.diff, { extract: ex, merge: r }, formatMerge(r));
      // process.exit는 stdout을 잘라먹을 수 있어 exitCode만 설정한다.
      if (ex.failed.length) process.exitCode = 2;
    });
}
