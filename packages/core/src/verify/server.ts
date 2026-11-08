import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import getPort from "get-port";
import type { Lock } from "../generate/lock.js";
import { killGroup, spawnGroup } from "../util/procGroup.js";

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

async function waitForHealth(url: string, state: () => ChildState, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const s = state();
    if (s.spawnError) throw new Error(`mock 서버를 시작할 수 없습니다: ${s.spawnError.message}`);
    if (s.exitCode !== null) throw new Error(`mock 서버가 종료되었습니다 (exit ${s.exitCode}).\n${s.stderr}`);
    try {
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      signal?.throwIfAborted();
      // 아직 기동 중
    }
    await sleepAbortable(200, signal);
  }
  throw new Error(`mock 서버가 ${timeoutMs}ms 안에 응답하지 않았습니다.\n${state().stderr}`);
}

const INSTALLED_MARKER = ".specmock-installed";

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** 설치 완료는 디렉터리 존재가 아니라 성공 뒤에 쓰는 마커로 판정한다(중단·실패로 반쯤 쓰인 node_modules를 믿지 않기 위해). */
async function isInstalled(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, "node_modules", INSTALLED_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * 마커가 없으면 npm install을 먼저 실행한다. 없이 `npx tsx`를 부르면 npx가 설치 여부를 묻다가 멈춘다.
 * 마커 도입 전에 만든 mock(마커 없는 node_modules)은 한 번 다시 설치한다. npm은 이미 있는 패키지를 빠르게 확인만 하므로 비용이 작다.
 * 취소·실패해도 node_modules는 지우지 않는다(오프라인 첫 verify가 기존 설치를 날리면 안 된다). 마커가 없으니 다음 호출이 다시 설치한다.
 */
export async function ensureInstalled(dir: string, opts: { onLog?: (message: string) => void; signal?: AbortSignal } = {}): Promise<void> {
  opts.signal?.throwIfAborted();
  if (await isInstalled(dir)) return;
  opts.onLog?.("의존성 설치 중 (npm install)...");
  let onAbort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnGroup("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr?.on("data", (d) => { err += String(d); });
      onAbort = () => { killGroup(child, "SIGKILL"); reject(abortReason(opts.signal!)); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();   // 리스너를 달기 전에 이미 취소된 경우
      child.once("error", (e) => reject(new Error(`npm install을 실행할 수 없습니다: ${e.message}`)));
      child.once("exit", (code) => (opts.signal?.aborted ? undefined : code === 0 ? resolve() : reject(new Error(`npm install 실패 (exit ${code}).\n${err}`))));
    });
    opts.signal?.throwIfAborted();
    await writeFile(path.join(dir, "node_modules", INSTALLED_MARKER), new Date().toISOString());
  } catch (e) {
    throw e;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function groupAlive(child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  if (child.pid === undefined) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("작업이 취소되었습니다", "AbortError");
}

export async function startMock(dir: string, lock: Lock, opts: StartMockOptions = {}): Promise<RunningMock> {
  await ensureInstalled(dir, { onLog: opts.onLog, signal: opts.signal });
  const port = await getPort();
  const child = spawnGroup(lock.start.command, lock.start.args, {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  let spawnError: Error | null = null;
  child.stderr?.on("data", (d) => { err += String(d); });
  child.stdout?.on("data", () => { /* 로그는 버린다 */ });
  child.once("error", (e) => { spawnError = e; });

  const stop = async () => {
    if (spawnError || child.pid === undefined) return;
    killGroup(child, "SIGTERM");
    // 리더가 먼저 죽어도 손자가 남을 수 있으므로, 유예 동안 그룹 생존 여부를 보고 남았으면 그룹째 SIGKILL한다.
    const deadline = Date.now() + 3000;
    while (groupAlive(child) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (groupAlive(child)) killGroup(child, "SIGKILL");
  };

  try {
    await waitForHealth(
      `http://127.0.0.1:${port}${lock.healthPath}`,
      () => ({ exitCode: child.exitCode, spawnError, stderr: err }),
      opts.timeoutMs ?? 30_000,
      opts.signal,
    );
  } catch (e) {
    await stop();
    throw e;
  }
  return { port, stop };
}
