import { randomUUID } from "node:crypto";
import { link, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./workspace.js";

/** <system>/ 안의 잠금 파일. 화면 서버의 작업 공간 감시는 이 이름을 무시한다. */
export const SYSTEM_LOCK_FILE = ".lock";

export interface LockBody { pid: number; at: string; token: string }

export class LockBusyError extends Error {
  readonly code = "busy" as const;
  constructor(readonly lockFile: string, readonly holder: LockBody | null) {
    super(`다른 곳(CLI/대화/화면)에서 같은 시스템을 쓰는 중입니다 (${lockFile}${holder ? `, pid ${holder.pid}` : ""}). 끝난 뒤 다시 시도하세요.`);
    this.name = "LockBusyError";
  }
}

export interface SystemLockOptions {
  /** 잠금을 기다리는 최대 시간. 넘으면 LockBusyError. 기본 15s. */
  timeoutMs?: number;
  /** 이보다 오래된 잠금은 pid가 살아 있어도 회수한다. 기본 10분(잠금 구간은 짧은 쓰기뿐이다). */
  staleMs?: number;
  pollMs?: number;
}

/** 프로세스 안 직렬화: realpath 키별 Promise 체인. 같은 프로세스의 요청이 파일 잠금을 두고 폴링 경쟁하지 않게 한다. */
const chains = new Map<string, Promise<unknown>>();

/**
 * <system> 단위로 fn을 직렬화한다. 프로세스 안에서는 체인 순서, 프로세스 사이에서는 `<system>/.lock`(wx 생성).
 * 같은 시스템에 대해 중첩 호출하면 교착되므로 fn 안에서 다시 부르지 않는다.
 */
export async function withSystemLock<T>(ws: Workspace, system: string, fn: () => Promise<T>, opts: SystemLockOptions = {}): Promise<T> {
  // 없는 시스템의 빈 디렉터리를 만들지 않는다. 잠글 대상이 없으므로 fn이 기존 "파일 없음" 오류로 스스로 실패하게 둔다.
  let key: string;
  try { key = await realpath(ws.dir(system)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fn();
    throw e;
  }
  const file = path.join(key, SYSTEM_LOCK_FILE);
  const task = () => withFileLock(file, fn, opts);
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  try { return await run; } finally { if (chains.get(key) === tail) chains.delete(key); }
}

async function withFileLock<T>(file: string, fn: () => Promise<T>, opts: SystemLockOptions): Promise<T> {
  const token = await acquire(file, opts);
  try { return await fn(); } finally { await release(file, token); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readBody(file: string): Promise<LockBody | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as LockBody; } catch { return null; }
}

async function isStale(file: string, body: LockBody | null, staleMs: number): Promise<boolean> {
  if (body) return !alive(body.pid) || Date.now() - Date.parse(body.at) > staleMs;
  // 내용이 비었거나 깨짐: 다른 프로세스가 open과 write 사이일 수 있으므로 mtime이 충분히 오래됐을 때만.
  try { return Date.now() - (await stat(file)).mtimeMs > Math.min(staleMs, 5_000); } catch { return false; }
}

async function acquire(file: string, { timeoutMs = 15_000, staleMs = 10 * 60_000, pollMs = 25 }: SystemLockOptions): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const h = await open(file, "wx");
      try { await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token } satisfies LockBody)); }
      finally { await h.close(); }
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const body = await readBody(file);
    if (await isStale(file, body, staleMs)) { await reclaim(file, body); continue; }
    if (Date.now() >= deadline) throw new LockBusyError(file, body);
    await sleep(pollMs);
  }
}

/**
 * 남은 잠금을 치운다. 판정과 삭제 사이에 다른 프로세스가 회수·재획득했을 수 있으므로
 * 고유 이름으로 옮긴 뒤 token을 다시 확인하고, 다르면(새 잠금을 가져온 것) link로 되돌린다.
 * seen이 null(깨진·빈 잠금)이어도 옮긴 파일이 유효한 잠금이면 새 잠금이므로 되돌린다.
 * 한계: rename과 link 사이에 제3자가 wx로 잠금을 만들면 link가 EEXIST로 실패해 되돌리지 못한다.
 * 파일 시스템만으로는 이 창을 닫을 수 없다(원자적 "비교 후 교체"가 없다). 확률은 낮고, 되돌릴 대상은 방금 만든
 * 짧은 잠금이라 staleMs 안에 자연히 풀린다.
 */
async function reclaim(file: string, seen: LockBody | null): Promise<void> {
  const aside = `${file}.${process.pid}.${randomUUID()}.stale`;
  try { await rename(file, aside); } catch { return; }
  const got = await readBody(aside);
  if (got && got.token !== seen?.token) await link(aside, file).catch(() => {});
  await rm(aside, { force: true });
}

async function release(file: string, token: string): Promise<void> {
  if ((await readBody(file))?.token === token) await rm(file, { force: true });
}
