import { analyze } from "../analyze/index.js";
import type { ExtractResult } from "../analyze/extract.js";
import type { MergeResult } from "../analyze/merge.js";
import { generate } from "../generate/index.js";
import type { GenerateReport } from "../generate/generator.js";
import type { LlmAdapter } from "../llm/adapter.js";
import { select, type SelectResult } from "../select/index.js";
import { CatalogSchema, type Catalog, type CatalogDiff } from "../types.js";
import type { VerifyResult } from "../verify/index.js";
import type { Workspace } from "../workspace.js";
import { runLlmExtraction } from "./analyze.js";
import type { OnEvent } from "./events.js";
import { ingestSpec } from "./ingest.js";
import { verifyMock } from "./verify.js";

export type RunStage =
  | { stage: "catalog"; catalog: Catalog; diff: CatalogDiff | undefined; merge: MergeResult | null }
  | { stage: "select"; selection: SelectResult }
  | { stage: "generate"; report: GenerateReport }
  | { stage: "verify"; result: VerifyResult; coverageFile: string };

export interface RunPipelineOptions {
  select?: string;
  outDir?: string;
  verify?: boolean;
  llm?: "claude-code";
  model?: string;
  refresh?: boolean;
  onEvent?: OnEvent;
  /** 단계가 끝날 때마다 호출된다. CLI가 지금과 같은 시점에 stdout을 쓰기 위해 쓴다. */
  onStage?: (s: RunStage) => void;
  adapter?: LlmAdapter;
}

export interface RunPipelineResult {
  catalog: Catalog;
  extract: ExtractResult | null;
  merge: MergeResult | null;
  selection: SelectResult;
  generate: GenerateReport;
  verify: VerifyResult | null;
  coverageFile: string | null;
  /** 일부 청크 추출 실패(CLI 종료 코드 2의 한 원인). */
  extractFailed: boolean;
}

/** ingest → analyze(문서면 claude-code 추출) → select → generate → verify. */
export async function runPipeline(ws: Workspace, system: string, origins: string[], opts: RunPipelineOptions = {}): Promise<RunPipelineResult> {
  await ingestSpec(ws, system, origins, { onEvent: opts.onEvent });
  const outcome = await analyze(ws, system);
  let ex: ExtractResult | null = null;
  let m: MergeResult | null = null;
  if (outcome.mode === "needs-llm") {
    if (opts.llm !== "claude-code") throw new Error("문서 입력은 run에서 --llm claude-code 가 필요합니다. 세션 모드는 specmock analyze <system> 으로 단계별로 진행하세요.");
    const flow = await runLlmExtraction(ws, system, opts);
    ex = flow.extract; m = flow.merge;
    if (flow.extract.written + flow.extract.skipped === 0 || flow.merge.features === 0) {
      throw new Error(`LLM 추출이 모두 실패했습니다: ${flow.extract.failed[0]?.error ?? "추출된 기능이 없습니다"}. claude 로그인/모델을 확인한 뒤 다시 실행하세요.`);
    }
  }
  const catalog = await ws.read(system, "catalog.json", CatalogSchema);
  opts.onStage?.({ stage: "catalog", catalog, diff: m ? m.diff : outcome.diff, merge: m });
  const selection = await select(ws, system, [opts.select ?? "all"]);
  opts.onStage?.({ stage: "select", selection });
  const report = await generate(ws, system, { outDir: opts.outDir });
  opts.onStage?.({ stage: "generate", report });
  let result: VerifyResult | null = null;
  let coverageFile: string | null = null;
  if (opts.verify !== false) {
    const v = await verifyMock(ws, system, { dir: report.outDir, onEvent: opts.onEvent });
    result = v.result; coverageFile = v.coverageFile;
    opts.onStage?.({ stage: "verify", result, coverageFile });
  }
  return { catalog, extract: ex, merge: m, selection, generate: report, verify: result, coverageFile, extractFailed: (ex?.failed.length ?? 0) > 0 };
}
