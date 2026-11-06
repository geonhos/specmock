import type { Handler } from "hono";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function readIfFile(file: string): Promise<Buffer | null> {
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

/** 웹 빌드 결과를 서빙한다. 웹 루트 밖 경로·없는 파일은 index.html(SPA 폴백). */
export function serveWeb(webDir: string): Handler {
  const base = path.resolve(webDir);
  const indexFile = path.join(base, "index.html");
  return async (c) => {
    let requested = c.req.path;
    try { requested = decodeURIComponent(requested); } catch { /* 깨진 인코딩은 그대로 두면 아래에서 폴백 */ }
    const resolved = path.resolve(base, "." + requested);
    const inside = resolved.startsWith(base + path.sep);
    const body = inside ? await readIfFile(resolved) : null;
    const file = body ? resolved : indexFile;
    const data = body ?? (await readFile(indexFile));
    const headers: Record<string, string> = {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": body && requested.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    return c.body(new Uint8Array(data), 200, headers);
  };
}
