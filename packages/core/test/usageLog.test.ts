import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendUsage, readUsage, summarizeUsage, USAGE_FILE, type UsageRecord } from "../src/llm/usageLog.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-usage-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: "2026-11-11T06:12:03.412Z", stage: "extract", detail: "chunk 001 · x", model: "m",
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1, costUsd: 0.5, costBasis: "list",
  billing: "subscription", durationMs: 1000, apiDurationMs: 900, ok: true, ...over,
});

describe("usageLog", () => {
  it("append → read 왕복(디렉터리가 없어도 만든다)", async () => {
    const sys = path.join(dir, "nested", "pets");
    await appendUsage(sys, rec());
    await appendUsage(sys, rec({ detail: "chunk 002 · y", ok: false, error: "e" }));
    const raw = await readFile(path.join(sys, USAGE_FILE), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    const got = await readUsage(sys);
    expect(got.map((r) => r.detail)).toEqual(["chunk 001 · x", "chunk 002 · y"]);
    expect(got[1]).toMatchObject({ ok: false, error: "e" });
  });

  it("파일이 없으면 빈 배열, 깨진 줄과 모양이 다른 줄은 건너뛴다", async () => {
    expect(await readUsage(path.join(dir, "none"))).toEqual([]);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, USAGE_FILE), `${JSON.stringify(rec())}\n{broken\n\n{"foo":1}\n${JSON.stringify(rec({ detail: "z" }))}\n`);
    expect((await readUsage(dir)).map((r) => r.detail)).toEqual(["chunk 001 · x", "z"]);
  });

  it("개행 없는 부분 줄 뒤에 append해도 새 레코드를 읽는다", async () => {
    await writeFile(path.join(dir, USAGE_FILE), `${JSON.stringify(rec({ detail: "a" }))}\n{"at":"2026-11-1`);
    await appendUsage(dir, rec({ detail: "b" }));
    expect((await readUsage(dir)).map((r) => r.detail)).toEqual(["a", "b"]);
  });

  it("기록 실패는 던지지 않고 경고만 낸다", async () => {
    const blocker = path.join(dir, "file");
    await writeFile(blocker, "x");
    const orig = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((c: string | Uint8Array) => { lines.push(String(c)); return true; }) as typeof process.stderr.write;
    try { await expect(appendUsage(path.join(blocker, "sub"), rec())).resolves.toBeUndefined(); }
    finally { process.stderr.write = orig; }
    expect(lines.join("")).toMatch(/경고.*사용량/);
  });

  it("summarizeUsage: null은 0으로 더하고 costUsd는 전부 null이면 null", () => {
    const s = summarizeUsage([
      rec(),
      rec({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, ok: false, durationMs: 500 }),
      rec({ inputTokens: 1, costUsd: 0.25 }),
    ]);
    expect(s).toMatchObject({ calls: 3, ok: 2, failed: 1, inputTokens: 11, outputTokens: 10, cacheReadTokens: 4, cacheCreationTokens: 2, costUsd: 0.75, costBasis: "list", billing: "subscription", durationMs: 2500 });
    const n = summarizeUsage([rec({ costUsd: null, costBasis: null }), rec({ costUsd: null, costBasis: null })]);
    expect(n.costUsd).toBeNull();
    expect(n.costBasis).toBeNull();
  });

  it("summarizeUsage: api-key 호출이 하나라도 있으면 billing은 api-key, 비면 calls 0", () => {
    expect(summarizeUsage([rec(), rec({ billing: "api-key" })]).billing).toBe("api-key");
    expect(summarizeUsage([]).calls).toBe(0);
  });
});
