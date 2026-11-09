import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readLock } from "../generate/lock.js";
import { ContractSchema, type Contract } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { runContract, type ContractRun } from "./contracts.js";
import { runRuntimeChecks, type RuntimeCheck, type RuntimeSpec } from "./runtime.js";
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
  /** contract 수. 런타임 계약은 세지 않는다. */
  total: number;
  passed: number;
  failed: number;
  results: ContractResult[];
  /** 계약 7·8. */
  runtime: RuntimeCheck[];
  runtimeFailed: number;
}

/** verify 실패(종료 코드 2) 판정. contract 실패 또는 런타임 계약 실패. */
export function verifyFailed(r: VerifyResult): boolean {
  return r.failed > 0 || r.runtimeFailed > 0;
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

function toResult(c: Contract, r: ContractRun): ContractResult {
  return { featureId: c.featureId, name: c.name, passed: r.errors.length === 0, expectedStatus: c.expect.status, actualStatus: r.status, errors: r.errors };
}

export interface VerifyOptions {
  /** 오래 걸리는 단계(설치 등)를 알려주는 콜백. */
  onLog?: (message: string) => void;
  /** 취소. abort되면 mock을 정리하고 AbortError로 거부한다. */
  signal?: AbortSignal;
  /** mockspec의 notMocked·선택 기능. 있으면 계약 7(501)도 검사한다. */
  runtime?: RuntimeSpec;
}

export async function verify(mockDir: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const lock = await readLock(mockDir);
  if (!lock) throw new Error(`${mockDir}에 specmock.lock.json이 없습니다. 먼저 specmock generate를 실행하세요.`);
  const contracts = await loadContracts(mockDir);
  const server = await startMock(mockDir, lock, { onLog: opts.onLog, signal: opts.signal });
  const ajv = makeAjv();
  const results: ContractResult[] = [];
  let runtime: RuntimeCheck[] = [];
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const c of contracts) {
      opts.signal?.throwIfAborted();
      results.push(toResult(c, await runContract(base, c, { ajv })));
    }
    opts.signal?.throwIfAborted();
    runtime = await runRuntimeChecks(base, opts.runtime);
  } finally {
    await server.stop();
  }
  const passed = results.filter((r) => r.passed).length;
  return { mockDir, total: results.length, passed, failed: results.length - passed, results, runtime, runtimeFailed: runtime.filter((c) => !c.passed).length };
}
