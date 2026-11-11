import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmUsage } from "./adapter.js";

/** `.specmock/<system>/` 아래 파일 이름. 한 호출 = 한 줄. */
export const USAGE_FILE = "llm-usage.jsonl";

export interface UsageRecord extends LlmUsage {
  stage: "extract" | "generate";
  /** extract: `chunk NNN · <heading>`, generate: `<language> attempt n/m`. */
  detail: string;
}

export interface UsageSummary {
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 전부 null이면 null. */
  costUsd: number | null;
  costBasis: string | null;
  /** api-key 호출이 하나라도 있으면 "api-key". */
  billing: "api-key" | "subscription";
  durationMs: number;
}

/** 한 줄을 덧붙인다. 잠금은 없다(호출은 순차). 실패해도 던지지 않고 경고만 낸다. */
export async function appendUsage(systemDir: string, record: UsageRecord): Promise<void> {
  try {
    await mkdir(systemDir, { recursive: true });
    await appendFile(path.join(systemDir, USAGE_FILE), JSON.stringify(record) + "\n");
  } catch (e) {
    process.stderr.write(`경고: LLM 사용량을 ${USAGE_FILE}에 기록하지 못했습니다: ${(e as Error).message}\n`);
  }
}

/** 파일이 없으면 빈 배열. 깨진 줄과 레코드 모양이 아닌 줄은 건너뛴다. */
export async function readUsage(systemDir: string): Promise<UsageRecord[]> {
  let text: string;
  try { text = await readFile(path.join(systemDir, USAGE_FILE), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as UsageRecord;
      if (r && typeof r === "object" && typeof r.at === "string" && typeof r.ok === "boolean" && typeof r.durationMs === "number") out.push(r);
    } catch { /* 깨진 줄 */ }
  }
  return out;
}

/** `at`이 startedAt 이후인 줄만. "이번 실행분"을 가르는 데 쓴다(파일에 run id는 넣지 않는다). */
export async function readUsageSince(systemDir: string, startedAt: Date): Promise<UsageRecord[]> {
  const from = startedAt.getTime();
  return (await readUsage(systemDir)).filter((r) => Date.parse(r.at) >= from);
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  let costUsd: number | null = null;
  const s: UsageSummary = { calls: records.length, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, costBasis: null, billing: "subscription", durationMs: 0 };
  for (const r of records) {
    if (r.ok) s.ok++; else s.failed++;
    s.inputTokens += r.inputTokens ?? 0;
    s.outputTokens += r.outputTokens ?? 0;
    s.cacheReadTokens += r.cacheReadTokens ?? 0;
    s.cacheCreationTokens += r.cacheCreationTokens ?? 0;
    if (r.costUsd != null) costUsd = (costUsd ?? 0) + r.costUsd;
    s.costBasis ??= r.costBasis ?? null;
    if (r.billing === "api-key") s.billing = "api-key";
    s.durationMs += r.durationMs;
  }
  s.costUsd = costUsd;
  return s;
}

/**
 * onUsage 콜백(동기)에서 순서대로 append하는 싱크. `record`는 즉시 돌아오고 `flush`가 쓰기 완료를 기다린다.
 * 기록 실패는 appendUsage가 경고로 삼키므로 flush는 던지지 않는다.
 */
export function createUsageSink(systemDir: string): { record: (r: UsageRecord) => void; flush: () => Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  return {
    record: (r) => { tail = tail.then(() => appendUsage(systemDir, r)); },
    flush: () => tail,
  };
}
