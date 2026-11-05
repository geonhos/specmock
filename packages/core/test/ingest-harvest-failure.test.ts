import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const key = "sk_" + "live_" + "Ab1".repeat(8);

vi.mock("../src/harvest/index.js", () => ({
  isEgoBrowserAvailable: async () => true,
  harvest: async () => { throw new Error(`ego-browser 실패 key=${key}`); },
}));
vi.mock("../src/ingest/fetch.js", () => ({
  fetchOrigin: async () => ({
    bytes: new TextEncoder().encode("<html><body><main><h1>Docs</h1><p>hello</p></main></body></html>"),
    contentType: "text/html", charset: "utf-8", finalUrl: "https://x.test/docs",
  }),
}));

import { ingest } from "../src/ingest/index.js";
import { SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

describe("ingest harvest failure note", () => {
  let dir: string; let ws: Workspace;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-hf-")); ws = new Workspace(dir); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("masks secrets in the failure note", async () => {
    const logs: string[] = [];
    await ingest(ws, "s", ["https://x.test/docs"], { harvest: "always", onLog: (m) => logs.push(m) });
    const src = await ws.read("s", "source.json", SourceSchema);
    const note = src.inputs[0]!.harvested!.notes[0]!;
    expect(note).toContain("수확 실패");
    expect(note).not.toContain(key);
    expect(note).toContain("***");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((m) => m.includes("수확 실패"))).toBe(true);
    for (const m of logs) expect(m).not.toContain(key);
  });
});
