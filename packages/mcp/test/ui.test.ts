import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, PETSTORE, SERVER, type Session } from "./helpers.js";

let dir: string;
let s: Session | undefined;
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-mcp-ui-"))); });
afterEach(async () => { await s?.close(); s = undefined; await rm(dir, { recursive: true, force: true }); });

describe("open_ui", () => {
  it("http://127.0.0.1:<port>/ URL을 돌려주고 두 번 불러도 같으며, 같은 작업 공간을 쓴다", async () => {
    s = await connect(dir);
    const a = await s.ok("open_ui", {});
    const b = await s.ok("open_ui", {});
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(b.url).toBe(a.url);
    const env = await (await fetch(new URL("/api/env", a.url))).json();
    expect(env.data.root).toBe(dir);
  });

  it("stdin이 닫히면 화면 서버가 떠 있어도 MCP 프로세스가 끝난다", async () => {
    const child = spawn(process.execPath, [SERVER], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += String(b); });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await vi_waitFor(() => out.includes('"id":1'));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_ui", arguments: {} } });
    await vi_waitFor(() => out.includes('"id":2'));
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
    expect(url).toBeTruthy();
    const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 5000))]);
    if (code === "timeout") child.kill("SIGKILL");
    expect(code).not.toBe("timeout");
  }, 30_000);

  it("화면에서 검증이 진행 중이어도 stdin이 닫히면 작업을 취소하고 수 초 안에 끝나며 자식이 남지 않는다", async () => {
    const bin = path.join(dir, "fakebin");
    await mkdir(bin);
    await writeFile(path.join(bin, "npm"), "#!/bin/sh\necho $$ > \"$FAKE_NPM_PID\"\nexec sleep 60\n");
    await chmod(path.join(bin, "npm"), 0o755);
    const pidFile = path.join(dir, "npm.pid");
    const child = spawn(process.execPath, [SERVER], { cwd: dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_NPM_PID: pidFile }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => { out += String(b); });
    child.stderr.on("data", (b: Buffer) => { err += String(b); });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await vi_waitFor(() => out.includes('"id":1'));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_ui", arguments: {} } });
    await vi_waitFor(() => out.includes('"id":2'));
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)![0];
    const api = async (p: string, body?: unknown) => (await fetch(new URL(`/api${p}`, url), body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    await api("/systems", { system: "petstore", origins: [PETSTORE] });
    await api("/systems/petstore/analyze", {});
    const features = await api("/systems/petstore/features");
    await api("/systems/petstore/selection", { ids: features.data.rows.slice(0, 2).map((r: { id: string }) => r.id) });
    await api("/systems/petstore/generate", {});
    for (let i = 0; i < 100 && (await api("/jobs")).data.running.length > 0; i++) await new Promise((r) => setTimeout(r, 50));
    await api("/systems/petstore/verify", {});
    for (let i = 0; i < 200 && !(await stat(pidFile).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 50));
    const npmPid = Number((await readFile(pidFile, "utf8")).trim());
    const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 8000))]);
    if (code === "timeout") child.kill("SIGKILL");
    expect(code, err).not.toBe("timeout");
    expect(err).not.toMatch(/EPERM|Error:/);
    expect(() => process.kill(npmPid, 0)).toThrow(); // 자식이 남지 않았다
  }, 60_000);
});

async function vi_waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("시간 초과"); await new Promise((r) => setTimeout(r, 25)); }
}
