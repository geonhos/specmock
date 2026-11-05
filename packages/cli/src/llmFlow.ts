import { createAdapter, extract, merge, prepare, type AnalyzeRequest, type ExtractResult, type MergeResult, type Workspace } from "@specmock/core";

export interface LlmFlowOptions {
  model?: string;
  refresh?: boolean;
  /** 진행 표시와 경고 출력(항상 stderr로 연결할 것). */
  log: (message: string) => void;
}

/** analyze와 run이 공유하는 문서 입력 흐름: prepare → claude-code extract → merge. */
export async function runLlmAnalyze(
  ws: Workspace,
  system: string,
  opts: LlmFlowOptions,
): Promise<{ request: AnalyzeRequest; extract: ExtractResult; merge: MergeResult }> {
  const request = await prepare(ws, system);
  if (request.chunks.length === 0) opts.log("경고: 추출할 청크가 없습니다 (문서 내용이 비어 있음)");
  const adapter = createAdapter("claude-code", { claude: { model: opts.model } });
  const ex = await extract(ws, system, adapter, {
    refresh: opts.refresh,
    onProgress: (p) => opts.log(`추출 ${p.done}/${p.total} (청크 ${p.chunk}: ${p.status})`),
  });
  if (ex.failed.length) opts.log(`경고: 청크 ${ex.failed.length}개 추출 실패. 첫 오류: ${ex.failed[0]!.error}`);
  const m = await merge(ws, system);
  return { request, extract: ex, merge: m };
}
