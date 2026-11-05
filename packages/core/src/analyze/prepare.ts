import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  AnalyzeRequestSchema,
  SourceSchema,
  extractionJsonSchema,
  type AnalyzeRequest,
  type ChunkInfo,
  type SourceInput,
} from "../types.js";
import type { Workspace } from "../workspace.js";
import { DEFAULT_CHUNK, splitIntoChunks, type ChunkOptions } from "./chunk.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { EXTRACTION_PROMPT } from "./prompt.js";

export const CHUNKS_DIR = "chunks";
export const EXTRACTED_DIR = "extracted";

export function chunkFileName(index: number): string {
  return `${String(index).padStart(3, "0")}.md`;
}
export function extractedFileName(index: number): string {
  return `${String(index).padStart(3, "0")}.json`;
}

/** 본문 뒤에 수확 결과를 섹션으로 이어 붙인다. 청크 분할이 헤딩을 기준으로 하므로 "## [수확] ..." 헤딩을 쓴다. */
export function documentText(input: SourceInput): string {
  const parts = [input.content.trimEnd()];
  for (const p of input.harvested?.pages ?? []) {
    parts.push(`## [수확] 페이지: ${p.title || p.url}\n\n<!-- ${p.url} -->\n\n${p.content.trim()}`);
  }
  for (const it of input.harvested?.interactions ?? []) {
    parts.push(`## [수확] ${it.type}: ${it.label}\n\n${it.content.trim()}`);
  }
  return parts.join("\n\n") + "\n";
}

export function needsLlm(input: SourceInput): boolean {
  return input.kind !== "openapi";
}

/**
 * 비구조 입력을 청크 파일(`chunks/NNN.md`)로 쪼개고, 프롬프트·출력 스키마와 함께 `analyze-request.json`에 적는다.
 * 청크 번호는 입력을 가로질러 0부터 이어지고, 이전 prepare의 `chunks/`는 통째로 지운다.
 */
export async function prepare(ws: Workspace, system: string, chunkOpts: ChunkOptions = DEFAULT_CHUNK): Promise<AnalyzeRequest> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const docInputs = source.inputs.map((input, inputIndex) => ({ input, inputIndex })).filter(({ input }) => needsLlm(input));
  if (docInputs.length === 0) {
    throw new Error("LLM 추출이 필요한 입력이 없습니다. OpenAPI만 있으면 specmock analyze <system>으로 충분합니다.");
  }
  const openapiFeatures = source.inputs
    .filter((i) => i.kind === "openapi")
    .reduce((n, i) => n + analyzeOpenApiDocument(JSON.parse(i.content)).length, 0);

  const chunksDir = ws.file(system, CHUNKS_DIR);
  await rm(chunksDir, { recursive: true, force: true });
  await mkdir(chunksDir, { recursive: true });

  const chunks: ChunkInfo[] = [];
  for (const { input, inputIndex } of docInputs) {
    for (const c of splitIntoChunks(documentText(input), chunkOpts)) {
      const index = chunks.length;
      const file = path.posix.join(CHUNKS_DIR, chunkFileName(index));
      await ws.writeText(system, file, c.text.endsWith("\n") ? c.text : c.text + "\n");
      // 헤딩 없는 텍스트/PDF나 첫 헤딩 앞의 긴 구간은 heading이 ""다. 요청서에는 문서 제목이나 출처를 대신 적는다.
      const heading = c.heading || input.title || input.origin;
      chunks.push({ index, file, inputIndex, heading, chars: c.text.length });
    }
  }

  const request: AnalyzeRequest = {
    system,
    createdAt: new Date().toISOString(),
    prompt: EXTRACTION_PROMPT,
    schema: extractionJsonSchema(),
    chunks,
    openapiFeatures,
  };
  await ws.write(system, "analyze-request.json", AnalyzeRequestSchema, request);
  return request;
}

/** 현재 request의 청크 수보다 큰 번호의 extracted 파일은 이전 prepare의 잔재다. 지운다. */
export async function pruneExtracted(ws: Workspace, system: string, chunkCount: number): Promise<string[]> {
  const dir = ws.file(system, EXTRACTED_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const n of names.sort()) {
    const m = n.match(/^(\d{3})\.json$/);
    if (m && Number(m[1]) >= chunkCount) {
      await rm(path.join(dir, n), { force: true });
      removed.push(n);
    }
  }
  return removed;
}
