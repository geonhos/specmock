import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const LOCK_FILE = "specmock.lock.json";

export const LockSchema = z.object({
  system: z.string(),
  language: z.enum(["ts"]),
  mockspecHash: z.string(),
  generatedAt: z.string(),
  start: z.object({ command: z.string(), args: z.array(z.string()) }),
  healthPath: z.string(),
  fixtureHashes: z.record(z.string(), z.string()),
});
export type Lock = z.infer<typeof LockSchema>;

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

export async function writeLock(dir: string, lock: Lock): Promise<void> {
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify(LockSchema.parse(lock), null, 2) + "\n", "utf8");
}
