import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import getPort from "get-port";
import type { Lock } from "../generate/lock.js";

export interface RunningMock {
  port: number;
  stop: () => Promise<void>;
}

async function waitForHealth(url: string, child: ChildProcess, stderr: () => string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`mock 서버가 종료되었습니다 (exit ${child.exitCode}).\n${stderr()}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 아직 기동 중
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock 서버가 ${timeoutMs}ms 안에 응답하지 않았습니다.\n${stderr()}`);
}

/** node_modules가 없으면 npm install을 먼저 실행한다. 없이 `npx tsx`를 부르면 npx가 설치 여부를 묻다가 멈춘다. */
export async function ensureInstalled(dir: string): Promise<void> {
  try {
    await access(path.join(dir, "node_modules"));
    return;
  } catch {
    // 설치 필요
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => { err += String(d); });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install 실패 (exit ${code}).\n${err}`))));
  });
}

export async function startMock(dir: string, lock: Lock, opts: { timeoutMs?: number } = {}): Promise<RunningMock> {
  await ensureInstalled(dir);
  const port = await getPort();
  const child = spawn(lock.start.command, lock.start.args, {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr?.on("data", (d) => { err += String(d); });
  child.stdout?.on("data", () => { /* 로그는 버린다 */ });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref();
    });

  try {
    await waitForHealth(`http://127.0.0.1:${port}${lock.healthPath}`, child, () => err, opts.timeoutMs ?? 30_000);
  } catch (e) {
    await stop();
    throw e;
  }
  return { port, stop };
}
