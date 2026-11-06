import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const live = new Set<ChildProcess>();
let hooked = false;

/**
 * 자식을 새 프로세스 그룹의 리더로 띄운다(POSIX). 취소 때 `killGroup`이 손자(npm의 postinstall, npx가 띄운 tsx 등)까지 함께 죽이기 위해서다.
 * detached 자식은 터미널의 Ctrl-C(SIGINT)를 받지 못하므로, 부모가 끝날 때 남은 그룹을 정리하는 훅을 한 번 건다.
 */
export function spawnGroup(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  live.add(child);
  child.once("close", () => live.delete(child));
  child.once("error", () => live.delete(child));
  if (!hooked) {
    hooked = true;
    process.once("exit", () => { for (const c of live) killGroup(c, "SIGKILL"); });
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
