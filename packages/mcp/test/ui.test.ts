import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, SERVER, type Session } from "./helpers.js";

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
});

async function vi_waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("시간 초과"); await new Promise((r) => setTimeout(r, 25)); }
}
