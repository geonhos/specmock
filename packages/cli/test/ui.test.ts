import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCommand } from "../src/commands/ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "dist", "cli.js");
const PETSTORE = path.resolve(here, "..", "..", "core", "test", "fixtures", "petstore.yaml");

let dir: string;
const children: ReturnType<typeof spawn>[] = [];
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-cli-ui-"))); });
afterEach(async () => { for (const c of children) c.kill("SIGKILL"); children.length = 0; await rm(dir, { recursive: true, force: true }); });

/** `specmock ui ...`를 띄우고 URL이 찍힐 때까지 기다린다. */
async function start(...args: string[]) {
  const child = spawn(process.execPath, [CLI, "ui", "--no-open", ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr!.on("data", (b: Buffer) => { err += String(b); });
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (b: Buffer) => { out += String(b); const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(out); if (m) resolve(m[0]); });
    child.once("exit", (c) => reject(new Error(`exit ${c}: ${err}`)));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, url, exited };
}

describe("specmock ui", () => {
  it("--no-open: URL을 찍고 /api/env가 응답하고 SIGINT로 정상 종료하며 포트를 놓는다", async () => {
    const { child, url, exited } = await start();
    const env = await (await fetch(new URL("/api/env", url))).json();
    expect(env.data.root).toBe(dir);
    child.kill("SIGINT");
    expect(await exited).toEqual({ code: 0, signal: null });
    await expect(fetch(new URL("/api/env", url))).rejects.toThrow();
  }, 30_000);

  it("SIGTERM도 같다", async () => {
    const { child, exited } = await start();
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
  }, 30_000);

  it("--workspace를 따른다", async () => {
    const { child, url, exited } = await start("--workspace", "state");
    const res = await fetch(new URL("/api/systems", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: "petstore", origins: [PETSTORE] }) });
    expect(res.status).toBe(200);
    expect((await stat(path.join(dir, "state", "petstore"))).isDirectory()).toBe(true);
    await expect(stat(path.join(dir, ".specmock", "petstore"))).rejects.toThrow();
    child.kill("SIGINT"); await exited;
  }, 30_000);

  it("--port를 따른다", async () => {
    const { child, url, exited } = await start("--port", "47631");
    expect(url).toBe("http://127.0.0.1:47631/");
    child.kill("SIGINT"); await exited;
  }, 30_000);

  it("열기 명령: darwin=open, linux=xdg-open, win32=cmd /c start", () => {
    expect(openCommand("darwin", "http://x/")).toEqual(["open", ["http://x/"]]);
    expect(openCommand("linux", "http://x/")).toEqual(["xdg-open", ["http://x/"]]);
    expect(openCommand("win32", "http://x/")).toEqual(["cmd", ["/c", "start", "", "http://x/"]]);
  });
});
