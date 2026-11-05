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

const TEXT_DECODER = new TextDecoder("utf-8");

function extOf(origin: string): string {
  return path.extname(origin.split(/[?#]/)[0]).toLowerCase();
}

/** 확장자·content-type·내용으로 종류를 정한다. content-type은 URL일 때만 온다. */
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
  if (/^\s*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(text.slice(0, 2000))) return "openapi";
  if (contentType === "text/markdown" || ext === ".md" || ext === ".markdown") return "markdown";
  if (contentType === "text/html" || ext === ".html" || ext === ".htm" || /^\s*<(!doctype|html)/i.test(text.slice(0, 500))) return "html";
  if (/^https?:\/\//.test(origin) && contentType === "") return "html";
  return "text";
}

async function readOrigin(origin: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (/^https?:\/\//.test(origin)) {
    const f = await fetchOrigin(origin);
    return { bytes: f.bytes, contentType: f.contentType };
  }
  return { bytes: new Uint8Array(await readFile(origin)), contentType: "" };
}

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export async function ingestOne(origin: string): Promise<SourceInput> {
  const { bytes, contentType } = await readOrigin(origin);
  const fetchedAt = new Date().toISOString();
  const text = contentType === "application/pdf" || extOf(origin) === ".pdf" ? "" : TEXT_DECODER.decode(bytes);
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
