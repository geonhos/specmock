import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AnalyzeRequestSchema, ExtractedEndpointSchema, ExtractionResultSchema, type AnalyzeRequest } from "../types.js";
import type { Workspace } from "../workspace.js";
import { EXTRACTED_DIR, extractedFileName, hashText, readManifest, writeFileAtomic, writeManifest, type ExtractManifest } from "./prepare.js";

export interface SubmitExtractionInput {
  index: number;
  /** analyze-request.json의 청크 contentHash. 다르면 그 사이 문서가 다시 분석된 것이다. */
  contentHash: string;
  result: unknown;
}

export interface SubmitError { path: string; message: string }

export type SubmitExtractionResult =
  | { ok: true; file: string }
  | { ok: false; reason: "stale-chunk" | "unknown-chunk" | "invalid"; errors?: SubmitError[] };

export interface SubmitExtractionOptions {
  /** 이미 읽은 analyze-request.json (extract 루프용). */
  request?: AnalyzeRequest;
  /** 메모리의 manifest를 갱신해 그대로 쓴다 (extract 루프용). 없으면 디스크에서 읽는다. */
  manifest?: ExtractManifest;
  /** true면 알 수 없는 키를 버린다(claude-code 어댑터 경로의 기존 동작). 기본은 거부. */
  lenient?: boolean;
}

/** 최상위와 엔드포인트의 알 수 없는 키를 거부한다. 오타(respones 등)를 제출 시점에 돌려주기 위해서다. */
const StrictExtractionSchema = z.strictObject({ endpoints: z.array(ExtractedEndpointSchema.strict()) });

/**
 * 청크 하나의 추출 결과를 검증해 extracted/NNN.json에 원자적으로 쓰고 manifest에 청크 해시를 기록한다.
 * 검증 실패는 예외가 아니라 `ok: false`로 돌려준다(제출자가 고쳐 다시 내는 흐름). 파일 쓰기 실패는 예외.
 */
export async function submitExtraction(
  ws: Workspace,
  system: string,
  input: SubmitExtractionInput,
  opts: SubmitExtractionOptions = {},
): Promise<SubmitExtractionResult> {
  const request = opts.request ?? (await ws.read(system, "analyze-request.json", AnalyzeRequestSchema));
  const chunk = request.chunks.find((c) => c.index === input.index);
  if (!chunk) {
    const range = request.chunks.length ? `0-${request.chunks.length - 1}` : "청크 없음";
    return { ok: false, reason: "unknown-chunk", errors: [{ path: "index", message: `청크 ${input.index}이(가) 없습니다 (${range})` }] };
  }
  // contentHash가 없는 오래된 analyze-request.json은 본문 해시로 비교한다.
  const actual = chunk.contentHash ?? hashText(await readFile(ws.file(system, chunk.file), "utf8"));
  if (input.contentHash !== actual) {
    return { ok: false, reason: "stale-chunk", errors: [{ path: "contentHash", message: "청크 내용이 바뀌었습니다. 청크 목록과 본문을 다시 읽고 추출하세요." }] };
  }
  const parsed = (opts.lenient ? ExtractionResultSchema : StrictExtractionSchema).safeParse(input.result);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.code === "unrecognized_keys" ? `${i.message}: ${i.keys.join(", ")}` : i.message,
      })),
    };
  }
  const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
  const file = ws.file(system, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ endpoints: parsed.data.endpoints }, null, 2) + "\n");
  const manifest = opts.manifest ?? (await readManifest(ws, system));
  manifest[extractedFileName(chunk.index).replace(/\.json$/, "")] = actual;
  await writeManifest(ws, system, manifest);
  return { ok: true, file };
}
