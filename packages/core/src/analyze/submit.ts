import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AnalyzeRequestSchema, ExtractedEndpointSchema, ExtractedParamSchema, ExtractedResponseSchema, ExtractionResultSchema, type AnalyzeRequest } from "../types.js";
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

/**
 * 추출 스키마의 모든 중첩 객체에서 알 수 없는 키를 거부한다. 오타(respones, exampel, methd 등)를 제출 시점에 돌려주기 위해서다.
 * JSON Schema·example 같은 자유 형식 값(사용자 데이터)의 안쪽은 검사하지 않는다.
 */
const StrictParam = ExtractedParamSchema.strict();
const StrictEndpoint = ExtractedEndpointSchema.extend({
  pathParams: z.array(StrictParam).default([]),
  queryParams: z.array(StrictParam).default([]),
  headers: z.array(StrictParam).default([]),
  responses: z.array(ExtractedResponseSchema.strict()),
  inferred: z.strictObject({ method: z.boolean().default(false), path: z.boolean().default(false) }).default({ method: false, path: false }),
}).strict();
const StrictExtractionSchema = z.strictObject({ endpoints: z.array(StrictEndpoint) });

/**
 * 워크스페이스+system 단위 프로세스 내 직렬화(Promise 체인). manifest 읽기-수정-쓰기 경합을 막는다.
 * 범위: 한 프로세스 안. 서로 다른 프로세스 간 동시 쓰기는 보호하지 않는다.
 */
const manifestLocks = new Map<string, Promise<unknown>>();
async function withManifestLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  manifestLocks.set(key, tail);
  try { return await run; } finally { if (manifestLocks.get(key) === tail) manifestLocks.delete(key); }
}

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
      // unrecognized_keys는 path가 객체 자리라 키가 안 보이므로, path에 키를 붙이고 message는 zod 그대로 둔다.
      errors: parsed.error.issues.flatMap((i) =>
        i.code === "unrecognized_keys"
          ? i.keys.map((k) => ({ path: [...i.path, k].join("."), message: i.message }))
          : [{ path: i.path.join("."), message: i.message }]),
    };
  }
  const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
  const file = ws.file(system, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ endpoints: parsed.data.endpoints }, null, 2) + "\n");
  const key = extractedFileName(chunk.index).replace(/\.json$/, "");
  await withManifestLock(`${ws.file(system, EXTRACTED_DIR)}`, async () => {
    // 잠금 안에서 다시 읽어 다른 제출의 항목을 덮어쓰지 않는다. extract()의 메모리 manifest는 같은 잠금 안에서 갱신해 쓴다.
    const manifest = opts.manifest ?? (await readManifest(ws, system));
    manifest[key] = actual;
    await writeManifest(ws, system, manifest);
  });
  return { ok: true, file };
}
