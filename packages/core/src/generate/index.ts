import { access, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { GenerateReport } from "./generator.js";
import { LOCK_FILE, launchHint, readLock, writeLock, type Lock } from "./lock.js";
import { SUPPORTED_LANGUAGES, assertLanguage, getEntry } from "./profiles/index.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { TS_FIXED_FILES, TsHonoGenerator } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
  /** 명시 언어. 없으면 lock.language, 그것도 없으면 "ts". */
  language?: string;
}

const INSTALLED_MARKER = ".specmock-installed";

/**
 * --force로 언어를 바꿀 때 지우는 것은 화이트리스트뿐이다: 이전 lock의 sourceFiles, 이전 언어의 빌드 산출물, 설치 마커.
 * 옛 TS lock(sourceFiles 없음)은 TS 고정 파일과 src/routes/*.ts를 쓴다. 비게 된 디렉터리는 지운다.
 */
async function clearForLanguageChange(outDir: string, previous: Lock): Promise<void> {
  for (const marker of [".git", ".specmock"]) {
    if (await access(path.join(outDir, marker)).then(() => true, () => false)) {
      throw new Error(`${outDir}에 .git 또는 .specmock이 있어 언어를 바꿀 수 없습니다. --out으로 다른 디렉터리를 지정하세요`);
    }
  }
  const targets = new Set(Object.keys(previous.sourceFiles));
  if (targets.size === 0 && previous.language === "ts") {
    for (const f of TS_FIXED_FILES) targets.add(f);
    for (const n of await readdir(path.join(outDir, "src", "routes")).catch(() => [] as string[])) if (n.endsWith(".ts")) targets.add(`src/routes/${n}`);
  }
  for (const a of getEntry(previous.language)?.artifacts ?? []) targets.add(a);
  targets.add(INSTALLED_MARKER);
  const dirs = new Set<string>();
  for (const rel of targets) {
    await rm(path.join(outDir, rel), { recursive: true, force: true });
    for (let d = path.posix.dirname(rel); d !== "." && d !== "/"; d = path.posix.dirname(d)) dirs.add(d);
  }
  // 깊은 디렉터리부터 비어 있을 때만 지운다.
  for (const d of [...dirs].sort((x, y) => y.length - x.length)) await rmdir(path.join(outDir, d)).catch(() => undefined);
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
  if (previous && !getEntry(previous.language)) {
    throw new Error(`이 디렉터리는 '${previous.language}' 언어로 생성됐지만 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
  const language = opts.language ?? previous?.language ?? "ts";
  if (previous && previous.language !== language) {
    if (!opts.force) throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요`);
    await clearForLanguageChange(outDir, previous);
  }
  const output = await new TsHonoGenerator().generate({ spec, outDir, existing: null });
  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  const sourceFiles: Record<string, string> = {};
  for (const f of output.files) if (f.content !== null) sourceFiles[f.path] = hashText(f.content);
  await writeLock(outDir, {
    system: spec.system,
    language,
    generator: "template",
    mockspecHash: hashJson(spec),
    generatedAt: new Date().toISOString(),
    install: output.install,
    installCheck: output.installCheck ?? null,
    start: output.start,
    healthPath: output.healthPath,
    fixtureHashes: s.fixtureHashes,
    sourceFiles,
  });
  // verify가 --dir 없이도 마지막 생성 위치를 찾을 수 있도록 기록한다.
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString() });
  return {
    outDir, language, written, preserved: s.preserved, orphaned: s.orphaned,
    launch: launchHint(outDir, { language, install: output.install, start: output.start }),
    attempts: 0, notes: [], userModified: [], skipped: false,
  };
}
