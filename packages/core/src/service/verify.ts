import { stat } from "node:fs/promises";
import path from "node:path";
import { defaultMockDir } from "../generate/index.js";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { renderCoverage } from "../verify/coverage.js";
import { verify, type VerifyResult } from "../verify/index.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

/** 대상 mock 디렉터리: 인자 → 마지막 generate의 outDir(generate.json) → ./mock/<system>. 없으면 생성 안내 오류. */
export async function resolveMockDir(ws: Workspace, system: string, dir?: string): Promise<string> {
  const last = (await ws.exists(system, "generate.json")) ? (await ws.read(system, "generate.json", GenerateInfoSchema)).outDir : undefined;
  const resolved = path.resolve(dir ?? last ?? defaultMockDir(system));
  try { await stat(resolved); } catch {
    throw new Error(`${resolved} 이(가) 없습니다. 먼저 specmock generate ${system} 을 실행하거나 --dir 로 경로를 지정하세요.`);
  }
  return resolved;
}

export interface VerifyMockResult { dir: string; result: VerifyResult; coverageFile: string; coverageMarkdown: string }

/** mock을 띄워 contract test를 돌리고 .specmock/<system>/coverage.md를 쓴다. */
export async function verifyMock(ws: Workspace, system: string, opts: { dir?: string; onEvent?: OnEvent; signal?: AbortSignal } = {}): Promise<VerifyMockResult> {
  const dir = await resolveMockDir(ws, system, opts.dir);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const runtime = { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) };
  const result = await verify(dir, { onLog: (message) => opts.onEvent?.({ stage: "verify", message }), signal: opts.signal, runtime });
  // 생성 메모는 마지막 generate가 같은 디렉터리일 때만 붙인다.
  const info = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
  const notes = info && path.resolve(info.outDir) === dir ? (info.notes ?? []) : [];
  const coverageMarkdown = renderCoverage(spec, result, notes);
  const coverageFile = await ws.writeText(system, "coverage.md", coverageMarkdown);
  return { dir, result, coverageFile, coverageMarkdown };
}
