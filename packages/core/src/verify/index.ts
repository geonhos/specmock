import type { Ajv } from "ajv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readLock } from "../generate/lock.js";
import { ContractSchema, type Contract } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { startMock } from "./server.js";

export interface ContractResult {
  featureId: string;
  name: string;
  passed: boolean;
  expectedStatus: number;
  actualStatus: number | null;
  errors: string[];
}

export interface VerifyResult {
  mockDir: string;
  total: number;
  passed: number;
  failed: number;
  results: ContractResult[];
}

export async function loadContracts(mockDir: string): Promise<Contract[]> {
  const dir = path.join(mockDir, "contracts");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  const out: Contract[] = [];
  for (const f of files) {
    const arr = JSON.parse(await readFile(path.join(dir, f), "utf8")) as unknown[];
    for (const c of arr) out.push(ContractSchema.parse(c));
  }
  return out;
}

async function runContract(base: string, ajv: Ajv, c: Contract): Promise<ContractResult> {
  const url = new URL(c.request.path, base);
  for (const [k, v] of Object.entries(c.request.query)) url.searchParams.set(k, v);
  const errors: string[] = [];
  let actualStatus: number | null = null;

  // 스키마 컴파일 실패는 요청 실패와 구분해서 보고한다.
  let validate: ReturnType<Ajv["compile"]> | null = null;
  if (c.expect.schema) {
    try {
      validate = ajv.compile(c.expect.schema);
    } catch (e) {
      errors.push(`schema: ${(e as Error).message}`);
    }
  }

  try {
    const res = await fetch(url, {
      method: c.request.method,
      headers: { ...(c.request.body !== null ? { "content-type": "application/json" } : {}), ...c.request.headers },
      body: c.request.body !== null ? JSON.stringify(c.request.body) : undefined,
    });
    actualStatus = res.status;
    if (res.status !== c.expect.status) errors.push(`status: expected ${c.expect.status}, got ${res.status}`);
    if (validate && res.status === c.expect.status) {
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { errors.push(`body is not JSON: ${text.slice(0, 200)}`); }
      if (body !== undefined && !validate(body)) {
        errors.push(...(validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()));
      }
    }
  } catch (e) {
    errors.push(`request failed: ${(e as Error).message}`);
  }
  return { featureId: c.featureId, name: c.name, passed: errors.length === 0, expectedStatus: c.expect.status, actualStatus, errors };
}

export interface VerifyOptions {
  /** 오래 걸리는 단계(npm install 등)를 알려주는 콜백. */
  onLog?: (message: string) => void;
}

export async function verify(mockDir: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const lock = await readLock(mockDir);
  if (!lock) throw new Error(`${mockDir}에 specmock.lock.json이 없습니다. 먼저 specmock generate를 실행하세요.`);
  const contracts = await loadContracts(mockDir);
  const server = await startMock(mockDir, lock, { onLog: opts.onLog });
  const ajv = makeAjv();
  const results: ContractResult[] = [];
  try {
    for (const c of contracts) results.push(await runContract(`http://127.0.0.1:${server.port}`, ajv, c));
  } finally {
    await server.stop();
  }
  const passed = results.filter((r) => r.passed).length;
  return { mockDir, total: results.length, passed, failed: results.length - passed, results };
}
