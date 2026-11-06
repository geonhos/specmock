import { access, constants } from "node:fs/promises";
import path from "node:path";

/** PATH에서 실행 파일을 찾는다. 경로 구분자가 들어 있으면 그 경로만 본다. 없으면 null. */
export async function findExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates = cmd.includes(path.sep) ? [cmd] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd));
  for (const file of candidates) {
    try { await access(file, constants.X_OK); return file; } catch { /* 다음 */ }
  }
  return null;
}
