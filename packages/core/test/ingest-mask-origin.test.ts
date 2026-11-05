import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = "Zz9".repeat(8); // 24자, 런타임 조합
const apiKey = "Ab1".repeat(8);
const fetchSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/ingest/fetch.js", () => ({
  fetchOrigin: async (url: string) => {
    fetchSpy(url);
    const t = "Docs " + "Bearer " + "Zz9".repeat(8);
    return {
      bytes: new TextEncoder().encode(`<html><head><title>${t}</title></head><body><main><h1>Docs</h1><p>hello</p></main></body></html>`),
      contentType: "text/html", charset: "utf-8", finalUrl: url,
    };
  },
}));

import { ingest } from "../src/ingest/index.js";
import { Workspace } from "../src/workspace.js";

describe("ingest masks origin and title", () => {
  let dir: string; let ws: Workspace;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-mo-")); ws = new Workspace(dir); fetchSpy.mockClear(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("stores no raw secret and still reuses the cache for the same URL", async () => {
    const url = `https://x.test/docs?api_key=${apiKey}`;
    const logs: string[] = [];
    await ingest(ws, "s", [url], { harvest: "never", onLog: (m) => logs.push(m) });
    const raw = await readFile(path.join(dir, "s", "source.json"), "utf8");
    expect(raw).not.toContain(apiKey);
    expect(raw).not.toContain(token);
    expect(raw).toContain("***");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await ingest(ws, "s", [url], { harvest: "never", onLog: (m) => logs.push(m) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second.inputs[0]!.cached).toBe(true);
    for (const m of logs) expect(m).not.toContain(apiKey);
  });
});
