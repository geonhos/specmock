import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startUiServer } from "../src/server.js";

let root: string, webDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "specmock-ui-"));
  webDir = path.join(root, "web");
  await mkdir(webDir);
  await writeFile(path.join(webDir, "index.html"), "<!doctype html>");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("127.0.0.1의 자동 포트에 뜨고 close로 내려간다", async () => {
  const s = await startUiServer({ root, webDir });
  expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const r = await fetch(new URL("/api/env", s.url));
  expect((await r.json()).ok).toBe(true);
  await s.close();
  await expect(fetch(new URL("/api/env", s.url))).rejects.toThrow();
});

it("지정 포트가 사용 중이면 명확한 오류", async () => {
  const blocker = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const port = (blocker.address() as { port: number }).port;
  await expect(startUiServer({ root, webDir, port })).rejects.toThrow(`포트 ${port}을(를) 이미 쓰고 있어요`);
  blocker.close();
});

it("웹 빌드가 없으면 pnpm build 안내", async () => {
  await expect(startUiServer({ root, webDir: path.join(root, "none") })).rejects.toThrow("`pnpm build`를 먼저 실행하세요");
});
