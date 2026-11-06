import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { watchWorkspace } from "./watch.js";

/** 모노레포 안 웹 빌드 결과: packages/ui-server/dist → packages/web/dist */
export const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

const CLOSE_WAIT_MS = 5000;

export interface StartUiServerOptions {
  root: string;
  /** 0 또는 생략이면 자동. */
  port?: number;
  webDir?: string;
  claudeCommand?: string;
  /** true면 서버·감시자·타이머가 프로세스를 붙잡지 않는다(MCP 안에서 실행할 때). */
  unref?: boolean;
}
export interface UiServerHandle { url: string; port: number; close: () => Promise<void> }

export async function startUiServer(opts: StartUiServerOptions): Promise<UiServerHandle> {
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  if (!existsSync(path.join(webDir, "index.html"))) {
    throw new Error(`화면 빌드 결과가 없어요 (${webDir}). 저장소 루트에서 \`pnpm build\`를 먼저 실행하세요.`);
  }
  await mkdir(path.join(opts.root, ".specmock"), { recursive: true });
  let port = 0;
  const { app, bus, jobs } = createApp({ root: opts.root, webDir, port: () => port, claudeCommand: opts.claudeCommand, unref: opts.unref });
  const watcher = watchWorkspace(path.join(opts.root, ".specmock"), (e) => bus.publish("workspace-changed", e), { unref: opts.unref, onError: (e) => bus.publish("watch-error", { message: e.message }) });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port ?? 0 }, (info: AddressInfo) => { port = info.port; resolve(s); });
    s.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE"
      ? new Error(`포트 ${opts.port}을(를) 이미 쓰고 있어요. 다른 --port를 주거나 생략해 자동 포트를 쓰세요.`)
      : e));
  });
  if (opts.unref) server.unref();
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: async () => {
      watcher.close();
      jobs.shutdown(); // 이후 작업 POST는 503. 진행 중인 작업은 취소
      await jobs.whenIdle(CLOSE_WAIT_MS); // 자식 프로세스·파일 쓰기가 정리될 시간을 준다
      await new Promise<void>((resolve) => { server.close(() => resolve()); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); });
    },
  };
}
