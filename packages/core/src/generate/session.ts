// packages/core/src/generate/session.ts
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import { matchesAny } from "./glob.js";
import { assertNoVcsMarkers, assertSafeOutDir, clearForLanguageChange, defaultMockDir, languageChangeTargets, listFiles, readExisting, SESSION_MARKER } from "./index.js";
import { readStaticFiles } from "./llm.js";
import { readLock, writeLock } from "./lock.js";
import { assertLanguage, getProfile, type LanguageProfile } from "./profiles/index.js";
import { buildGenerateRequest, GenerateRequestSchema } from "./request.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";

export { SESSION_MARKER } from "./index.js";
const INSTALLED_MARKER = ".specmock-installed";
export const REQUEST_FILE = "generate-request.json";

export interface PrepareGenerationOptions {
  outDir?: string;
  force?: boolean;
  /** 생성 언어. 없으면 lock.language. ts는 세션 모드가 필요 없어 거부한다. */
  language?: string;
  /** 테스트 전용 프로필 주입. */
  profile?: LanguageProfile;
}

export interface PrepareGenerationResult {
  mode: "session";
  requestPath: string;
  outDir: string;
  language: string;
  /** 같은 mockspec의 지시서가 이미 있어 다시 쓰지 않았다. */
  reused: boolean;
  nextSteps: string[];
}

export type FinalizeReason = "no-request" | "stale-request" | "protected-path-modified" | "no-sources" | "too-many-files";
export type FinalizeResult =
  | { ok: true; outDir: string; written: string[]; warnings: string[] }
  | { ok: false; reason: FinalizeReason; errors: string[] };

function nextSteps(system: string, requestPath: string, outDir: string, profile: LanguageProfile): string[] {
  const install = profile.install(process.platform);
  return [
    `1. 지시서를 읽는다: ${requestPath} (prompt 필드가 전체 지시다)`,
    `2. ${outDir} 아래 ${profile.sourceGlobs.join(", ")} 범위에만 파일을 쓴다. ${profile.protectedPaths.join(", ")}는 건드리지 않는다.`,
    install ? `3. ${outDir}에서 ${[install.command, ...install.args].join(" ")}로 빌드가 되는지 확인하고 오류를 고친다.` : "3. 빌드 단계는 없다.",
    `4. finalize_generation(system: "${system}") — CLI: specmock generate ${system} --finalize`,
    `5. verify_mock(system: "${system}") — 실패하면 고친 뒤 4~5를 반복한다.`,
  ];
}

/** 보호 경로 비교 대상: 보호 경로 중 진행 표식·설치 마커·프로필 산출물(target 등)은 verify가 만들므로 제외한다. */
function isCompared(rel: string, profile: LanguageProfile): boolean {
  if (!matchesAny(profile.protectedPaths, rel) || rel === SESSION_MARKER || rel === INSTALLED_MARKER) return false;
  return !profile.artifacts.some((a) => rel === a || rel.startsWith(`${a}/`));
}

/** 보호 경로 파일의 현재 해시(지시서 작성 시점·finalize 성공 시점과 finalize 시점 비교용). */
async function protectedHashes(outDir: string, profile: LanguageProfile): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(outDir)) {
    if (isCompared(rel, profile)) out[rel] = hashText(await readFile(path.join(outDir, rel), "utf8"));
  }
  return out;
}

const SessionMarkerSchema = z.object({
  system: z.string(),
  language: z.string(),
  mockspecHash: z.string(),
  /** --force 언어 변경이면 이전 lock의 언어·소스. finalize가 성공 직전에 정리한다. */
  previous: z.object({ language: z.string(), sourceFiles: z.record(z.string(), z.string()) }).optional(),
});

export async function readSessionMarker(outDir: string): Promise<z.infer<typeof SessionMarkerSchema> | null> {
  try {
    return SessionMarkerSchema.parse(JSON.parse(await readFile(path.join(outDir, SESSION_MARKER), "utf8")));
  } catch {
    return null;
  }
}

/** 세션 모드 1단계: 지시서를 쓰고 정적 파일을 outDir에 둔 뒤 멈춘다. 파일 작성은 대화 속 Claude가 한다. */
export async function prepareGeneration(ws: Workspace, system: string, opts: PrepareGenerationOptions = {}): Promise<PrepareGenerationResult> {
  return withSystemLock(ws, system, async () => {
    const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
    const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
    if (!opts.force) await assertSafeOutDir(outDir);
    const previous = await readLock(outDir);
    const language = opts.profile?.language ?? opts.language ?? previous?.language;
    if (!language || language === "ts") throw new Error("세션 모드는 ts가 아닌 언어에만 씁니다. ts는 generate_mock(또는 specmock generate)이 바로 만듭니다.");
    if (!opts.profile) assertLanguage(language);
    const profile = opts.profile ?? getProfile(language);
    if (!profile) throw new Error(`'${language}' 언어 프로필이 없습니다.`);
    if (previous && previous.language !== language && !opts.force) {
      throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 강제 덮어쓰기(force: 기존 소스 삭제) 또는 다른 출력 디렉터리를 쓰세요`);
    }
    const languageChange = previous !== null && previous.language !== language;
    if (languageChange) await assertNoVcsMarkers(outDir);
    const requestPath = ws.file(system, REQUEST_FILE);
    const mockspecHash = hashJson(spec);

    if (await ws.exists(system, REQUEST_FILE)) {
      const old = await ws.read(system, REQUEST_FILE, GenerateRequestSchema);
      if (old.mockspecHash === mockspecHash && old.language === language && old.outDir === outDir) {
        return { mode: "session", requestPath, outDir, language, reused: true, nextSteps: nextSteps(system, requestPath, outDir, profile) };
      }
    }

    const existing = previous && previous.language === language && previous.generator === "llm" ? await readExisting(outDir, profile, previous) : null;
    await mkdir(outDir, { recursive: true });
    await writeLanguageFiles(outDir, { files: await readStaticFiles(profile), install: null, start: profile.start, healthPath: profile.healthPath, notes: [] }, []);
    await writeFile(path.join(outDir, SESSION_MARKER), JSON.stringify({ system, language, mockspecHash, ...(languageChange ? { previous: { language: previous.language, sourceFiles: previous.sourceFiles } } : {}) }, null, 2) + "\n", "utf8");
    const req = await buildGenerateRequest({ spec, profile, outDir, existing, mockspecHash });
    req.protectedHashes = await protectedHashes(outDir, profile);
    await ws.write(system, REQUEST_FILE, GenerateRequestSchema, req);
    return { mode: "session", requestPath, outDir, language, reused: false, nextSteps: nextSteps(system, requestPath, outDir, profile) };
  });
}

/** 세션 모드 2단계: Claude가 쓴 파일을 확정한다. 컴파일하지 않는다(verify의 일). 실패는 예외가 아니라 ok:false. */
export async function finalizeGeneration(ws: Workspace, system: string, opts: { profile?: LanguageProfile } = {}): Promise<FinalizeResult> {
  return withSystemLock(ws, system, async () => {
    if (!(await ws.exists(system, REQUEST_FILE))) {
      return { ok: false, reason: "no-request", errors: [`${REQUEST_FILE}이 없습니다. generate_mock(language)을 먼저 호출하세요`] };
    }
    const req = await ws.read(system, REQUEST_FILE, GenerateRequestSchema);
    const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
    const mockspecHash = hashJson(spec);
    if (req.mockspecHash !== mockspecHash) {
      return { ok: false, reason: "stale-request", errors: ["select가 바뀌었습니다. generate_mock을 다시 호출하세요"] };
    }
    const profile = opts.profile ?? getProfile(req.language);
    if (!profile) throw new Error(`'${req.language}' 언어 프로필이 없습니다.`);
    const outDir = req.outDir;
    const files = await listFiles(outDir);

    const changed = files.filter((rel) => isCompared(rel, profile)).filter((rel) => req.protectedHashes[rel] === undefined);
    for (const [rel, hash] of Object.entries(req.protectedHashes)) {
      const now = files.includes(rel) ? hashText(await readFile(path.join(outDir, rel), "utf8")) : null;
      if (now !== hash) changed.push(rel);
    }
    if (changed.length) return { ok: false, reason: "protected-path-modified", errors: changed.sort() };

    const statics = new Set(profile.staticFiles.map((s) => s.path));
    // --force 언어 변경: 이전 언어의 소스·산출물은 새 소스로 세지 않고, 성공 직전에 지운다.
    const marker = await readSessionMarker(outDir);
    const stale = new Set(marker?.previous ? await languageChangeTargets(outDir, marker.previous) : []);
    const sources = files.filter((rel) => !stale.has(rel) && !statics.has(rel) && rel !== SESSION_MARKER && matchesAny(profile.sourceGlobs, rel) && !matchesAny(profile.protectedPaths, rel));
    if (sources.length === 0) return { ok: false, reason: "no-sources", errors: [`${profile.sourceGlobs.join(", ")} 범위에 파일이 없습니다`] };
    if (sources.length > profile.maxFiles) return { ok: false, reason: "too-many-files", errors: [`파일 ${sources.length}개 > 최대 ${profile.maxFiles}개`] };

    const previous = await readLock(outDir);
    if (marker?.previous) await clearForLanguageChange(outDir, marker.previous);
    const written: string[] = [];
    const s = await writeScaffold(spec, outDir, previous, {}, written);
    const sourceFiles: Record<string, string> = {};
    for (const rel of sources) sourceFiles[rel] = hashText(await readFile(path.join(outDir, rel), "utf8"));
    await writeLock(outDir, {
      system: spec.system,
      language: profile.language,
      generator: "llm",
      mockspecHash,
      generatedAt: new Date().toISOString(),
      install: profile.install(process.platform),
      installCheck: profile.installCheck ?? null,
      installInputs: profile.installInputs ?? [],
      start: profile.start,
      healthPath: profile.healthPath,
      startTimeoutMs: profile.startTimeoutMs,
      installTimeoutMs: profile.installTimeoutMs,
      fixtureHashes: s.fixtureHashes,
      sourceFiles,
    });
    await rm(path.join(outDir, SESSION_MARKER), { force: true });
    // 재finalize: 지금의 보호 파일(방금 쓴 fixtures·contracts·lock 포함)을 새 기준으로 삼는다. 원자적으로 쓴다.
    const refreshed = GenerateRequestSchema.parse({ ...req, protectedHashes: await protectedHashes(outDir, profile) });
    const reqFile = ws.file(system, REQUEST_FILE);
    await writeFile(`${reqFile}.tmp`, JSON.stringify(refreshed, null, 2) + "\n", "utf8");
    await rename(`${reqFile}.tmp`, reqFile);
    await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language: profile.language, notes: [], attempts: 0 });
    const warnings = [
      ...s.preserved.map((p) => `사용자 수정 fixture 보존: ${p}`),
      ...s.orphaned.map((p) => `선택에서 빠진 fixture가 남아 있음: ${p}`),
    ];
    return { ok: true, outDir, written, warnings };
  });
}
