import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
async function start(...args: string[]) { return startWith({}, ...args); }

async function startWith(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = spawn(process.execPath, [CLI, "ui", "--no-open", ...args], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr!.on("data", (b: Buffer) => { err += String(b); });
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (b: Buffer) => { out += String(b); const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(out); if (m) resolve(m[0]); });
    child.once("exit", (c) => reject(new Error(`exit ${c}: ${err}`)));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, url, exited, stderr: () => err };
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

  for (const [sig, code] of [["SIGINT", 0], ["SIGTERM", 0]] as const) {
    it(`작업(검증)이 진행 중일 때 ${sig}도 스택 없이 정상 종료하고 자식이 남지 않는다`, async () => {
      // 가짜 npm: 오래 자는 그룹. verify가 npm install 단계에서 멈춘다.
      const bin = path.join(dir, "fakebin");
      await mkdir(bin);
      await writeFile(path.join(bin, "npm"), "#!/bin/sh\necho $$ > \"$FAKE_NPM_PID\"\nexec sleep 60\n");
      await chmod(path.join(bin, "npm"), 0o755);
      const pidFile = path.join(dir, "npm.pid");
      const { child, url, exited, stderr } = await startWith({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_NPM_PID: pidFile });
      const api = async (p: string, body?: unknown) => (await fetch(new URL(`/api${p}`, url), body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      await api("/systems", { system: "petstore", origins: [PETSTORE] });
      await api("/systems/petstore/analyze", {});
      const features = await api("/systems/petstore/features");
      await api("/systems/petstore/selection", { ids: features.data.rows.slice(0, 2).map((r: { id: string }) => r.id) });
      const g = await api("/systems/petstore/generate", {});
      for (let i = 0; i < 100; i++) { if ((await api("/jobs")).data.running.length === 0) break; await new Promise((r) => setTimeout(r, 50)); }
      await api("/systems/petstore/verify", {});
      for (let i = 0; i < 200; i++) { if (await stat(pidFile).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 50)); }
      const npmPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isInteger(npmPid)).toBe(true);
      child.kill(sig);
      expect(await exited).toEqual({ code, signal: null });
      expect(stderr()).not.toMatch(/EPERM|Error:/);
      expect(() => process.kill(npmPid, 0)).toThrow(); // 자식이 남지 않았다
    }, 60_000);
  }

  it("--port에 숫자가 아닌 값을 주면 한국어 안내와 exit 1", async () => {
    for (const bad of ["abc", "-1", "70000", "80.5"]) {
      const r = spawnSync(process.execPath, [CLI, "ui", "--no-open", "--port", bad], { cwd: dir, encoding: "utf8", timeout: 20_000 });
      expect(r.status, bad).toBe(1);
      expect(r.stderr, bad).toContain("포트는 0~65535 숫자로 적어 주세요");
    }
  }, 60_000);

  it("열기 명령: darwin=open, linux=xdg-open, win32=cmd /c start", () => {
    expect(openCommand("darwin", "http://x/")).toEqual(["open", ["http://x/"]]);
    expect(openCommand("linux", "http://x/")).toEqual(["xdg-open", ["http://x/"]]);
    expect(openCommand("win32", "http://x/")).toEqual(["cmd", ["/c", "start", "", "http://x/"]]);
  });
});
