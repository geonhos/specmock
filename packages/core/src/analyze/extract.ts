import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AnalyzeRequestSchema } from "../types.js";
import type { LlmAdapter } from "../llm/adapter.js";
import { createUsageSink } from "../llm/usageLog.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import { EXTRACTED_DIR, extractedFileName, hashText, pruneExtracted, readManifest, writeManifest } from "./prepare.js";
import { buildChunkPrompt } from "./prompt.js";
import { submitExtraction } from "./submit.js";

export interface ExtractProgress { done: number; total: number; chunk: number; status: "written" | "skipped" | "failed" }
export interface ExtractOptions { refresh?: boolean; onProgress?: (p: ExtractProgress) => void; signal?: AbortSignal }
export interface ExtractResult { total: number; written: number; skipped: number; failed: { chunk: number; error: string }[] }

/**
 * analyze-request.json의 청크마다 어댑터를 호출해 extracted/NNN.json을 쓴다. 실패는 기록하고 계속 간다.
 *
 * 기존 결과는 낡지 않았을 때만 건너뛴다. extracted/manifest.json이 청크 번호별로 추출 당시의 본문 해시를 적어 두고,
 * 지금 청크의 contentHash와 다르면 문서가 바뀐 것이므로 다시 추출한다. 매니페스트에 항목이 없는 파일(세션 모드나
 * 손으로 쓴 것)은 그대로 둔다. `refresh`는 매니페스트를 무시하고 전부 다시 추출한다.
 *
 * 청크는 순차로 처리한다. 쓰기 경로(submitExtraction)는 고유 tmp 이름과 시스템 단위 파일 잠금(withSystemLock)으로 동시 제출에도 안전하다.
 * 낡은 결과 삭제와 manifest 정리도 같은 잠금 안에서 디스크에 반영한다.
 */
export async function extract(ws: Workspace, system: string, adapter: LlmAdapter, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  await mkdir(ws.file(system, EXTRACTED_DIR), { recursive: true });
  await pruneExtracted(ws, system, request.chunks.length);
  const manifest = await readManifest(ws, system);
  const result: ExtractResult = { total: request.chunks.length, written: 0, skipped: 0, failed: [] };
  let done = 0;
  const usage = createUsageSink(ws.dir(system));
  for (const chunk of request.chunks) {
    opts.signal?.throwIfAborted();
    const key = extractedFileName(chunk.index).replace(/\.json$/, "");
    const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
    const report = (status: ExtractProgress["status"]) => opts.onProgress?.({ done: ++done, total: result.total, chunk: chunk.index, status });
    const fileExists = await exists(ws.file(system, rel));
    let text: string | undefined;
    const fail = (e: unknown) => { result.failed.push({ chunk: chunk.index, error: (e as Error).message }); report("failed"); };
    const load = async () => (text ??= await readFile(ws.file(system, chunk.file), "utf8"));
    let stale = false;
    try {
      // contentHash가 없는 analyze-request.json은 본문 해시로 비교한다(매번 재추출 방지). 본문은 필요할 때만 읽는다.
      if (fileExists && manifest[key] !== undefined) stale = manifest[key] !== (chunk.contentHash ?? hashText(await load()));
    } catch (e) { fail(e); continue; }
    // 낡은 결과는 재추출이 실패해도 merge에 흘러들지 않도록 먼저 지운다(merge는 "미추출"로 기록한다).
    if (stale) {
      await withSystemLock(ws, system, async () => {
        await rm(ws.file(system, rel), { force: true });
        const disk = await readManifest(ws, system);   // 다른 프로세스가 쓴 항목을 덮어쓰지 않도록 잠금 안에서 다시 읽는다
        if (key in disk) { delete disk[key]; await writeManifest(ws, system, disk); }
      });
      delete manifest[key];
    }
    if (!opts.refresh && fileExists && !stale) { result.skipped += 1; report("skipped"); continue; }
    try {
      const body = await load();
      const detail = `chunk ${String(chunk.index).padStart(3, "0")} · ${chunk.heading}`;
      const raw = await adapter.complete({
        prompt: buildChunkPrompt(body), schema: request.schema, signal: opts.signal,
        onUsage: (u) => usage.record({ ...u, stage: "extract", detail }),
      }).finally(() => usage.flush());
      const r = await submitExtraction(
        ws, system,
        { index: chunk.index, contentHash: chunk.contentHash ?? hashText(body), result: raw },
        { request, manifest, lenient: true },
      );
      if (!r.ok) {
        const first = r.errors?.[0];
        throw new Error(`출력이 스키마와 맞지 않습니다: ${first?.path ?? ""} ${first?.message ?? r.reason}`);
      }
      result.written += 1; report("written");
    } catch (e) {
      if (opts.signal?.aborted) throw e;   // 취소는 실패 청크가 아니다
      fail(e);
    }
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
