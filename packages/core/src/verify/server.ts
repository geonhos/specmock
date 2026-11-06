import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import getPort from "get-port";
import type { Lock } from "../generate/lock.js";

export interface RunningMock {
  port: number;
  stop: () => Promise<void>;
}

export interface StartMockOptions {
  timeoutMs?: number;
  /** 오래 걸리는 단계(npm install 등)를 알려주는 콜백. */
  onLog?: (message: string) => void;
  /** 취소. abort되면 npm install·mock 기동을 끝내고 AbortError로 거부한다. */
  signal?: AbortSignal;
}

interface ChildState {
  exitCode: number | null;
  spawnError: Error | null;
  stderr: string;
}

async function waitForHealth(url: string, state: () => ChildState, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = state();
    if (s.spawnError) throw new Error(`mock 서버를 시작할 수 없습니다: ${s.spawnError.message}`);
    if (s.exitCode !== null) throw new Error(`mock 서버가 종료되었습니다 (exit ${s.exitCode}).\n${s.stderr}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // 아직 기동 중
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock 서버가 ${timeoutMs}ms 안에 응답하지 않았습니다.\n${state().stderr}`);
}

async function hasNodeModules(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, "node_modules"));
    return true;
  } catch {
    return false;
  }
}

/** node_modules가 없으면 npm install을 먼저 실행한다. 없이 `npx tsx`를 부르면 npx가 설치 여부를 묻다가 멈춘다. */
export async function ensureInstalled(dir: string, opts: { onLog?: (message: string) => void; signal?: AbortSignal } = {}): Promise<void> {
  opts.signal?.throwIfAborted();
  if (await hasNodeModules(dir)) return;
  opts.onLog?.("의존성 설치 중 (npm install)...");
  let onAbort = () => {};
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => { err += String(d); });
    onAbort = () => { child.kill("SIGKILL"); reject(abortReason(opts.signal!)); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (e) => reject(new Error(`npm install을 실행할 수 없습니다: ${e.message}`)));
    child.once("exit", (code) => (opts.signal?.aborted ? undefined : code === 0 ? resolve() : reject(new Error(`npm install 실패 (exit ${code}).\n${err}`))));
  }).finally(() => opts.signal?.removeEventListener("abort", onAbort));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("작업이 취소되었습니다", "AbortError");
}

export async function startMock(dir: string, lock: Lock, opts: StartMockOptions = {}): Promise<RunningMock> {
  await ensureInstalled(dir, { onLog: opts.onLog, signal: opts.signal });
  const port = await getPort();
  const child = spawn(lock.start.command, lock.start.args, {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  let spawnError: Error | null = null;
  child.stderr?.on("data", (d) => { err += String(d); });
  child.stdout?.on("data", () => { /* 로그는 버린다 */ });
  child.once("error", (e) => { spawnError = e; });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (spawnError || child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref();
    });

  try {
    await waitForHealth(
      `http://127.0.0.1:${port}${lock.healthPath}`,
      () => ({ exitCode: child.exitCode, spawnError, stderr: err }),
      opts.timeoutMs ?? 30_000,
    );
  } catch (e) {
    await stop();
    throw e;
  }
  return { port, stop };
}
