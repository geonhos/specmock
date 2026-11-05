import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashText } from "../util/hash.js";
import { SourceSchema, type Source, type SourceInput } from "../types.js";
import type { Workspace } from "../workspace.js";
import { fetchOrigin } from "./fetch.js";
import { detectInteractive, htmlToMarkdown } from "./html.js";
import { maskSecrets } from "./mask.js";
import { dereferenceOpenApi, isOpenApiDocument, parseSpecText, stringifyCycleSafe } from "./openapi.js";
import { pdfToText } from "./pdf.js";

export type InputKind = SourceInput["kind"];

function extOf(origin: string): string {
  return path.extname(origin.split(/[?#]/)[0]).toLowerCase();
}

function isUrl(origin: string): boolean {
  return /^https?:\/\//.test(origin);
}

/**
 * 확장자·content-type·내용으로 종류를 정한다. content-type은 URL일 때만 온다.
 * 확장자나 content-type이 종류를 말해 주면 그것을 따르고, 내용 스니핑(openapi 키, `<html`)은 둘 다 없을 때만 쓴다.
 * 그래야 `openapi: 3.0.0` 예시를 품은 README.md가 OpenAPI로 오인되지 않는다.
 */
export function detectKind(origin: string, text: string, contentType = ""): InputKind {
  const ext = extOf(origin);
  if (contentType === "application/pdf" || ext === ".pdf") return "pdf";
  const looksStructured = ext === ".json" || ext === ".yaml" || ext === ".yml" || /json|yaml/.test(contentType) || text.trimStart().startsWith("{");
  if (looksStructured) {
    try {
      if (isOpenApiDocument(parseSpecText(text))) return "openapi";
    } catch {
      // 파싱 실패는 아래 규칙으로 넘긴다.
    }
  }
  if (contentType === "text/markdown" || ext === ".md" || ext === ".markdown") return "markdown";
  if (contentType === "text/html" || ext === ".html" || ext === ".htm") return "html";
  // 여기부터는 확장자·content-type이 없거나 모호한 경우(.txt, text/plain, 확장자 없는 URL 등)의 내용 스니핑.
  if (/^\s*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(text.slice(0, 2000))) return "openapi";
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 500);
  if (/^<(!doctype|html)/i.test(head)) return "html";
  if (isUrl(origin) && contentType === "" && head.startsWith("<")) return "html";
  return "text";
}

interface RawOrigin { bytes: Uint8Array; contentType: string; charset: string }

async function readOrigin(origin: string): Promise<RawOrigin> {
  if (isUrl(origin)) {
    const f = await fetchOrigin(origin);
    return { bytes: f.bytes, contentType: f.contentType, charset: f.charset };
  }
  return { bytes: new Uint8Array(await readFile(origin)), contentType: "", charset: "" };
}

/** 헤더에 charset이 없을 때 앞 1,024바이트에서 <meta charset> / <meta http-equiv content="...charset=..."> 를 찾는다. */
function sniffMetaCharset(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.match(/<meta[^>]*charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1]?.toLowerCase() ?? "";
}

/** charset 라벨을 TextDecoder가 모르면 utf-8로 떨어진다. */
function decodeText(bytes: Uint8Array, charset: string): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // 알 수 없는 라벨 → utf-8
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** 첫 번째 `# 제목` 줄. 펜스 코드 블록 안의 `#`(셸 주석 등)은 건너뛴다. */
function firstHeading(markdown: string): string | undefined {
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return undefined;
}

export async function ingestOne(origin: string): Promise<SourceInput> {
  const { bytes, contentType, charset } = await readOrigin(origin);
  const fetchedAt = new Date().toISOString();
  const isPdf = contentType === "application/pdf" || extOf(origin) === ".pdf";
  const mayBeHtml = contentType === "" || contentType === "text/html";
  const text = isPdf ? "" : decodeText(bytes, charset || (mayBeHtml ? sniffMetaCharset(bytes) : ""));
  const kind = detectKind(origin, text, contentType);
  const base = { kind, origin, fetchedAt } as const;

  // 토큰처럼 보이는 값은 source.json에 남기지 않는다(설계 §6). 모든 종류에서 해시는 마스킹된 내용 기준이다.
  if (kind === "openapi") {
    const doc = await dereferenceOpenApi(origin, parseSpecText(text));
    const content = maskSecrets(stringifyCycleSafe(doc));
    return { ...base, contentHash: hashText(content), content };
  }
  if (kind === "pdf") {
    const content = maskSecrets(await pdfToText(bytes));
    return { ...base, contentHash: hashText(content), content, title: firstHeading(content) };
  }
  if (kind === "html") {
    const { title, markdown } = htmlToMarkdown(text, origin);
    const content = maskSecrets(markdown);
    const { reasons } = detectInteractive(text, content.length);
    return {
      ...base, contentHash: hashText(content), content, title: title || undefined,
      ...(reasons.length ? { harvestCandidate: { reasons } } : {}),
    };
  }
  const content = maskSecrets(text);
  return { ...base, contentHash: hashText(content), content, title: firstHeading(content) };
}

export interface IngestOptions {
  /** true면 source.json에 같은 origin이 있어도 다시 읽는다. */
  refresh?: boolean;
  /** 수확(ego-browser) 정책. 아직 받기만 하고 사용하지 않는다 — 후속 태스크에서 ego-browser 연결 시 동작한다. */
  harvest?: "auto" | "always" | "never";
  /** 입력 하나를 읽을 때마다 호출. CLI 진행 표시용. */
  onLog?: (message: string) => void;
}

export async function ingest(ws: Workspace, system: string, origins: string[], opts: IngestOptions = {}): Promise<string> {
  if (origins.length === 0) throw new Error("입력 파일 또는 URL을 하나 이상 지정하세요.");
  const prev: Source | null = !opts.refresh && (await ws.exists(system, "source.json"))
    ? await ws.read(system, "source.json", SourceSchema)
    : null;
  const cached = new Map((prev?.inputs ?? []).map((i) => [i.origin, i]));
  const inputs: SourceInput[] = [];
  for (const origin of origins) {
    const hit = cached.get(origin);
    if (hit) {
      opts.onLog?.(`${origin}: 캐시 재사용 (${hit.fetchedAt}). 다시 읽으려면 --refresh`);
      inputs.push(hit);
      continue;
    }
    inputs.push(await ingestOne(origin));
    opts.onLog?.(`${origin}: ${inputs[inputs.length - 1].kind} ${inputs[inputs.length - 1].content.length.toLocaleString()}자`);
  }
  return await ws.write(system, "source.json", SourceSchema, { system, inputs });
}
