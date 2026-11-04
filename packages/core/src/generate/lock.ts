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

export async function readLock(dir: string): Promise<Lock | null> {
  try {
    return LockSchema.parse(JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8")));
  } catch {
    return null;
  }
}

export async function writeLock(dir: string, lock: Lock): Promise<void> {
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify(LockSchema.parse(lock), null, 2) + "\n", "utf8");
}
