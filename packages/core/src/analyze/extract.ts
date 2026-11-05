import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalyzeRequestSchema, ExtractionResultSchema } from "../types.js";
import type { LlmAdapter } from "../llm/adapter.js";
import type { Workspace } from "../workspace.js";
import { EXTRACTED_DIR, extractedFileName, pruneExtracted } from "./prepare.js";
import { buildChunkPrompt } from "./prompt.js";

export interface ExtractProgress { done: number; total: number; chunk: number; status: "written" | "skipped" | "failed" }
export interface ExtractOptions { refresh?: boolean; onProgress?: (p: ExtractProgress) => void }
export interface ExtractResult { total: number; written: number; skipped: number; failed: { chunk: number; error: string }[] }

/** analyze-request.json의 청크마다 어댑터를 호출해 extracted/NNN.json을 쓴다. 실패는 기록하고 계속 간다. */
export async function extract(ws: Workspace, system: string, adapter: LlmAdapter, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  await mkdir(ws.file(system, EXTRACTED_DIR), { recursive: true });
  await pruneExtracted(ws, system, request.chunks.length);
  const result: ExtractResult = { total: request.chunks.length, written: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const chunk of request.chunks) {
    const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
    const report = (status: ExtractProgress["status"]) => opts.onProgress?.({ done: ++done, total: result.total, chunk: chunk.index, status });
    if (!opts.refresh && (await exists(ws.file(system, rel)))) { result.skipped += 1; report("skipped"); continue; }
    try {
      const text = await readFile(ws.file(system, chunk.file), "utf8");
      const raw = await adapter.extract({ prompt: buildChunkPrompt(text), schema: request.schema });
      const parsed = ExtractionResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`출력이 스키마와 맞지 않습니다: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      await writeAtomic(ws.file(system, rel), JSON.stringify({ endpoints: parsed.data.endpoints }, null, 2) + "\n");
      result.written += 1; report("written");
    } catch (e) {
      result.failed.push({ chunk: chunk.index, error: (e as Error).message }); report("failed");
    }
  }
  return result;
}

/** 같은 디렉터리의 .tmp에 쓰고 rename한다. 중간에 죽어도 반쯤 쓴 NNN.json은 남지 않는다. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
