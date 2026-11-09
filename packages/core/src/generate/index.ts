import { readdir } from "node:fs/promises";
import path from "node:path";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { GenerateReport } from "./generator.js";
import { LOCK_FILE, readLock, writeLock } from "./lock.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { TsHonoGenerator } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
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
  if (!opts.force) await assertSafeOutDir(outDir);
  const previous = await readLock(outDir);
  const output = await new TsHonoGenerator().generate({ spec, outDir, existing: null });
  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  await writeLock(outDir, {
    system: spec.system,
    language: "ts",
    mockspecHash: hashJson(spec),
    generatedAt: new Date().toISOString(),
    start: output.start,
    healthPath: output.healthPath,
    fixtureHashes: s.fixtureHashes,
  });
  // verify가 --dir 없이도 마지막 생성 위치를 찾을 수 있도록 기록한다.
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString() });
  return {
    outDir, language: "ts", written, preserved: s.preserved, orphaned: s.orphaned,
    launch: `cd ${outDir} && npm install && npm start`,
    attempts: 0, notes: [], userModified: [], skipped: false,
  };
}
