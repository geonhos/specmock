import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { GenerateReport } from "./generator.js";
import { LOCK_FILE, launchHint, readLock, writeLock } from "./lock.js";
import { assertLanguage } from "./profiles/index.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { TsHonoGenerator } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
  /** 명시 언어. 없으면 lock.language, 그것도 없으면 "ts". */
  language?: string;
}

/** --force로 언어를 바꿀 때: fixtures/·contracts/만 남기고 지운다(fixture 보존 규칙은 lock 해시로 계속 동작). */
async function clearForLanguageChange(outDir: string): Promise<void> {
  for (const name of await readdir(outDir).catch(() => [] as string[])) {
    if (name === "fixtures" || name === "contracts" || name === LOCK_FILE) continue;
    await rm(path.join(outDir, name), { recursive: true, force: true });
  }
}

export function defaultMockDir(system: string): string {
  return path.resolve("mock", system);
}

/** 비어 있지 않고 specmock이 만든 흔적(lock)이 없는 디렉터리는 force 없이 덮어쓰지 않는다. */
async function assertSafeOutDir(outDir: string): Promise<void> {
  const names = await readdir(outDir).catch(() => [] as string[]);
  if (names.length > 0 && !names.includes(LOCK_FILE)) {
    throw new Error(`${outDir}은(는) specmock이 만든 디렉터리가 아닙니다(${LOCK_FILE} 없음). 덮어쓰려면 --force`);
  }
}

export async function generate(ws: Workspace, system: string, opts: GenerateOptions = {}): Promise<GenerateReport> {
  return withSystemLock(ws, system, () => generateUnlocked(ws, system, opts));
}

async function generateUnlocked(ws: Workspace, system: string, opts: GenerateOptions): Promise<GenerateReport> {
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
  if (opts.language !== undefined) assertLanguage(opts.language);
  if (!opts.force) await assertSafeOutDir(outDir);
  const previous = await readLock(outDir);
  const language = opts.language ?? previous?.language ?? "ts";
  if (previous && previous.language !== language) {
    if (!opts.force) throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요`);
    await clearForLanguageChange(outDir);
  }
  const output = await new TsHonoGenerator().generate({ spec, outDir, existing: null });
  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  await writeLock(outDir, {
    system: spec.system,
    language,
    generator: "template",
    mockspecHash: hashJson(spec),
    generatedAt: new Date().toISOString(),
    install: output.install,
    start: output.start,
    healthPath: output.healthPath,
    fixtureHashes: s.fixtureHashes,
    sourceFiles: {},
  });
  // verify가 --dir 없이도 마지막 생성 위치를 찾을 수 있도록 기록한다.
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString() });
  return {
    outDir, language, written, preserved: s.preserved, orphaned: s.orphaned,
    launch: launchHint(outDir, { language, install: output.install, start: output.start }),
    attempts: 0, notes: [], userModified: [], skipped: false,
  };
}
