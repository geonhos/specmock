// packages/core/src/service/record.ts
import path from "node:path";
import type { GenerateReport } from "../generate/generator.js";
import { generate } from "../generate/index.js";
import { readLock } from "../generate/lock.js";
import type { LanguageProfile } from "../generate/profiles/index.js";
import type { LlmAdapter } from "../llm/adapter.js";
import { readTarget, record, type RecordResult } from "../record/index.js";
import { select } from "../select/index.js";
import { maskSecrets } from "../ingest/mask.js";
import { CatalogSchema, GenerateInfoSchema, MockSpecSchema, SelectionSchema } from "../types.js";
import { specInputHash } from "../util/specHash.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

export const APPLY_LATER = "generate를 실행하면 반영됩니다";
export const APPLY_FAILED = "반영 실패: ";
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
    let selectDone = false;
    try {
      opts.onEvent?.({ stage: "record", message: "select 다시 실행(녹화 반영)" });
      const selection = await ws.read(system, "selection.json", SelectionSchema);
      const catalog = await ws.read(system, "catalog.json", CatalogSchema);
      // literal이 저장돼 있으면 그 값. 옛 파일은 selected가 전부 현재 id와 정확히 일치하면 UI·--interactive가 고른 literal id 목록이다. 표현식으로 다시 풀면 `all`·`3` 같은 id가 다른 집합이 된다.
      const ids = new Set(catalog.features.map((f) => f.id));
      const literal = selection.literal ?? (selection.selected.length > 0 && selection.selected.every((id) => ids.has(id)));
      const sel = await select(ws, system, selection.selected, { literalIds: literal });
      selectDone = true;
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
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // 프로그래밍 오류(Error가 아니거나 TypeError·RangeError)는 삼키지 않는다.
      if (!(e instanceof Error) || e instanceof TypeError || e instanceof RangeError) throw e;
      // 녹화·drift.md는 이미 썼다. 결과를 버리지 않고 반영 실패를 알린다.
      notes.push(`${APPLY_FAILED}${maskSecrets(e.message)}${selectDone ? " — mockspec은 갱신됐고 mock은 아직입니다. `specmock generate <system>`으로 반영하세요" : ""}`);
      result.applied = null;
    }
  }
  return { result, driftPath: result.driftPath, driftMarkdown, notes };
}
