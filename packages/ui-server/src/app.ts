import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import path from "node:path";
import { Workspace } from "@specmock/core";
import { errorBody, toApiError } from "./errors.js";
import { localOnly, methodGuard } from "./security.js";
import { serveWeb } from "./static.js";
import { findExecutable } from "./which.js";

export interface AppOptions {
  /** 프로젝트 루트. 상태는 <root>/.specmock, mock 기본 경로는 <root>/mock/<system>. */
  root: string;
  webDir: string;
  /** listen 뒤 실제 포트. Host 검사에 쓴다. */
  port: () => number;
  /** 문서 추출에 쓸 claude 실행 파일. 테스트는 가짜 실행 파일 경로를 준다. 기본 "claude". */
  claudeCommand?: string;
}

export function createApp(opts: AppOptions) {
  const ws = new Workspace(path.join(opts.root, ".specmock"));
  const claudeCommand = opts.claudeCommand ?? "claude";
  const app = new Hono();
  app.use("*", localOnly(opts.port));
  app.use("/api/*", methodGuard);
  app.onError((e, c) => { const r = toApiError(e); return c.json(r.body, r.status as ContentfulStatusCode); });
  app.get("/api/env", async (c) => c.json({ ok: true, data: { root: opts.root, claude: (await findExecutable(claudeCommand)) !== null } }));
  // Task 4·5의 라우트가 여기에 붙는다.
  app.all("/api/*", (c) => c.json(errorBody("not-found", `알 수 없는 API: ${c.req.method} ${c.req.path}`), 404));
  app.get("*", serveWeb(opts.webDir));
  return { app, ws };
}
