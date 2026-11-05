import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "../src/root.js";
import { connect } from "./helpers.js";

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
