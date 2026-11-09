// packages/core/src/generate/llm.ts
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmAdapter } from "../llm/adapter.js";
import type { MockSpec } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import { verify, verifyFailed, type ContractResult } from "../verify/index.js";
import type { RuntimeCheck } from "../verify/runtime.js";
import { ensureInstalled } from "../verify/server.js";
import { EnvironmentError, GenerationFailedError } from "./errors.js";
import type { GenerateContext, GenerateProgress, LanguageGenerator, LanguageOutput } from "./generator.js";
import { readLock, writeLock } from "./lock.js";
import type { LanguageProfile } from "./profiles/types.js";
import { buildGenerateRequest, retrySection, type AttemptFailure } from "./request.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { validateOutput } from "./validateOutput.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));

/** 마지막 실패 시도를 남기는 outDir 안 디렉터리. 다음 generate가 지운다. */
export const ATTEMPT_DIR = ".specmock-attempt";

export interface LlmGeneratorOptions {
  maxAttempts?: number;
  /** claude 호출 한 번의 시간 제한. */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

type FileOut = LanguageOutput["files"][number];
type Progress = (stage: GenerateProgress["stage"], attempt: number, message: string) => void;

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
const SPAWN_FAILURE = /실행할 수 없습니다|시작할 수 없습니다/;

/** 정적 파일(mvnw 등)을 templates/<언어>/에서 읽는다. */
export async function readStaticFiles(profile: LanguageProfile): Promise<FileOut[]> {
  return Promise.all(profile.staticFiles.map(async (s) => ({
    path: s.path,
    content: await readFile(`${TEMPLATES}${profile.language}/${s.path}`, "utf8"),
    ...(s.mode !== undefined ? { mode: s.mode } : {}),
  })));
}

/** 응답 파일 + 응답에 빠진 기존 파일(유지) → 최종 언어 종속 파일 집합. */
function mergeWithExisting(files: FileOut[], ctx: GenerateContext, notes: string[]): FileOut[] {
  const merged = [...files];
  const named = new Set(files.map((f) => f.path));
  for (const e of ctx.existing?.files ?? []) {
    if (named.has(e.path)) continue;
    merged.push({ path: e.path, content: e.content });
    notes.push(`응답에 없어 유지: ${e.path}`);
  }
  return merged;
}

/**
 * 프로필 기반 LLM 생성기. 시도마다: 지시서(+재시도 절) → 모델 호출 → 응답 검증 → 임시 디렉터리에 전체 프로젝트 →
 * install(빌드) → verify(contract + 런타임 계약 7·8). 통과한 파일 집합을 돌려주고 outDir에는 쓰지 않는다(쓰기는 generate가 한다).
 * 호출 전에 응답은 반드시 validateOutput을 거친다(writeLanguageFiles는 경로를 검사하지 않는다).
 */
export class LlmGenerator implements LanguageGenerator {
  readonly generator = "llm" as const;
  readonly language: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly profile: LanguageProfile, private readonly adapter: LlmAdapter, opts: LlmGeneratorOptions = {}) {
    this.language = profile.language;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.platform = opts.platform ?? process.platform;
  }

  async generate(ctx: GenerateContext): Promise<LanguageOutput> {
    const { profile } = this;
    const request = await buildGenerateRequest({ spec: ctx.spec, profile, outDir: ctx.outDir, existing: ctx.existing });
    const staticFiles = await readStaticFiles(profile);
    const install = profile.install(this.platform);
    const progress: Progress = (stage, attempt, message) => ctx.onProgress?.({ stage, attempt, maxAttempts: this.maxAttempts, message });

    let failure: AttemptFailure | null = null;
    let lastFiles: FileOut[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      ctx.signal?.throwIfAborted();
      progress("generating", attempt, `코드 생성 중 (${attempt}/${this.maxAttempts})`);
      const prompt = failure ? `${request.prompt}\n\n${retrySection(failure, ctx.spec)}` : request.prompt;
      let raw: unknown;
      try {
        raw = await this.adapter.complete({ prompt, schema: request.outputSchema, signal: ctx.signal, timeoutMs: this.timeoutMs });
      } catch (e) {
        if (isAbort(e)) throw e;
        const message = (e as Error).message;
        if (SPAWN_FAILURE.test(message)) throw new EnvironmentError("Claude Code(claude CLI)", message);
        failure = { attempt, stage: "response", errors: [message], contracts: [], runtime: [] };
        continue;
      }
      const checked = validateOutput(raw, profile);
      if (!checked.ok) {
        failure = { attempt, stage: "response", errors: checked.errors, contracts: [], runtime: [] };
        continue;
      }
      const notes = [...checked.notes];
      const files = mergeWithExisting(checked.files, ctx, notes);
      lastFiles = files;
      const output: LanguageOutput = {
        files: [...files, ...staticFiles],
        install,
        installCheck: profile.installCheck ?? null,
        start: profile.start,
        healthPath: profile.healthPath,
        startTimeoutMs: profile.startTimeoutMs,
        installTimeoutMs: profile.installTimeoutMs,
        notes,
        attempts: attempt,
      };
      const result = await this.tryInTemp(ctx, output, attempt, progress);
      if (result === null) return output;
      failure = result;
    }
    await this.keepAttempt(ctx.outDir, lastFiles, failure!, ctx.spec);
    throw new GenerationFailedError(this.maxAttempts, path.join(ctx.outDir, ATTEMPT_DIR), failure!.errors);
  }

  /** 임시 디렉터리에서 빌드·기동·검증. 통과하면 null, 실패하면 다음 시도에 넘길 요약. 환경 오류는 던진다. */
  private async tryInTemp(ctx: GenerateContext, output: LanguageOutput, attempt: number, progress: Progress): Promise<AttemptFailure | null> {
    const { spec } = ctx;
    const tmp = await mkdtemp(path.join(os.tmpdir(), "specmock-attempt-"));
    try {
      const sourceFiles: Record<string, string> = {};
      for (const f of output.files) if (f.content !== null) sourceFiles[f.path] = hashText(f.content);
      await writeLanguageFiles(tmp, output, []);
      const s = await writeScaffold(spec, tmp, null, {}, []);
      // 증분이면 사용자의 fixture(수정본 포함)로 검증한다.
      await cp(path.join(ctx.outDir, "fixtures"), path.join(tmp, "fixtures"), { recursive: true, force: true }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      await writeLock(tmp, {
        system: spec.system, language: this.profile.language, generator: "llm",
        mockspecHash: hashJson(spec), generatedAt: new Date().toISOString(),
        install: output.install, installCheck: output.installCheck ?? null, start: output.start, healthPath: output.healthPath,
        startTimeoutMs: output.startTimeoutMs, installTimeoutMs: output.installTimeoutMs,
        fixtureHashes: s.fixtureHashes, sourceFiles,
      });
      const lock = (await readLock(tmp))!;

      progress("building", attempt, `빌드 중 (${attempt}/${this.maxAttempts})`);
      try {
        await ensureInstalled(tmp, { lock, signal: ctx.signal });
      } catch (e) {
        if (isAbort(e)) throw e;
        this.throwIfEnvironment((e as Error).message);
        return { attempt, stage: "build", errors: [(e as Error).message], contracts: [], runtime: [] };
      }

      progress("verifying", attempt, `검증 중 (${attempt}/${this.maxAttempts})`);
      const runtime = { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) };
      let result;
      try {
        result = await verify(tmp, { signal: ctx.signal, runtime });
      } catch (e) {
        if (isAbort(e)) throw e;
        this.throwIfEnvironment((e as Error).message);
        return { attempt, stage: "start", errors: [(e as Error).message], contracts: [], runtime: [] };
      }
      if (!verifyFailed(result)) return null;
      const contracts: ContractResult[] = result.results.filter((r) => !r.passed);
      const rt: RuntimeCheck[] = result.runtime.filter((c) => !c.passed);
      return { attempt, stage: "contract", errors: [], contracts, runtime: rt };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private throwIfEnvironment(message: string): void {
    if (SPAWN_FAILURE.test(message) || (this.profile.environmentErrors ?? []).some((re) => re.test(message))) {
      throw new EnvironmentError(this.profile.requires, message);
    }
  }

  /** 마지막 시도의 모델 파일과 오류 요약을 outDir/.specmock-attempt/에 남긴다. */
  private async keepAttempt(outDir: string, files: FileOut[], failure: AttemptFailure, spec: MockSpec): Promise<void> {
    const dir = path.join(outDir, ATTEMPT_DIR);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeLanguageFiles(dir, { files, install: null, start: this.profile.start, healthPath: this.profile.healthPath, notes: [] }, []);
    await writeFile(path.join(dir, "errors.md"), retrySection(failure, spec) + "\n", "utf8");
  }
}
