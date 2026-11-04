import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashText } from "../util/hash.js";
import { SourceSchema, type SourceInput } from "../types.js";
import type { Workspace } from "../workspace.js";
import { dereferenceOpenApi, isOpenApiDocument, parseSpecText, stringifyCycleSafe } from "./openapi.js";

export type InputKind = SourceInput["kind"];

export function detectKind(origin: string, text: string): InputKind {
  const ext = path.extname(origin.split(/[?#]/)[0]).toLowerCase();
  if (ext === ".json" || ext === ".yaml" || ext === ".yml" || text.trimStart().startsWith("{")) {
    try {
      if (isOpenApiDocument(parseSpecText(text))) return "openapi";
    } catch {
      // 파싱 실패는 아래 규칙으로 넘긴다.
    }
  }
  if (/^\s*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(text.slice(0, 2000))) return "openapi";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".pdf") return "pdf";
  if (ext === ".html" || ext === ".htm" || /^https?:\/\//.test(origin)) return "html";
  return "text";
}

async function readOrigin(origin: string): Promise<string> {
  if (/^https?:\/\//.test(origin)) {
    const res = await fetch(origin, {
      headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${origin} 요청 실패: HTTP ${res.status}`);
    return await res.text();
  }
  return await readFile(origin, "utf8");
}

export async function ingestOne(origin: string): Promise<SourceInput> {
  const raw = await readOrigin(origin);
  const kind = detectKind(origin, raw);
  if (kind !== "openapi") {
    throw new Error(`${origin}: '${kind}' 입력은 Phase 1B에서 지원합니다. 지금은 OpenAPI(json/yaml)만 가능합니다.`);
  }
  const parsed = parseSpecText(raw);
  const doc = await dereferenceOpenApi(origin, parsed);
  const content = stringifyCycleSafe(doc);
  return { kind, origin, fetchedAt: new Date().toISOString(), contentHash: hashText(content), content };
}

export async function ingest(ws: Workspace, system: string, origins: string[]): Promise<string> {
  if (origins.length === 0) throw new Error("입력 파일 또는 URL을 하나 이상 지정하세요.");
  const inputs: SourceInput[] = [];
  for (const origin of origins) inputs.push(await ingestOne(origin));
  return await ws.write(system, "source.json", SourceSchema, { system, inputs });
}
