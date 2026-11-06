import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import path from "node:path";
import { analyzeSpec, findFeature, ingestSpec, listFeatures, select, summarizeChunks, Workspace } from "@specmock/core";
import { errorBody, ingestInputError, InvalidRequest, NotFound, toApiError } from "./errors.js";
import { localOnly, methodGuard } from "./security.js";
import { serveWeb } from "./static.js";
import { listSystems, readSelection, systemOverview } from "./systems.js";
import { findExecutable } from "./which.js";

const IngestBody = z.object({ system: z.string().min(1), origins: z.array(z.string().min(1)).min(1), refresh: z.boolean().optional() });
const SelectionBody = z.object({ ids: z.array(z.string()) });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new InvalidRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

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
  const ok = (c: Context, data: unknown) => c.json({ ok: true, data });
  app.get("/api/systems", async (c) => ok(c, await listSystems(ws)));
  app.post("/api/systems", async (c) => {
    const b = await body(c, IngestBody);
    // 화면 등록은 브라우저 수집(최대 300s, 대화형)을 쓰지 않는다.
    // 상대 경로는 서버 cwd가 아니라 프로젝트 root 기준으로 읽고, source.json에도 절대 경로로 남긴다.
    const origins = b.origins.map((o) => (/^https?:\/\//.test(o) ? o : path.resolve(opts.root, o)));
    try {
      return ok(c, await ingestSpec(ws, b.system, origins, { refresh: b.refresh, harvest: "never" }));
    } catch (e) { throw ingestInputError(e); }
  });
  app.get("/api/systems/:s", async (c) => ok(c, await systemOverview(ws, opts.root, c.req.param("s"))));
  app.post("/api/systems/:s/analyze", async (c) => ok(c, await analyzeSpec(ws, c.req.param("s"), { llm: "session" })));
  app.get("/api/systems/:s/chunks", async (c) => ok(c, await summarizeChunks(ws, c.req.param("s"))));
  app.get("/api/systems/:s/features", async (c) => {
    const group = c.req.query("group") || undefined; // 빈 문자열은 필터 없음
    const r = await listFeatures(ws, c.req.param("s"), { group });
    const all = group === undefined ? r : await listFeatures(ws, c.req.param("s"));
    return ok(c, { total: r.total, rows: r.rows, groups: [...new Set(all.rows.map((x) => x.group))] });
  });
  app.get("/api/systems/:s/features/:id", async (c) => {
    try { return ok(c, await findFeature(ws, c.req.param("s"), c.req.param("id"))); } catch (e) {
      if (e instanceof Error && e.message.startsWith("알 수 없는 기능 id")) throw new NotFound(e.message);
      throw e;
    }
  });
  app.get("/api/systems/:s/selection", async (c) => ok(c, await readSelection(ws, c.req.param("s"))));
  app.post("/api/systems/:s/selection", async (c) => {
    const b = await body(c, SelectionBody);
    return ok(c, await select(ws, c.req.param("s"), b.ids, { literalIds: true }));
  });
  // Task 5의 라우트가 여기에 붙는다.
  app.all("/api/*", (c) => c.json(errorBody("not-found", `알 수 없는 API: ${c.req.method} ${c.req.path}`), 404));
  app.get("*", serveWeb(opts.webDir));
  return { app, ws };
}
