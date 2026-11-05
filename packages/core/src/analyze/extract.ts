import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AnalyzeRequestSchema, ExtractionResultSchema } from "../types.js";
import type { LlmAdapter } from "../llm/adapter.js";
import type { Workspace } from "../workspace.js";
import { EXTRACTED_DIR, extractedFileName, hashText, pruneExtracted, readManifest, writeFileAtomic, writeManifest } from "./prepare.js";
import { buildChunkPrompt } from "./prompt.js";

export interface ExtractProgress { done: number; total: number; chunk: number; status: "written" | "skipped" | "failed" }
export interface ExtractOptions { refresh?: boolean; onProgress?: (p: ExtractProgress) => void }
export interface ExtractResult { total: number; written: number; skipped: number; failed: { chunk: number; error: string }[] }

/**
 * analyze-request.json의 청크마다 어댑터를 호출해 extracted/NNN.json을 쓴다. 실패는 기록하고 계속 간다.
 *
 * 기존 결과는 낡지 않았을 때만 건너뛴다. extracted/manifest.json이 청크 번호별로 추출 당시의 본문 해시를 적어 두고,
 * 지금 청크의 contentHash와 다르면 문서가 바뀐 것이므로 다시 추출한다. 매니페스트에 항목이 없는 파일(세션 모드나
 * 손으로 쓴 것)은 그대로 둔다. `refresh`는 매니페스트를 무시하고 전부 다시 추출한다.
 *
 * 청크는 순차로 처리한다. 동시 실행은 후속 과제이며, 그때는 .tmp 이름에 고유 접미사가 필요하다.
 */
export async function extract(ws: Workspace, system: string, adapter: LlmAdapter, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  await mkdir(ws.file(system, EXTRACTED_DIR), { recursive: true });
  await pruneExtracted(ws, system, request.chunks.length);
  const manifest = await readManifest(ws, system);
  const result: ExtractResult = { total: request.chunks.length, written: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const chunk of request.chunks) {
    const key = extractedFileName(chunk.index).replace(/\.json$/, "");
    const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
    const report = (status: ExtractProgress["status"]) => opts.onProgress?.({ done: ++done, total: result.total, chunk: chunk.index, status });
    const fileExists = await exists(ws.file(system, rel));
    const stale = fileExists && manifest[key] !== undefined && manifest[key] !== chunk.contentHash;
    if (!opts.refresh && fileExists && !stale) { result.skipped += 1; report("skipped"); continue; }
    // 낡은 결과는 재추출이 실패해도 merge에 흘러들지 않도록 먼저 지운다(merge는 "미추출"로 기록한다).
    if (stale) { await rm(ws.file(system, rel), { force: true }); delete manifest[key]; }
    try {
      const text = await readFile(ws.file(system, chunk.file), "utf8");
      const raw = await adapter.extract({ prompt: buildChunkPrompt(text), schema: request.schema });
      const parsed = ExtractionResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`출력이 스키마와 맞지 않습니다: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      await writeFileAtomic(ws.file(system, rel), JSON.stringify({ endpoints: parsed.data.endpoints }, null, 2) + "\n");
      manifest[key] = chunk.contentHash ?? hashText(text);
      await writeManifest(ws, system, manifest);
      result.written += 1; report("written");
    } catch (e) {
      result.failed.push({ chunk: chunk.index, error: (e as Error).message }); report("failed");
    }
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
