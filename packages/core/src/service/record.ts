// packages/core/src/service/record.ts
import path from "node:path";
import type { GenerateReport } from "../generate/generator.js";
import { generate } from "../generate/index.js";
import { readLock } from "../generate/lock.js";
import type { LanguageProfile } from "../generate/profiles/index.js";
import type { LlmAdapter } from "../llm/adapter.js";
import { readTarget, record, type RecordResult } from "../record/index.js";
import { select } from "../select/index.js";
import { GenerateInfoSchema, MockSpecSchema, SelectionSchema } from "../types.js";
import { specInputHash } from "../util/specHash.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

export const APPLY_LATER = "generate를 실행하면 반영됩니다";
export const PRESERVED_NOTE = "보존됨 — 녹화가 반영되지 않음";

export interface RecordResponsesOptions {
  allowMutating?: boolean;
  features?: string[];
  refresh?: boolean;
  /** 기본 true. false면 녹화·drift만. */
  apply?: boolean;
  /** target.json의 ${ENV} 치환에 쓸 환경. 기본 process.env. */
  env?: Record<string, string | undefined>;
  onEvent?: OnEvent;
  signal?: AbortSignal;
  /** 테스트 전용: 언어 프로필·LLM 어댑터 주입. apply는 LLM을 부르지 않지만 generate가 프로필을 찾는 데 쓴다. */
  profile?: LanguageProfile;
  adapter?: LlmAdapter;
}

export interface RecordResponsesResult { result: RecordResult; driftPath: string; driftMarkdown: string; notes: string[] }

/** 실제 시스템 응답을 녹화하고 drift.md를 쓴 뒤, apply면 select → generate(LLM 없이)로 mock에 반영한다. */
export async function recordResponses(ws: Workspace, system: string, opts: RecordResponsesOptions = {}): Promise<RecordResponsesResult> {
  const target = await readTarget(ws, system, opts.env ?? process.env);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const { result, driftMarkdown } = await record(ws, system, spec, target, {
    allowMutating: opts.allowMutating, features: opts.features, refresh: opts.refresh, onEvent: opts.onEvent, signal: opts.signal,
  });
  const notes: string[] = [];
  if (opts.apply !== false) {
    opts.onEvent?.({ stage: "record", message: "select 다시 실행(녹화 반영)" });
    const selection = await ws.read(system, "selection.json", SelectionSchema);
    const sel = await select(ws, system, selection.selected);
    let generated: GenerateReport | null = null;
    const info = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
    const outDir = info ? path.resolve(info.outDir) : null;
    const lock = outDir ? await readLock(outDir) : null;
    if (!outDir || !lock) {
      notes.push(APPLY_LATER);
    } else if (lock.generator === "llm" && lock.inputHash !== specInputHash(await ws.read(system, "mockspec.json", MockSpecSchema))) {
      // 기능 정의가 바뀌었거나 옛 lock: generate가 LLM을 부르게 되므로 반영하지 않는다(D5).
      notes.push(`${APPLY_LATER}(LLM 재생성 필요)`);
    } else {
      opts.onEvent?.({ stage: "record", message: "generate 다시 실행(fixture 반영)" });
      generated = await generate(ws, system, { outDir, language: lock.language, profile: opts.profile, adapter: opts.adapter, signal: opts.signal });
      for (const p of generated.preserved) if (p.startsWith("fixtures/")) notes.push(`${p}: ${PRESERVED_NOTE}`);
    }
    result.applied = { selected: sel.resolved.length, generate: generated };
  }
  return { result, driftPath: result.driftPath, driftMarkdown, notes };
}
