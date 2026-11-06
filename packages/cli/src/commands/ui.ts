import { spawn } from "node:child_process";
import path from "node:path";
import { InvalidArgumentError, type Command } from "commander";

export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description("브라우저 화면으로 등록부터 검증까지 진행한다 (127.0.0.1에서만 열림)")
    .option("--port <n>", "포트 (생략하면 자동)", (v) => {
      if (!/^\d+$/.test(v) || Number(v) > 65535) throw new InvalidArgumentError("포트는 0~65535 숫자로 적어 주세요");
      return Number(v);
    })
    .option("--no-open", "브라우저를 열지 않는다")
    .action(async (opts: { port?: number; open: boolean }, cmd: Command) => {
      const workspace = cmd.optsWithGlobals<{ workspace: string }>().workspace;
      // 화면 서버(hono 등)는 이 명령에서만 필요하므로 다른 명령의 시작을 늦추지 않게 늦게 불러온다.
      const { startUiServer } = await import("@specmock/ui-server");
      const ui = await startUiServer({ root: process.cwd(), workspaceDir: path.resolve(workspace), port: opts.port });
      // core의 자식 프로세스 정리 훅(procGroup)은 다른 리스너가 있으면 신호를 다시 보내지 않는다.
      // 그래서 종료는 여기서 명시적으로 한다. once가 아니라 on인 이유: once는 호출 직전에 걷혀,
      // 그 사이 걸린 procGroup 훅이 "리스너 없음"으로 보고 신호를 다시 보내 우아한 정리를 끊는다.
      let stopping = false;
      const stop = (sig: NodeJS.Signals) => {
        if (stopping) { process.exit(sig === "SIGINT" ? 130 : 143); } // 두 번째 신호는 즉시 끝낸다
        stopping = true;
        void ui.close().then(() => process.exit(0), () => process.exit(1));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.stdout.write(`specmock 화면: ${ui.url}\n끝내려면 Ctrl+C\n`);
      if (opts.open) {
        const [bin, args] = openCommand(process.platform, ui.url);
        spawn(bin, args, { stdio: "ignore", detached: true })
          .on("error", () => process.stderr.write(`브라우저를 열지 못했어요. 직접 여세요: ${ui.url}\n`))
          .unref();
      }
    });
}
