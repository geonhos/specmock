import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "../src/root.js";
import { connect, SERVER } from "./helpers.js";

let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-mcp-"))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("resolveRoot", () => {
  it("defaults to cwd and honours --root", () => {
    expect(resolveRoot([], "/a/b")).toBe("/a/b");
    expect(resolveRoot(["--root", "c"], "/a/b")).toBe("/a/b/c");
    expect(resolveRoot(["--root", "/x"], "/a/b")).toBe("/x");
  });
  it("rejects --root without a value", () => {
    expect(() => resolveRoot(["--root"], "/a")).toThrow(/--root/);
    expect(() => resolveRoot(["--root", "--other"], "/a")).toThrow(/--root/);
  });
});

describe("mcp server process", () => {
  it("starts over stdio, lists tools and logs its root to stderr only", async () => {
    const s = await connect(dir);
    try {
      const { tools } = await s.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      // stdout이 프로토콜 외 출력으로 오염됐다면 connect/listTools가 실패했을 것이다.
      await expect.poll(() => s.stderr()).toContain(`root=${dir}`);
    } finally { await s.close(); }
  });

  it("uses --root instead of cwd when given", async () => {
    const other = path.join(dir, "proj");
    await mkdir(other);
    const s = await connect(dir, ["--root", other]);
    try {
      await expect.poll(() => s.stderr()).toContain(`root=${other}`);
    } finally { await s.close(); }
  });
});

describe("stdout purity", () => {
  it("keeps progress logs on stderr and only JSON-RPC lines on stdout", async () => {
    const spec = path.join(dir, "api.md");
    await writeFile(spec, "# API\n\nGET /pets returns a list of pets.\n");
    const child = spawn(process.execPath, [SERVER], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const has = (id: number) => out.split("\n").some((l) => { try { return (JSON.parse(l) as { id?: number }).id === id; } catch { return false; } });
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      await expect.poll(() => has(1), { timeout: 10000 }).toBe(true);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ingest_spec", arguments: { system: "api", origins: [spec] } } });
      send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      // 응답 순서는 보장되지 않으므로 기다리는 id를 모두 확인한다.
      await expect.poll(() => has(2) && has(3), { timeout: 10000 }).toBe(true);
      const lines = out.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const l of lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: "2.0" });
      await expect.poll(() => err, { timeout: 5000 }).toContain("[ingest]");
    } finally { child.kill(); }
  });
});
