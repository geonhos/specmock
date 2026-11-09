import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import getPort from "get-port";
import { resolveInstall, type Lock } from "../generate/lock.js";
import { hashJson, hashText } from "../util/hash.js";
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

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const INSTALLED_MARKER = ".specmock-installed";
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

/** 설치 키: install 명령 + lock.sourceFiles에 적힌 파일의 현재 내용 해시. 소스가 바뀌면(Java 빌드) 다시 설치한다. */
export async function installKey(dir: string, lock: Lock): Promise<string> {
  const files: Record<string, string | null> = {};
  for (const rel of Object.keys(lock.sourceFiles).sort()) {
    files[rel] = await readFile(path.join(dir, rel), "utf8").then(hashText, () => null);
  }
  return hashJson({ install: resolveInstall(lock), files });
}

/** 테스트·symlink된 node_modules용: 설치를 한 것으로 표시한다. */
export async function markInstalled(dir: string, lock: Lock): Promise<void> {
  await writeFile(path.join(dir, INSTALLED_MARKER), await installKey(dir, lock));
}

/** 설치 완료는 성공 뒤에 쓰는 마커(내용 = 설치 키)로 판정한다. 2단계의 node_modules 안 마커는 보지 않는다(한 번 다시 설치). */
async function isInstalled(dir: string, key: string): Promise<boolean> {
  return (await readFile(path.join(dir, INSTALLED_MARKER), "utf8").catch(() => null)) === key;
}

export interface EnsureInstalledOptions {
  /** 설치 명령의 출처. 없으면 2단계 동작(npm install). */
  lock?: Lock;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const LEGACY_LOCK = (): Lock => ({
  system: "", language: "ts", generator: "template", mockspecHash: "", generatedAt: "",
  start: { command: "", args: [] }, healthPath: "", fixtureHashes: {}, sourceFiles: {},
});

/**
 * 마커의 키가 다르면 lock의 install을 cwd=dir에서 실행한다(셸 없음). TS에서는 npm install이 없으면 `npx tsx`가 설치 여부를 묻다가 멈춘다.
 * 취소·실패해도 산출물(node_modules, target)은 지우지 않는다. 마커가 없으니 다음 호출이 다시 설치한다.
 */
export async function ensureInstalled(dir: string, opts: EnsureInstalledOptions = {}): Promise<void> {
  opts.signal?.throwIfAborted();
  const lock = opts.lock ?? LEGACY_LOCK();
  const install = resolveInstall(lock);
  if (!install) return;
  const key = await installKey(dir, lock);
  if (await isInstalled(dir, key)) return;
  const label = install.command === "npm" ? "npm install" : [install.command, ...install.args.slice(0, 1)].join(" ");
  const timeoutMs = opts.timeoutMs ?? lock.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  opts.onLog?.(`의존성 설치 중 (${label})...`);
  let onAbort = () => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnGroup(install.command, install.args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const keep = (d: unknown) => { out = (out + String(d)).slice(-20_000); };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      onAbort = () => { killGroup(child, "SIGKILL"); reject(abortReason(opts.signal!)); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();   // 리스너를 달기 전에 이미 취소된 경우
      timer = setTimeout(() => { killGroup(child, "SIGKILL"); reject(new Error(`${label} 설치가 ${timeoutMs}ms 안에 끝나지 않았습니다.\n${out}`)); }, timeoutMs);
      child.once("error", (e) => reject(new Error(`${label}을(를) 실행할 수 없습니다: ${e.message}`)));
      child.once("exit", (code) => (opts.signal?.aborted ? undefined : code === 0 ? resolve() : reject(new Error(`${label} 설치 실패 (exit ${code}).\n${out}`))));
    });
    opts.signal?.throwIfAborted();
    await writeFile(path.join(dir, INSTALLED_MARKER), key);
  } finally {
    clearTimeout(timer);
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
  await ensureInstalled(dir, { lock, onLog: opts.onLog, signal: opts.signal });
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
      opts.timeoutMs ?? lock.startTimeoutMs ?? 30_000,
      opts.signal,
    );
  } catch (e) {
    await stop();
    throw e;
  }
  return { port, stop };
}
