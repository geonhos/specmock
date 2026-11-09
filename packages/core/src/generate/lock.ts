// packages/core/src/generate/lock.ts
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const LOCK_FILE = "specmock.lock.json";

const CommandSchema = z.object({ command: z.string(), args: z.array(z.string()) });

/** outDir 안의 상대 경로만 허용: 절대 경로·`..` 세그먼트·백슬래시는 손상된 lock으로 본다. */
const SafeRelPath = z.string().refine(
  (p) => p.length > 0 && !p.includes("\\") && !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p) && !p.split("/").includes(".."),
  { message: "outDir 밖을 가리키는 경로" },
);

export const LockSchema = z.object({
  system: z.string(),
  /** 열린 문자열. 허용 여부는 사용자 입력 단계에서 프로필 등록표로 검사한다. */
  language: z.string().min(1),
  generator: z.enum(["llm", "template"]).default("template"),
  mockspecHash: z.string(),
  generatedAt: z.string(),
  /** 없음(undefined) = 2단계 lock = npm install. null = 설치 단계 없음. */
  install: CommandSchema.nullable().optional(),
  /** 설치 뒤 outDir 상대 경로로 존재해야 하는 파일/디렉터리. undefined = 옛 lock(node_modules), null = 검사 없음. */
  installCheck: z.string().nullable().optional(),
  /** 설치 키에 넣을 입력(outDir 상대 경로 또는 glob). sourceFiles 중 맞는 파일의 해시가 키에 들어간다. undefined = 옛 lock = []. */
  installInputs: z.array(z.string()).optional(),
  start: CommandSchema,
  healthPath: z.string(),
  startTimeoutMs: z.number().int().positive().optional(),
  installTimeoutMs: z.number().int().positive().optional(),
  fixtureHashes: z.record(z.string(), z.string()),
  /** 언어 종속 파일의 생성 시 해시. 증분 생성의 userModified 판정과 설치 키에 쓴다. */
  sourceFiles: z.record(SafeRelPath, z.string()).default({}),
});
export type Lock = z.infer<typeof LockSchema>;
export type LockInput = z.input<typeof LockSchema>;

export const NPM_INSTALL = { command: "npm", args: ["install", "--no-audit", "--no-fund", "--loglevel=error"] };

/** lock의 설치 명령. 옛 lock(install 필드 없음)은 npm install. */
export function resolveInstall(lock: Lock): { command: string; args: string[] } | null {
  return lock.install === undefined ? NPM_INSTALL : lock.install;
}

/** 설치 키 입력. 옛 lock(installInputs 없음)은 [] = 명령만 해시한다(2단계 동작). */
export function resolveInstallInputs(lock: Pick<Lock, "installInputs">): string[] {
  return lock.installInputs ?? [];
}

/** 설치 뒤 있어야 하는 경로. 옛 lock(installCheck 없음)은 node_modules, null이면 검사하지 않는다. */
export function resolveInstallCheck(lock: Pick<Lock, "installCheck">): string | null {
  return lock.installCheck === undefined ? "node_modules" : lock.installCheck;
}

/** lock 파일을 읽는다. 없으면 null, 있는데 손상됐으면 던진다(조용히 무시하면 보존 판단이 틀어진다). */
export async function readLock(dir: string): Promise<Lock | null> {
  const file = path.join(dir, LOCK_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return LockSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${file}: specmock.lock.json이 손상되었습니다. 파일을 삭제하고 specmock generate <system> --force 로 다시 생성하세요.`);
  }
}

export async function writeLock(dir: string, lock: LockInput): Promise<void> {
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify(LockSchema.parse(lock), null, 2) + "\n", "utf8");
}

const quoteArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const joinCommand = (c: { command: string; args: string[] }) => [c.command, ...c.args].map(quoteArg).join(" ");

/** 사용자가 mock을 직접 띄우는 명령. ts는 package.json 스크립트가 있으므로 지금 문구 그대로. */
export function launchCommand(lock: Pick<Lock, "language" | "install" | "start">): string {
  if (lock.language === "ts") return "npm install && npm start";
  const install = lock.install === undefined ? NPM_INSTALL : lock.install;
  return [install ? joinCommand(install) : null, joinCommand(lock.start)].filter(Boolean).join(" && ");
}

export function launchHint(outDir: string, lock: Pick<Lock, "language" | "install" | "start">): string {
  return `cd ${quoteArg(outDir)} && ${launchCommand(lock)}`;
}
