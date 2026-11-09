import { access, readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { LlmAdapter } from "../llm/adapter.js";
import { ClaudeCodeAdapter } from "../llm/claudeCode.js";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { ExistingSources, GenerateProgress, GenerateReport, LanguageGenerator } from "./generator.js";
import { matchesAny } from "./glob.js";
import { ATTEMPT_DIR, LlmGenerator } from "./llm.js";
import { LOCK_FILE, launchHint, readLock, writeLock, type Lock } from "./lock.js";
import { SUPPORTED_LANGUAGES, assertLanguage, getEntry, getProfile, type LanguageProfile } from "./profiles/index.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { TS_FIXED_FILES, TsHonoGenerator } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
  /** 명시 언어. 없으면 lock.language, 그것도 없으면 "ts". */
  language?: string;
  /** ts가 아닌 언어의 LLM 경로. 기본 claude-code. */
  llm?: "claude-code";
  /** claude-code 모델(--model). adapter를 주면 무시. */
  model?: string;
  /** 테스트·호출자가 어댑터를 직접 줄 때. */
  adapter?: LlmAdapter;
  maxAttempts?: number;
  onProgress?: (e: GenerateProgress) => void;
  signal?: AbortSignal;
  /** 테스트 전용: 등록표 대신 이 프로필로 생성한다(language는 profile.language). */
  profile?: LanguageProfile;
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

/** 비어 있지 않고 specmock이 만든 흔적(lock)이 없는 디렉터리는 force 없이 덮어쓰지 않는다. 실패 시도 디렉터리만 있으면 specmock 것으로 본다. */
async function assertSafeOutDir(outDir: string): Promise<void> {
  const names = (await readdir(outDir).catch(() => [] as string[])).filter((n) => n !== ATTEMPT_DIR);
  if (names.length > 0 && !names.includes(LOCK_FILE)) {
    throw new Error(`${outDir}은(는) specmock이 만든 디렉터리가 아닙니다(${LOCK_FILE} 없음). 덮어쓰려면 --force`);
  }
}

const SKIP_DIRS = new Set(["node_modules", "target", ".git", ATTEMPT_DIR]);

/** outDir 아래 파일의 상대 경로(`/` 구분). 빌드 산출물 디렉터리는 건너뛴다. */
async function listFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...(await listFiles(root, r))); }
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** 증분 입력: sourceGlobs 안·보호 경로 밖·정적 파일 아닌 기존 파일. lock.sourceFiles 해시와 다르면 userModified. */
async function readExisting(outDir: string, profile: LanguageProfile, previous: Lock): Promise<ExistingSources> {
  const statics = new Set(profile.staticFiles.map((s) => s.path));
  const files: ExistingSources["files"] = [];
  for (const rel of await listFiles(outDir)) {
    if (statics.has(rel) || !matchesAny(profile.sourceGlobs, rel) || matchesAny(profile.protectedPaths, rel)) continue;
    const content = await readFile(path.join(outDir, rel), "utf8");
    const recorded = previous.sourceFiles[rel];
    files.push({ path: rel, content, userModified: recorded !== undefined && hashText(content) !== recorded });
  }
  return { files };
}

export async function generate(ws: Workspace, system: string, opts: GenerateOptions = {}): Promise<GenerateReport> {
  return withSystemLock(ws, system, () => generateUnlocked(ws, system, opts));
}

async function generateUnlocked(ws: Workspace, system: string, opts: GenerateOptions): Promise<GenerateReport> {
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
  if (opts.language !== undefined && !opts.profile) assertLanguage(opts.language);
  if (!opts.force) await assertSafeOutDir(outDir);
  const previous = await readLock(outDir);
  if (previous && !getEntry(previous.language) && previous.language !== opts.profile?.language) {
    throw new Error(`이 디렉터리는 '${previous.language}' 언어로 생성됐지만 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
  const language = opts.profile?.language ?? opts.language ?? previous?.language ?? "ts";
  if (previous && previous.language !== language) {
    if (!opts.force) throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요`);
    await clearForLanguageChange(outDir, previous);
  }
  await rm(path.join(outDir, ATTEMPT_DIR), { recursive: true, force: true });

  const mockspecHash = hashJson(spec);
  const profile = language === "ts" ? null : (opts.profile ?? getProfile(language));
  if (language !== "ts" && !profile) throw new Error(`'${language}' 언어 프로필이 없습니다.`);
  const sameLanguage = previous !== null && previous.language === language;

  // LLM 생성은 비싸다: mockspec이 같으면 다시 부르지 않는다(--force로 강제).
  if (profile && previous && sameLanguage && previous.generator === "llm" && previous.mockspecHash === mockspecHash && !opts.force) {
    const prior = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
    const keepNotes = prior && path.resolve(prior.outDir) === outDir ? (prior.notes ?? []) : [];
    await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language, notes: keepNotes, attempts: prior?.attempts ?? 0 });
    return {
      outDir, language, written: [], preserved: [], orphaned: [],
      launch: launchHint(outDir, previous), attempts: 0, notes: [], userModified: [], skipped: true,
    };
  }

  const existing = profile && previous && sameLanguage && previous.generator === "llm" ? await readExisting(outDir, profile, previous) : null;
  const generator: LanguageGenerator = profile
    ? new LlmGenerator(profile, opts.adapter ?? new ClaudeCodeAdapter({ model: opts.model }), { maxAttempts: opts.maxAttempts })
    : new TsHonoGenerator();
  const output = await generator.generate({ spec, outDir, existing, signal: opts.signal, onProgress: opts.onProgress });

  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  const sourceFiles: Record<string, string> = {};
  const statics = new Set((profile?.staticFiles ?? []).map((x) => x.path));
  for (const f of output.files) if (f.content !== null && !statics.has(f.path)) sourceFiles[f.path] = hashText(f.content);
  await writeLock(outDir, {
    system: spec.system,
    language,
    generator: generator.generator,
    mockspecHash,
    generatedAt: new Date().toISOString(),
    install: output.install,
    installCheck: output.installCheck ?? null,
    start: output.start,
    healthPath: output.healthPath,
    startTimeoutMs: output.startTimeoutMs,
    installTimeoutMs: output.installTimeoutMs,
    fixtureHashes: s.fixtureHashes,
    sourceFiles,
  });
  const attempts = output.attempts ?? 0;
  // verify가 --dir 없이도 마지막 생성 위치를 찾을 수 있도록 기록한다.
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language, notes: output.notes, attempts });
  const userModified = (existing?.files ?? [])
    .filter((e) => e.userModified && output.files.some((o) => o.path === e.path && o.content !== e.content))
    .map((e) => e.path);
  return {
    outDir, language, written, preserved: s.preserved, orphaned: s.orphaned,
    launch: launchHint(outDir, { language, install: output.install, start: output.start }),
    attempts, notes: output.notes, userModified, skipped: false,
  };
}
