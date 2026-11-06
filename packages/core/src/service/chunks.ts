import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { EXTRACTED_DIR, extractedFileName, hashText, readManifest } from "../analyze/prepare.js";
import { AnalyzeRequestSchema, type AnalyzeRequest } from "../types.js";
import type { Workspace } from "../workspace.js";

export interface ChunkSummary { index: number; heading: string; chars: number; contentHash: string; done: boolean }
export interface ChunkContent { index: number; heading: string; contentHash: string; content: string }

/**
 * 청크 목록(본문 없음)과 추출 완료 여부. done은 extracted/NNN.json이 있고 manifest의 해시가 지금 청크와 같을 때만 true.
 * manifest가 없는 파일(손으로 쓴 세션 결과)은 문서와 맞는지 알 수 없으므로 false.
 */
export async function summarizeChunks(ws: Workspace, system: string, request?: AnalyzeRequest): Promise<ChunkSummary[]> {
  const req = request ?? (await ws.read(system, "analyze-request.json", AnalyzeRequestSchema));
  const manifest = await readManifest(ws, system);
  const out: ChunkSummary[] = [];
  for (const c of req.chunks) {
    const contentHash = c.contentHash ?? hashText(await readFile(ws.file(system, c.file), "utf8"));
    const name = extractedFileName(c.index);
    const exists = await access(ws.file(system, path.posix.join(EXTRACTED_DIR, name))).then(() => true, () => false);
    out.push({ index: c.index, heading: c.heading, chars: c.chars, contentHash, done: exists && manifest[name.replace(/\.json$/, "")] === contentHash });
  }
  return out;
}

export async function getChunk(ws: Workspace, system: string, index: number): Promise<ChunkContent> {
  const req = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  const c = req.chunks.find((x) => x.index === index);
  if (!c) throw new Error(`청크 ${index}이(가) 없습니다 (${req.chunks.length ? `0-${req.chunks.length - 1}` : "청크 없음"}).`);
  const content = await readFile(ws.file(system, c.file), "utf8");
  return { index: c.index, heading: c.heading, contentHash: c.contentHash ?? hashText(content), content };
}
