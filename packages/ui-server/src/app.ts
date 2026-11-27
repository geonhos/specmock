import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeSpec, assertLanguage, CatalogSchema, ClaudeCodeAdapter, findFeature, flowDetail, flowSummaries, FlowSourceSchema, FlowTargetName, generate, inferFlowsForSystem, readFlows, runFlowTargets, setInput, type LaunchMock, suggestedBaseUrl, writeFlows, ingestSpec, listFeatures, readLock, MockSpecSchema, readTarget, recordResponses, select, summarizeChunks, DRIFT_FILE, TARGET_EXAMPLE, TARGET_FILE, TargetSchema, verifyMock, Workspace } from "@specmock/core";
import { streamSSE } from "hono/streaming";
import { EnvStore } from "./envStore.js";
import { SafetyStore } from "./safety.js";
import { EventBus, pushBounded, type BusEvent } from "./bus.js";
import { BusyJobError, JobManager, NotCancellableError, ShuttingDownError } from "./jobs.js";
import { errorBody, ingestInputError, InvalidRequest, NotFound, toApiError } from "./errors.js";
import { localOnly, methodGuard } from "./security.js";
import { serveWeb } from "./static.js";
import { envNames, envStatus, mergePut, readRawTarget, readRecordedSummaries, TargetPutBodySchema, toEntries, toHeaderEntries } from "./targetView.js";
import { assertRegistered, defaultOutDir, listSystems, readSelection, systemOverview } from "./systems.js";
import { findExecutable } from "./which.js";

const IngestBody = z.object({ system: z.string().min(1), origins: z.array(z.string().min(1)).min(1), refresh: z.boolean().optional() });
const ExtractBody = z.object({ refresh: z.boolean().optional() });
const GenerateBody = z.object({ outDir: z.string().min(1).optional(), force: z.boolean().optional(), language: z.string().min(1).optional() });
const VerifyBody = z.object({ dir: z.string().min(1).optional() });
const RecordBody = z.object({ allowMutating: z.boolean().optional(), refresh: z.boolean().optional(), features: z.array(z.string()).optional(), apply: z.boolean().optional() });
const EnvBody = z.object({ values: z.record(z.string(), z.string()) });
/** GET target은 존재·형식만 본다. 모든 `${ENV}`가 값이 있는 것처럼 치환해 env 오류가 나지 않게 한다(치환 결과는 버린다). */
const ANY_ENV: Record<string, string> = new Proxy({}, { get: () => "x" });
const FlowInputBody = z.object({ stepId: z.string().min(1), slot: z.string().min(1), source: FlowSourceSchema });
const FlowRunBody = z.object({ targets: z.array(FlowTargetName).min(1).refine((t) => new Set(t).size === t.length, "대상이 겹칩니다"), cleanup: z.boolean().default(true) });
const SafetyBody = z.object({ on: z.boolean() });
const REAL_BLOCKED = "토큰이 없거나 실제 서버 주소가 비어 있어 실제 실행을 막았어요. mock 실행은 할 수 있어요.";
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
  /** 상태 디렉터리. 생략하면 <root>/.specmock. CLI의 --workspace와 같다. */
  workspaceDir?: string;
  webDir: string;
  /** listen 뒤 실제 포트. Host 검사에 쓴다. */
  port: () => number;
  /** 문서 추출에 쓸 claude 실행 파일. 테스트는 가짜 실행 파일 경로를 준다. 기본 "claude". */
  claudeCommand?: string;
  /** true면 SSE 하트비트 타이머가 프로세스를 붙잡지 않는다. */
  unref?: boolean;
  /** 테스트용. 흐름 실행의 mock 기동을 바꾼다. 기본은 TS mock 생성 → 기동. */
  launchMock?: LaunchMock;
  /** SSE 클라이언트별 대기 큐 상한. 기본 1000. */
  sseQueueLimit?: number;
}

export function createApp(opts: AppOptions) {
  const ws = new Workspace(opts.workspaceDir ?? path.join(opts.root, ".specmock"));
  const claudeCommand = opts.claudeCommand ?? "claude";
  const bus = new EventBus();
  const jobs = new JobManager(bus);
  const envStore = new EnvStore();
  const safety = new SafetyStore();
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
    const rows = r.rows.map((row) => ({ ...row, summary: byId.get(row.id)?.summary || byId.get(row.id)?.title || row.id, codes: Object.keys(byId.get(row.id)?.responses ?? {}) }));
    return ok(c, { total: r.total, rows, groups: [...new Set(all.rows.map((x) => x.group))] });
  });
  /** 묶음별 기능 수만 돌려준다. 행은 GET /features?group=<g>로 묶음 하나씩 받는다. 순서는 listFeatures의 묶음 이름순(catalog/order.ts:14-20). */
  app.get("/api/systems/:s/feature-groups", async (c) => {
    const r = await listFeatures(ws, c.req.param("s"));
    const totals = new Map<string, number>();
    for (const row of r.rows) totals.set(row.group, (totals.get(row.group) ?? 0) + 1);
    return ok(c, { total: r.total, groups: [...totals].map(([group, total]) => ({ group, total })) });
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
    // 모르는 언어는 작업을 만들기 전에 400으로 돌려준다(toApiError는 이 메시지를 500으로 본다).
    if (b.language !== undefined) {
      try { assertLanguage(b.language); } catch (e) { throw new InvalidRequest((e as Error).message); }
    }
    await assertRegistered(ws, system);
    const outDir = resolveFromRoot(b.outDir) ?? (await defaultOutDir(ws, opts.root, system));
    const input = { outDir, ...(b.language ? { language: b.language } : {}) };
    // 언어를 바꾸는 요청은 force 없이는 작업을 만들지 않고 409로 돌려준다(화면이 확인 창을 연다).
    const previous = b.force || b.language === undefined ? null : await readLock(outDir);
    if (previous && previous.language !== b.language) {
      return c.json(errorBody("language-change-required", `이 디렉터리는 ${previous.language}로 만들어졌어요. ${b.language}로 바꾸려면 기존 소스를 지워야 해요 (현재 ${previous.language} → 요청 ${b.language}).`, "fixtures의 수정은 보존돼요(contracts는 다시 만들어요). 확인하면 기존 소스를 지우고 다시 만들어요.", { from: previous.language, to: b.language }), 409);
    }
    return accepted(c, jobs.start(system, "generate", ({ signal, onEvent }) => generate(ws, system, {
      outDir, force: b.force, language: b.language, signal,
      adapter: new ClaudeCodeAdapter({ command: claudeCommand }),
      onProgress: (e) => onEvent({ stage: e.stage, message: e.message, done: e.attempt, total: e.maxAttempts }),
    }), input).id);
  });
  app.post("/api/systems/:s/verify", async (c) => {
    const system = c.req.param("s");
    const b = await optionalBody(c, VerifyBody);
    await assertRegistered(ws, system);
    const dir = resolveFromRoot(b.dir);
    return accepted(c, jobs.start(system, "verify", ({ signal, onEvent }) => verifyMock(ws, system, { dir, onEvent, signal })).id);
  });
  /** 화면에서 입력한 환경 변수는 서버 메모리에만 둔다. 응답은 이름만, 값은 어디에도 싣지 않는다. */
  app.post("/api/systems/:s/env", async (c) => {
    const system = c.req.param("s");
    const b = await body(c, EnvBody);
    await assertRegistered(ws, system);
    return ok(c, { names: envStore.set(system, b.values) });
  });
  // target.json 값은 헤더의 직접 적은 값만 "***"로 가린다(API 키·토큰이 응답·로그에 남지 않게). params·features는 원문을 돌려준다.
  const targetInfo = async (system: string) => {
    if (!(await ws.exists(system, TARGET_FILE))) return { exists: false, example: TARGET_EXAMPLE, suggestedBaseUrl: await suggestedBaseUrl(ws, system) };
    try {
      const t = await readTarget(ws, system, ANY_ENV);   // 형식 확인만(치환 결과는 버린다)
      const raw = (await readRawTarget(ws, system))!;
      return {
        exists: true, baseUrl: t.baseUrl, example: TARGET_EXAMPLE, suggestedBaseUrl: await suggestedBaseUrl(ws, system),
        target: {
          baseUrl: t.baseUrl, timeoutMs: t.timeoutMs,
          headers: toHeaderEntries(raw.headers), params: toEntries(raw.params),
          features: Object.fromEntries(Object.entries(raw.features ?? {}).map(([id, m]) => [id, toEntries(m)])),
        },
        env: envStatus(envNames(raw), envStore, system),
      };
    } catch (e) {
      return { exists: true, error: e instanceof Error ? e.message : String(e), example: TARGET_EXAMPLE, suggestedBaseUrl: await suggestedBaseUrl(ws, system) };
    }
  };
  app.get("/api/systems/:s/target", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    return ok(c, await targetInfo(system));
  });
  app.put("/api/systems/:s/target", async (c) => {
    const system = c.req.param("s");
    const b = await body(c, TargetPutBodySchema);
    await assertRegistered(ws, system);
    // features 키는 mockspec의 기능 id여야 한다. mockspec.json이 아직 없으면 대조하지 않는다.
    if (Object.keys(b.features).length > 0 && (await ws.exists(system, "mockspec.json"))) {
      const known = new Set((await ws.read(system, "mockspec.json", MockSpecSchema)).features.map((f) => f.id));
      const unknown = Object.keys(b.features).filter((id) => !known.has(id));
      if (unknown.length) throw new InvalidRequest(`알 수 없는 기능 id: ${unknown.join(", ")}`);
    }
    const next = mergePut(b, await readRawTarget(ws, system));
    await ws.write(system, TARGET_FILE, TargetSchema, next);
    return ok(c, await targetInfo(system));
  });
  app.post("/api/systems/:s/record", async (c) => {
    const system = c.req.param("s");
    const b = await optionalBody(c, RecordBody);
    await assertRegistered(ws, system);
    // 모르는 기능 id는 작업을 만들기 전에 400으로 돌려준다.
    if (b.features && b.features.length > 0) {
      const known = new Set((await ws.read(system, "mockspec.json", MockSpecSchema)).features.map((f) => f.id));
      const unknown = b.features.filter((id) => !known.has(id));
      if (unknown.length) throw new InvalidRequest(`알 수 없는 기능 id: ${unknown.join(", ")}`);
    }
    return accepted(c, jobs.start(system, "record", ({ signal, onEvent }) => recordResponses(ws, system, {
      allowMutating: b.allowMutating, refresh: b.refresh, features: b.features, apply: b.apply, env: envStore.env(system), signal, onEvent,
    })).id);
  });
  /** 마지막 녹화 결과: drift.md 원문과 기능별 상태·시각. 녹화된 응답 본문은 싣지 않는다. */
  app.get("/api/systems/:s/record/last", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    const drift = (await ws.exists(system, DRIFT_FILE)) ? await readFile(ws.file(system, DRIFT_FILE), "utf8") : null;
    const recordedAt = drift?.match(/\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}),/)?.[1];
    return ok(c, { exists: drift !== null, ...(drift !== null ? { driftMarkdown: drift } : {}), ...(recordedAt ? { recordedAt } : {}), recorded: await readRecordedSummaries(ws, system) });
  });
  app.get("/api/systems/:s/flows", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    return ok(c, await flowSummaries(ws, system));
  });
  app.post("/api/systems/:s/flows/infer", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    try { return ok(c, await inferFlowsForSystem(ws, system)); } catch (e) {
      if (e instanceof Error && /먼저 기능을 고르세요/.test(e.message)) throw new InvalidRequest(e.message);
      throw e;
    }
  });
  app.get("/api/systems/:s/flows/:id", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    try { return ok(c, await flowDetail(ws, system, c.req.param("id"))); } catch (e) {
      if (e instanceof Error && /^알 수 없는 흐름/.test(e.message)) throw new NotFound(e.message);
      throw e;
    }
  });
  app.post("/api/systems/:s/flows/:id/inputs", async (c) => {
    const system = c.req.param("s");
    const b = await body(c, FlowInputBody);
    await assertRegistered(ws, system);
    const file = await readFlows(ws, system);
    if (!file) throw new NotFound("흐름이 없어요. 먼저 흐름을 추론하세요.");
    let next;
    try { next = setInput(file, c.req.param("id"), b.stepId, b.slot, b.source, "user"); } catch (e) {
      const m = (e as Error).message;
      throw /^알 수 없는 흐름/.test(m) ? new NotFound(m) : new InvalidRequest(m);
    }
    await writeFlows(ws, system, next);
    return ok(c, await flowDetail(ws, system, c.req.param("id")));
  });
  app.get("/api/systems/:s/safety", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    return ok(c, { on: safety.get(system) });
  });
  app.post("/api/systems/:s/safety", async (c) => {
    const system = c.req.param("s");
    const b = await body(c, SafetyBody);
    await assertRegistered(ws, system);
    return ok(c, { on: safety.set(system, b.on) });
  });
  /** 안전장치는 요청 시점에 서버가 읽는다. 화면이 보낸 값은 쓰지 않는다. */
  app.post("/api/systems/:s/flows/:id/run", async (c) => {
    const system = c.req.param("s");
    const flowId = c.req.param("id");
    const b = await body(c, FlowRunBody);
    await assertRegistered(ws, system);
    const detail = await flowDetail(ws, system, flowId).catch((e: unknown) => {
      if (e instanceof Error && /^알 수 없는 흐름/.test(e.message)) throw new NotFound(e.message);
      throw e;
    });
    if (detail.missingFeatures.length > 0) return c.json(errorBody("failed", `기능 없음: ${detail.missingFeatures.join(", ")}`, "기능 선택이 바뀌었어요. 흐름을 다시 추론하세요."), 409);
    const env = envStore.env(system);
    if (b.targets.includes("real")) {
      const usable = await readTarget(ws, system, env).then((t) => t.baseUrl !== "", () => false);
      if (!usable) return c.json(errorBody("failed", REAL_BLOCKED), 409);
    }
    const on = safety.get(system);
    const mockDir = await defaultOutDir(ws, opts.root, system);
    return accepted(c, jobs.start(system, "flow", ({ signal, onEvent }) => runFlowTargets(ws, system, flowId, { targets: b.targets, cleanup: b.cleanup, safety: on, env, mockDir, signal, onEvent, launchMock: opts.launchMock })).id);
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
