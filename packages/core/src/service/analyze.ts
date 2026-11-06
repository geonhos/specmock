import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { analyze } from "../analyze/index.js";
import { extract, type ExtractResult } from "../analyze/extract.js";
import { merge, type MergeResult } from "../analyze/merge.js";
import { EXTRACTED_DIR, prepare } from "../analyze/prepare.js";
import { createAdapter } from "../llm/index.js";
import type { LlmAdapter } from "../llm/adapter.js";
import type { AnalyzeRequest, CatalogDiff } from "../types.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { OnEvent } from "./events.js";

export const NO_CHUNKS_WARNING = "경고: 추출할 청크가 없습니다 (문서 내용이 비어 있음)";

export interface AnalyzeSpecOptions {
  /** auto: 입력에 따라 분기. prepare: 문서면 prepare에서 멈춤. merge: prepare 없이 extracted/만 합침. */
  step?: "auto" | "prepare" | "merge";
  /** 문서 입력의 추출 주체. session(기본): 호출자가 추출. claude-code: 로컬 claude CLI로 자동 추출. */
  llm?: "session" | "claude-code";
  model?: string;
  /** session/prepare: prepare 전에 extracted/를 비움. claude-code: 기존 결과를 무시하고 다시 추출. */
  refresh?: boolean;
  onEvent?: OnEvent;
  /** 테스트용 어댑터 주입. 없으면 claude-code 어댑터를 만든다. */
  adapter?: LlmAdapter;
}

export type AnalyzeSpecResult =
  | { mode: "catalog"; via: "openapi"; diff: CatalogDiff | undefined }
  | { mode: "catalog"; via: "merge"; merge: MergeResult; incomplete: boolean }
  | { mode: "catalog"; via: "llm"; request: AnalyzeRequest; extract: ExtractResult; merge: MergeResult; incomplete: boolean }
  | { mode: "prepared"; request: AnalyzeRequest; removed: number | null };

/** extracted/ 의 NNN.json 과 manifest.json 을 모두 지우고 지운 NNN.json 개수를 돌려준다. */
export async function clearExtracted(ws: Workspace, system: string): Promise<number> {
  return withSystemLock(ws, system, () => clearExtractedUnlocked(ws, system));
}

async function clearExtractedUnlocked(ws: Workspace, system: string): Promise<number> {
  const dir = ws.file(system, EXTRACTED_DIR);
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (/^\d{3,}\.json$/.test(name)) { await rm(path.join(dir, name), { force: true }); n++; }
    else if (name === "manifest.json") await rm(path.join(dir, name), { force: true });
  }
  return n;
}

/** 문서 입력의 자동 흐름: prepare → 어댑터 extract → merge. analyze와 run이 공유한다. */
export async function runLlmExtraction(
  ws: Workspace,
  system: string,
  opts: Pick<AnalyzeSpecOptions, "model" | "refresh" | "onEvent" | "adapter"> = {},
): Promise<{ request: AnalyzeRequest; extract: ExtractResult; merge: MergeResult }> {
  const emit = opts.onEvent ?? (() => {});
  const request = await prepare(ws, system);
  if (request.chunks.length === 0) emit({ stage: "analyze", message: NO_CHUNKS_WARNING });
  const adapter = opts.adapter ?? createAdapter("claude-code", { claude: { model: opts.model } });
  const ex = await extract(ws, system, adapter, {
    refresh: opts.refresh,
    onProgress: (p) => emit({ stage: "extract", message: `추출 ${p.done}/${p.total} (청크 ${p.chunk}: ${p.status})`, done: p.done, total: p.total }),
  });
  if (ex.failed.length) emit({ stage: "extract", message: `경고: 청크 ${ex.failed.length}개 추출 실패. 첫 오류: ${ex.failed[0]!.error}` });
  const m = await merge(ws, system);
  return { request, extract: ex, merge: m };
}

/** CLI analyze의 모드 분기와 "추출 불완전" 판정. 출력과 종료 코드는 호출자가 정한다. */
export async function analyzeSpec(ws: Workspace, system: string, opts: AnalyzeSpecOptions = {}): Promise<AnalyzeSpecResult> {
  const emit = opts.onEvent ?? (() => {});
  if (opts.step === "merge") {
    const m = await merge(ws, system);
    return { mode: "catalog", via: "merge", merge: m, incomplete: m.missingChunks.length > 0 };
  }
  const outcome = await analyze(ws, system);
  if (outcome.mode === "openapi") return { mode: "catalog", via: "openapi", diff: outcome.diff };

  if ((opts.llm ?? "session") === "session" || opts.step === "prepare") {
    let removed: number | null = null;
    if (opts.refresh) {
      removed = await clearExtracted(ws, system);
      emit({ stage: "analyze", message: `기존 추출 결과 ${removed}개를 지웠습니다` });
    }
    const request = await prepare(ws, system);
    if (request.chunks.length === 0) emit({ stage: "analyze", message: NO_CHUNKS_WARNING });
    return { mode: "prepared", request, removed };
  }

  const flow = await runLlmExtraction(ws, system, opts);
  return {
    mode: "catalog", via: "llm", ...flow,
    incomplete: flow.extract.failed.length > 0 || flow.merge.missingChunks.length > 0,
  };
}
