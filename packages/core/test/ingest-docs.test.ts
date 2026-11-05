import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { detectInteractive, htmlToMarkdown } from "../src/ingest/html.js";
import { ingest, ingestOne } from "../src/ingest/index.js";
import { SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, "fixtures", "docs");

describe("htmlToMarkdown", () => {
  it("keeps headings, code blocks and tables, drops nav/footer", async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    const { title, markdown } = htmlToMarkdown(html, "https://x.test/docs");
    expect(title).toBe("Pets API Reference");
    expect(markdown).toMatch(/^# Pets API Reference$/m);
    expect(markdown).toContain("## List pets");
    expect(markdown).toContain('[{"id": 1, "name": "Rex", "tag": "dog"}]');
    expect(markdown).toMatch(/\| *Field *\| *Type *\|/);
    expect(markdown).not.toContain("© Example");
  });

  it("detects interactive elements with reasons", async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    const r = detectInteractive(html, 5000);
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringContaining("select"), expect.stringContaining("tab"), expect.stringContaining("details")]));
    expect(detectInteractive("<html><body><p>" + "x".repeat(3000) + "</p></body></html>", 3000).reasons).toEqual([]);
    expect(detectInteractive("<html><body><p>short</p></body></html>", 5).reasons).toEqual(["본문 2,000자 미만"]);
  });
});

describe("ingestOne for documents", () => {
  it("keeps markdown as is", async () => {
    const input = await ingestOne(path.join(DOCS, "pets.md"));
    expect(input.kind).toBe("markdown");
    expect(input.content).toContain("## Get a pet");
    expect(input.title).toBe("Pets API");
  });

  it("extracts text from a pdf", async () => {
    const input = await ingestOne(path.join(DOCS, "pets.pdf"));
    expect(input.kind).toBe("pdf");
    expect(input.content).toContain("GET /pets/{petId} returns one pet.");
  });

  it("treats unknown extensions as text", async () => {
    const input = await ingestOne(path.join(DOCS, "make-pdf.mjs"));
    expect(input.kind).toBe("text");
  });
});

describe("ingest over http", () => {
  let server: Server; let base: string; let hits = 0;
  beforeAll(async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === "/docs") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); return; }
      if (req.url === "/spec") { res.setHeader("content-type", "application/yaml"); res.end("openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths: {}\n"); return; }
      res.statusCode = 404; res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  let dir: string; let ws: Workspace;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-ingest-")); ws = new Workspace(dir); hits = 0; });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("detects html by content-type, converts to markdown and flags a harvest candidate", async () => {
    await ingest(ws, "pets", [`${base}/docs`]);
    const src = await ws.read("pets", "source.json", SourceSchema);
    expect(src.inputs[0].kind).toBe("html");
    expect(src.inputs[0].content).toContain("## Get a pet");
    expect(src.inputs[0].harvestCandidate?.reasons.length).toBeGreaterThan(0);
    expect(src.inputs[0].harvested).toBeUndefined();
  });

  it("detects openapi by content-type even without an extension", async () => {
    await ingest(ws, "spec", [`${base}/spec`]);
    const src = await ws.read("spec", "source.json", SourceSchema);
    expect(src.inputs[0].kind).toBe("openapi");
  });

  it("reuses the cached input unless refresh is set", async () => {
    await ingest(ws, "pets", [`${base}/docs`]);
    const first = (await ws.read("pets", "source.json", SourceSchema)).inputs[0].fetchedAt;
    await ingest(ws, "pets", [`${base}/docs`]);
    expect(hits).toBe(1);
    expect((await ws.read("pets", "source.json", SourceSchema)).inputs[0].fetchedAt).toBe(first);
    await ingest(ws, "pets", [`${base}/docs`], { refresh: true });
    expect(hits).toBe(2);
  });

  it("fails clearly on 404", async () => {
    await expect(ingest(ws, "x", [`${base}/missing`])).rejects.toThrow(/HTTP 404/);
  });
});
