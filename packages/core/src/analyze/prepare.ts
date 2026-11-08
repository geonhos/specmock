import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { withSystemLock } from "../workspaceLock.js";
import { DEFAULT_CHUNK, splitIntoChunks, type ChunkOptions } from "./chunk.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { EXTRACTION_PROMPT } from "./prompt.js";

export const CHUNKS_DIR = "chunks";
export const EXTRACTED_DIR = "extracted";
/** extracted/ 안의 청크 해시 기록. 형태: { "000": "<sha256>" }. 청크 파일명 규칙(^\d{3,}\.json$)과 겹치지 않는다. */
export const EXTRACT_MANIFEST = "manifest.json";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const pad3 = (n: number): string => String(n).padStart(3, "0");

export function chunkFileName(index: number): string {
  return `${pad3(index)}.md`;
}
export function extractedFileName(index: number): string {
  return `${pad3(index)}.json`;
}

/** 헤딩 줄에 들어갈 제목·라벨은 한 줄이어야 한다(줄바꿈이 있으면 헤딩이 깨진다). */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * 본문 뒤에 수확 결과를 섹션으로 이어 붙인다. 청크 분할이 헤딩을 기준으로 하므로 "## [수확] ..." 헤딩을 쓴다.
 * 내용이 비어 있는 수확 항목은 건너뛴다.
 */
export function documentText(input: SourceInput): string {
  const parts = [input.content.trimEnd()];
  for (const p of input.harvested?.pages ?? []) {
    const content = p.content.trim();
    if (!content) continue;
    parts.push(`## [수확] 페이지: ${oneLine(p.title) || p.url}\n\n<!-- ${p.url} -->\n\n${content}`);
  }
  for (const it of input.harvested?.interactions ?? []) {
    const content = it.content.trim();
    if (!content) continue;
    parts.push(`## [수확] ${it.type}: ${oneLine(it.label)}\n\n${content}`);
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

  // 먼저 메모리에서 청크를 모두 만든다. 분할 옵션이 잘못돼 던지더라도 기존 chunks/ 는 건드리지 않는다.
  const chunks: ChunkInfo[] = [];
  const texts: string[] = [];
  for (const { input, inputIndex } of docInputs) {
    for (const c of splitIntoChunks(documentText(input), chunkOpts)) {
      const index = chunks.length;
      const file = path.posix.join(CHUNKS_DIR, chunkFileName(index));
      // 헤딩 없는 텍스트/PDF나 첫 헤딩 앞의 긴 구간은 heading이 ""다. 요청서에는 문서 제목이나 출처를 대신 적는다.
      const heading = c.heading || input.title || input.origin;
      const text = c.text.endsWith("\n") ? c.text : c.text + "\n";
      chunks.push({ index, file, inputIndex, heading, chars: c.text.length, contentHash: hashText(text) });
      texts.push(text);
    }
  }

  const chunksDir = ws.file(system, CHUNKS_DIR);
  await rm(chunksDir, { recursive: true, force: true });
  await mkdir(chunksDir, { recursive: true });
  await mkdir(ws.file(system, EXTRACTED_DIR), { recursive: true });
  for (let i = 0; i < chunks.length; i++) await ws.writeText(system, chunks[i].file, texts[i]);

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

export type ExtractManifest = Record<string, string>;

/** 없거나 깨졌으면 빈 매니페스트로 본다(그 경우 파일은 손으로 쓴 것으로 취급돼 유지된다). */
export async function readManifest(ws: Workspace, system: string): Promise<ExtractManifest> {
  try {
    const raw: unknown = JSON.parse(await readFile(ws.file(system, path.posix.join(EXTRACTED_DIR, EXTRACT_MANIFEST)), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: ExtractManifest = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export async function writeManifest(ws: Workspace, system: string, manifest: ExtractManifest): Promise<void> {
  await writeFileAtomic(ws.file(system, path.posix.join(EXTRACTED_DIR, EXTRACT_MANIFEST)), JSON.stringify(manifest, null, 2) + "\n");
}

/** 같은 디렉터리의 .tmp에 쓰고 rename한다. 중간에 죽어도 반쯤 쓴 파일은 남지 않는다. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`; // 동시 쓰기끼리 tmp를 공유하지 않는다
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** 현재 request의 청크 수보다 큰 번호의 extracted 파일과 매니페스트 항목은 이전 prepare의 잔재다. 지운다. */
export async function pruneExtracted(ws: Workspace, system: string, chunkCount: number): Promise<string[]> {
  return withSystemLock(ws, system, () => pruneExtractedUnlocked(ws, system, chunkCount));
}

async function pruneExtractedUnlocked(ws: Workspace, system: string, chunkCount: number): Promise<string[]> {
  const dir = ws.file(system, EXTRACTED_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const n of names.sort()) {
    const m = n.match(/^(\d{3,})\.json$/);
    if (m && Number(m[1]) >= chunkCount) {
      await rm(path.join(dir, n), { force: true });
      removed.push(n);
    }
  }
  if (names.includes(EXTRACT_MANIFEST)) {
    const manifest = await readManifest(ws, system);
    const kept = Object.fromEntries(Object.entries(manifest).filter(([k]) => Number(k) < chunkCount));
    if (Object.keys(kept).length !== Object.keys(manifest).length) await writeManifest(ws, system, kept);
  }
  return removed;
}
