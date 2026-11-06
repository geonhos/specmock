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

it("workspaceDir이 있으면 상태를 그곳에 쓴다(없으면 <root>/.specmock)", async () => {
  const workspaceDir = path.join(root, "state");
  const s = await startUiServer({ root, webDir, workspaceDir });
  try {
    const { stat } = await import("node:fs/promises");
    expect((await stat(workspaceDir)).isDirectory()).toBe(true);
    await expect(stat(path.join(root, ".specmock"))).rejects.toThrow();
  } finally { await s.close(); }
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

it("SSE로 작업 공간 변경을 알리고, 연결이 열려 있어도 close가 끝난다", async () => {
  const s = await startUiServer({ root, webDir });
  const res = await fetch(new URL("/api/events", s.url));
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  const pump = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true })); if (done) return; text += value; if (text.includes("workspace-changed")) return; } })();
  await new Promise((r) => setTimeout(r, 100));
  await mkdir(path.join(root, ".specmock", "pets"), { recursive: true });
  await writeFile(path.join(root, ".specmock", "pets", "selection.json"), "{}");
  await pump;
  expect(text).toMatch(/event: ready[\s\S]*event: workspace-changed\ndata: \{"system":"pets","files":\[[^\]]*"selection\.json"/);
  await s.close();
});

it("close는 진행 중인 작업이 끝나길 기다린다", async () => {
  const { JobManager } = await import("../src/jobs.js");
  const { EventBus } = await import("../src/bus.js");
  const jobs = new JobManager(new EventBus());
  let done = false;
  jobs.start("a", "extract", ({ signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => setTimeout(() => { done = true; rej(signal.reason); }, 80))));
  jobs.cancelAll();
  await jobs.whenIdle(5000);
  expect(done).toBe(true);
});
