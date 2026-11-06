import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import path from "node:path";
import { analyzeSpec, CatalogSchema, ClaudeCodeAdapter, findFeature, generate, ingestSpec, listFeatures, select, summarizeChunks, verifyMock, Workspace } from "@specmock/core";
import { streamSSE } from "hono/streaming";
import { EventBus, pushBounded, type BusEvent } from "./bus.js";
import { BusyJobError, JobManager, NotCancellableError, ShuttingDownError } from "./jobs.js";
import { errorBody, ingestInputError, InvalidRequest, NotFound, toApiError } from "./errors.js";
import { localOnly, methodGuard } from "./security.js";
import { serveWeb } from "./static.js";
import { assertRegistered, defaultOutDir, listSystems, readSelection, systemOverview } from "./systems.js";
import { findExecutable } from "./which.js";

const IngestBody = z.object({ system: z.string().min(1), origins: z.array(z.string().min(1)).min(1), refresh: z.boolean().optional() });
const ExtractBody = z.object({ refresh: z.boolean().optional() });
const GenerateBody = z.object({ outDir: z.string().min(1).optional(), force: z.boolean().optional() });
const VerifyBody = z.object({ dir: z.string().min(1).optional() });
const SelectionBody = z.object({ ids: z.array(z.string()) });

/** 본문이 없거나 비어 있어도 되는 요청용. 있으면 형식을 검사한다. */
async function optionalBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  const parsed = schema.safeParse(text.trim() === "" ? {} : (() => { try { return JSON.parse(text); } catch { return undefined; } })());
  if (!parsed.success) throw new InvalidRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

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
  /** true면 SSE 하트비트 타이머가 프로세스를 붙잡지 않는다. */
  unref?: boolean;
  /** SSE 클라이언트별 대기 큐 상한. 기본 1000. */
  sseQueueLimit?: number;
}

export function createApp(opts: AppOptions) {
  const ws = new Workspace(path.join(opts.root, ".specmock"));
  const claudeCommand = opts.claudeCommand ?? "claude";
  const bus = new EventBus();
  const jobs = new JobManager(bus);
  const app = new Hono();
  app.use("*", localOnly(opts.port));
  app.use("/api/*", methodGuard);
  app.onError((e, c) => {
    if (e instanceof BusyJobError) return c.json({ ...errorBody("busy", e.message, "진행 중인 작업이 있어요."), jobId: e.jobId }, 409);
    if (e instanceof ShuttingDownError) return c.json(errorBody("shutting-down", e.message), 503);
    if (e instanceof NotCancellableError) return c.json(errorBody("not-cancellable", e.message), 409);
    const r = toApiError(e); return c.json(r.body, r.status as ContentfulStatusCode);
  });
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
    const catalog = await ws.read(c.req.param("s"), "catalog.json", CatalogSchema);
    const byId = new Map(catalog.features.map((f) => [f.id, f]));
    const rows = r.rows.map((row) => ({ ...row, summary: byId.get(row.id)?.summary ?? "", codes: Object.keys(byId.get(row.id)?.responses ?? {}) }));
    return ok(c, { total: r.total, rows, groups: [...new Set(all.rows.map((x) => x.group))] });
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
  const resolveFromRoot = (p: string | undefined) => (p === undefined ? undefined : path.resolve(opts.root, p));
  const accepted = (c: Context, jobId: string) => c.json({ ok: true, data: { jobId } }, 202);
  app.post("/api/systems/:s/extract", async (c) => {
    const system = c.req.param("s");
    const b = await optionalBody(c, ExtractBody);
    await assertRegistered(ws, system);
    const job = jobs.start(system, "extract", ({ signal, onEvent }) =>
      analyzeSpec(ws, system, { llm: "claude-code", adapter: new ClaudeCodeAdapter({ command: claudeCommand }), refresh: b.refresh, onEvent, signal }));
    return accepted(c, job.id);
  });
  app.post("/api/systems/:s/generate", async (c) => {
    const system = c.req.param("s");
    const b = await optionalBody(c, GenerateBody);
    await assertRegistered(ws, system);
    const outDir = resolveFromRoot(b.outDir) ?? (await defaultOutDir(ws, opts.root, system));
    return accepted(c, jobs.start(system, "generate", () => generate(ws, system, { outDir, force: b.force })).id);
  });
  app.post("/api/systems/:s/verify", async (c) => {
    const system = c.req.param("s");
    const b = await optionalBody(c, VerifyBody);
    await assertRegistered(ws, system);
    const dir = resolveFromRoot(b.dir);
    return accepted(c, jobs.start(system, "verify", ({ signal, onEvent }) => verifyMock(ws, system, { dir, onEvent, signal })).id);
  });
  app.get("/api/jobs", (c) => ok(c, jobs.list()));
  app.post("/api/jobs/:id/cancel", (c) => {
    const job = jobs.cancel(c.req.param("id"));
    return job ? ok(c, { state: job.state }) : c.json(errorBody("not-found", "알 수 없는 작업이에요."), 404);
  });
  app.get("/api/events", (c) => streamSSE(c, async (stream) => {
    const queue: BusEvent[] = [];
    let wake: (() => void) | undefined;
    const limit = opts.sseQueueLimit ?? 1000;
    const off = bus.subscribe((e) => { pushBounded(queue, e, limit); wake?.(); });
    const ping = setInterval(() => { pushBounded(queue, { event: "ping", data: {} }, limit); wake?.(); }, 15_000);
    if (opts.unref) ping.unref();
    stream.onAbort(() => { off(); clearInterval(ping); wake?.(); });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted) {
      const e = queue.shift();
      if (!e) { await new Promise<void>((r) => { wake = r; }); wake = undefined; continue; }
      await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
    }
  }));
  app.all("/api/*", (c) => c.json(errorBody("not-found", `알 수 없는 API: ${c.req.method} ${c.req.path}`), 404));
  app.get("*", serveWeb(opts.webDir));
  return { app, ws, bus, jobs };
}
