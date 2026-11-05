import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { harvest, isEgoBrowserAvailable } from "../src/harvest/index.js";
import { buildHarvestScript } from "../src/harvest/script.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("buildHarvestScript", () => {
  it("inlines the page functions without type annotations", () => {
    const s = buildHarvestScript({ url: "https://x.test/", outFile: "/tmp/o.json", maxPages: 1, maxDepth: 0, spaceName: "t", perPageTimeoutMs: 1000 });
    expect(s).toContain("function expandAll(");
    expect(s).toContain("function collectInteractives(");
    expect(s).not.toMatch(/:\s*Document\b/);
    expect(s).toContain('"outFile":"/tmp/o.json"');
  });
});

const available = await isEgoBrowserAvailable();

describe.skipIf(!available)("harvest with a real ego-browser", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    const html = await readFile(path.join(here, "fixtures", "docs", "pets.html"), "utf8");
    server = createServer((req, res) => {
      if (req.url === "/docs/pets") { res.setHeader("content-type", "text/html"); res.end(html); return; }
      if (req.url === "/docs") { res.setHeader("content-type", "text/html"); res.end("<html><body><main><h1>Index</h1><a href='/docs/pets'>Pets</a></main></body></html>"); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("captures tab panels, select options and follows reference links", async () => {
    const h = await harvest(`${base}/docs/pets`, { maxPages: 3, maxDepth: 1, timeoutMs: 120_000 });
    expect(h.pages.map((p) => p.url)).toEqual([`${base}/docs`]); // 시작 페이지는 input.content에 있으므로 제외
    const all = h.interactions.map((i) => `${i.type}|${i.label}|${i.content}`).join("\n");
    expect(all).toContain('await fetch("https://api.example.com/v1/pets")');     // 숨은 탭 패널
    expect(all).toContain('"code": 404');                                          // select 404 선택 후 드러난 내용
    expect(h.interactions.some((i) => i.type === "select" && /404/.test(i.label))).toBe(true);
    expect(h.interactions.some((i) => i.type === "tab" && /curl/.test(i.label))).toBe(false); // 처음부터 보이던 패널은 저장 안 함
  }, 180_000);

  it("ingest --harvest always/never attaches harvested content only when asked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "specmock-harvest-ingest-"));
    try {
      const ws = new Workspace(dir);
      await ingest(ws, "a", [`${base}/docs/pets`], { harvest: "never" });
      expect((await ws.read("a", "source.json", SourceSchema)).inputs[0].harvested).toBeUndefined();
      await ingest(ws, "b", [`${base}/docs/pets`], { harvest: "always" });
      const h = (await ws.read("b", "source.json", SourceSchema)).inputs[0].harvested;
      expect(h?.interactions.length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
