import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const live = new Set<ChildProcess>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const handlers = new Map<NodeJS.Signals, () => void>();
let exitHooked = false;

function killAll(): void {
  for (const c of live) killGroup(c, "SIGKILL");
  live.clear();
}

function removeSignalHandlers(): void {
  for (const [sig, h] of handlers) process.off(sig, h);
  handlers.clear();
}

/**
 * Node는 시그널 기본 처리로 끝날 때 `exit` 이벤트를 부르지 않는다. 그래서 detached 자식(별도 그룹)은 부모가 Ctrl-C·SIGTERM·SIGHUP으로 죽으면 고아가 된다.
 * 살아 있는 그룹이 있는 동안만 핸들러를 건다. 핸들러는 그룹을 정리하고 자기 리스너를 걷은 뒤,
 * 다른 리스너가 없을 때만 같은 신호를 다시 보내 기본 동작(종료 코드·시그널 종료)을 유지한다.
 * 다른 코드가 같은 신호에 리스너를 걸었다면(예: Ctrl+C로 서버를 우아하게 닫는 CLI) 종료 결정은 그쪽에 맡긴다. 우리가 먼저 종료시키면 그 정리 로직을 끊기 때문이다.
 */
function addSignalHandlers(): void {
  if (handlers.size > 0) return;
  for (const sig of SIGNALS) {
    const h = () => {
      killAll();
      removeSignalHandlers();
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    handlers.set(sig, h);
    process.on(sig, h);
  }
}

function release(child: ChildProcess): void {
  live.delete(child);
  if (live.size === 0) removeSignalHandlers();
}

/**
 * 자식을 새 프로세스 그룹의 리더로 띄운다(POSIX). 취소 때 `killGroup`이 손자(npm의 postinstall, npx가 띄운 tsx 등)까지 함께 죽이기 위해서다.
 * detached 자식은 터미널의 Ctrl-C(SIGINT)를 받지 못하므로, 부모가 시그널·exit로 끝날 때 남은 그룹을 정리하는 훅을 건다.
 */
export function spawnGroup(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  live.add(child);
  child.once("close", () => release(child));
  child.once("error", () => release(child));
  addSignalHandlers();
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", killAll);
  }
  return child;
}

/** 그룹 전체에 신호를 보낸다. 이미 끝났으면(ESRCH) 무시한다. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
