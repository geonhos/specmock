import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeHarvest, type RawResult } from "./normalize.js";
import type { Harvested } from "../types.js";
import { buildHarvestScript } from "./script.js";

export interface HarvestOptions { command?: string; maxPages?: number; maxDepth?: number; timeoutMs?: number; onLog?: (m: string) => void }

export async function isEgoBrowserAvailable(command = "ego-browser"): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 5_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export { normalizeHarvest, type RawResult } from "./normalize.js";

export async function harvest(url: string, opts: HarvestOptions = {}): Promise<Harvested> {
  const command = opts.command ?? "ego-browser";
  const tmp = await mkdtemp(path.join(os.tmpdir(), "specmock-harvest-"));
  const outFile = path.join(tmp, "result.json");
  const script = buildHarvestScript({
    url, outFile, maxPages: opts.maxPages ?? 50, maxDepth: opts.maxDepth ?? 2, perPageTimeoutMs: 20_000,
    spaceName: `specmock harvest ${new URL(url).host}`,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`ego-browser 수확 시간 초과 (${opts.timeoutMs ?? 300_000}ms)`)); }, opts.timeoutMs ?? 300_000);
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`ego-browser를 실행할 수 없습니다: ${e.message}`)); });
      child.stdout.on("data", (d) => opts.onLog?.(String(d).trim()));
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ego-browser 종료 코드 ${code}: ${err.trim().slice(0, 500)}`)); });
      child.stdin.end(script);
    });
    const raw = JSON.parse(await readFile(outFile, "utf8")) as RawResult;
    return normalizeHarvest(raw, url);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
