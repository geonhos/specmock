// packages/core/src/verify/contracts.ts
import type { Ajv } from "ajv";
import type { Contract } from "../types.js";
import { makeAjv } from "../util/ajv.js";

export interface ContractRunOptions {
  /** 모든 요청에 붙일 헤더. 같은 이름(대소문자 무시)의 contract 헤더보다 우선한다. */
  headers?: Record<string, string>;
  /** 요청당 제한(ms). 없으면 제한 없음(verify). */
  timeoutMs?: number;
  /** 사용자 취소. abort되면 failure가 아니라 예외로 거부한다. */
  signal?: AbortSignal;
  /** 여러 contract에 하나를 재사용한다. 없으면 새로 만든다. */
  ajv?: Ajv;
  /** 이 바이트 수를 넘는 바디는 kind "truncated"(본문 버림). 없으면 제한 없음. */
  maxBytes?: number;
  /** contract의 경로·쿼리 대신 쓸 값(record의 params 적용 결과). */
  path?: string;
  query?: Record<string, string>;
}

export type BodyKind = "json" | "raw" | "empty" | "truncated";

export interface ContractRun {
  url: string;
  /** 응답을 못 받았으면 null. */
  status: number | null;
  /** 응답 헤더 중 content-type·content-length만. */
  headers: Record<string, string>;
  kind: BodyKind | null;
  /** json: 파싱 값 · raw: { raw, contentType } · empty: null · truncated: undefined. */
  body: unknown;
  bytes: number;
  /** status가 기대와 같고 스키마가 있을 때의 바디 오류(비JSON 포함). */
  schemaErrors: string[];
  /** verify의 ContractResult.errors와 같은 문구·순서. */
  errors: string[];
  failure: { kind: "timeout" | "network"; message: string } | null;
}

const KEEP_HEADERS = ["content-type", "content-length"];

/** baseUrl 경로 뒤에 path를 붙인다. `new URL(path, base)`는 base의 `/v2`를 지우므로 쓰지 않는다. */
export function joinUrl(baseUrl: string, p: string, query: Record<string, string> = {}): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") + (p.startsWith("/") ? p : `/${p}`);
  url.search = "";
  url.hash = "";
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** 키를 소문자로 맞춰 합친다. 뒤의 것이 이긴다. */
export function mergeHeaders(...parts: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k.toLowerCase()] = v;
  return out;
}

export async function runContract(baseUrl: string, c: Contract, opts: ContractRunOptions = {}): Promise<ContractRun> {
  const url = joinUrl(baseUrl, opts.path ?? c.request.path, opts.query ?? c.request.query);
  const errors: string[] = [];
  const schemaErrors: string[] = [];
  const run: ContractRun = { url: url.toString(), status: null, headers: {}, kind: null, body: undefined, bytes: 0, schemaErrors, errors, failure: null };
  let validate: ReturnType<Ajv["compile"]> | null = null;
  if (c.expect.schema) { try { validate = (opts.ajv ?? makeAjv()).compile(c.expect.schema); } catch (e) { errors.push(`schema: ${(e as Error).message}`); } }
  const signals = [opts.signal, opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter((s): s is AbortSignal => s !== undefined);
  try {
    const res = await fetch(url, {
      method: c.request.method,
      headers: mergeHeaders(c.request.body !== null ? { "content-type": "application/json" } : {}, c.request.headers, opts.headers ?? {}),
      body: c.request.body !== null ? JSON.stringify(c.request.body) : undefined,
      ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
    });
    run.status = res.status;
    for (const h of KEEP_HEADERS) { const v = res.headers.get(h); if (v !== null) run.headers[h] = v; }
    if (res.status !== c.expect.status) errors.push(`status: expected ${c.expect.status}, got ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    run.bytes = buf.byteLength;
    // TextDecoder는 res.text()처럼 UTF-8 BOM을 지운다.
    const text = opts.maxBytes !== undefined && run.bytes > opts.maxBytes ? null : new TextDecoder().decode(buf);
    if (text === null) run.kind = "truncated";
    else if (text === "") { run.kind = "empty"; run.body = null; }
    else {
      try { run.body = JSON.parse(text); run.kind = "json"; }
      catch { run.kind = "raw"; run.body = { raw: text, contentType: run.headers["content-type"] ?? "" }; }
    }
    if (validate && res.status === c.expect.status && text !== null) {
      if (run.kind === "json") {
        if (!validate(run.body)) schemaErrors.push(...(validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()));
      } else schemaErrors.push(`body is not JSON: ${text.slice(0, 200)}`);
      errors.push(...schemaErrors);
    }
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const err = e as Error & { cause?: { code?: string; message?: string } };
    errors.push(`request failed: ${err.message}`);
    run.failure = err.name === "TimeoutError"
      ? { kind: "timeout", message: err.message }
      : { kind: "network", message: err.cause?.code ?? err.cause?.message ?? err.message };
  }
  return run;
}
