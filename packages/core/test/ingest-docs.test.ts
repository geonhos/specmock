import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { detectInteractive, htmlToMarkdown } from "../src/ingest/html.js";
import { detectKind, ingest, ingestOne } from "../src/ingest/index.js";
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

  it("does not throw on empty or fragment html (documentElement null)", () => {
    expect(() => htmlToMarkdown("", "https://x.test/empty")).not.toThrow();
    expect(htmlToMarkdown("", "https://x.test/empty").markdown).toContain("<!-- source: https://x.test/empty -->");
    expect(htmlToMarkdown("<p>just a fragment</p>", "https://x.test/frag").markdown).toContain("just a fragment");
    expect(detectInteractive("", 0).reasons).toEqual(["본문 2,000자 미만"]);
  });

  it("fences bare <pre>, keeps language from pre or code class, and grows the fence past inner backticks", () => {
    const html = '<html><head><title>T</title></head><body><main><p>intro</p>'
      + '<pre>curl https://x</pre>'
      + '<pre class="language-sh"><code>echo hi</code></pre>'
      + '<pre><code class="language-md">```js\nx\n```</code></pre>'
      + '</main></body></html>';
    const { markdown } = htmlToMarkdown(html, "https://x.test/pre");
    expect(markdown).toContain("```\ncurl https://x\n```");
    expect(markdown).toContain("```sh\necho hi\n```");
    expect(markdown).toContain("````md\n```js\nx\n```\n````");
  });

  it("collapses whitespace in the title used for the H1", () => {
    const { title, markdown } = htmlToMarkdown("<html><head><title>  Pets\n   API  </title></head><body><p>x</p></body></html>", "https://x.test/t");
    expect(title).toBe("Pets API");
    expect(markdown).toMatch(/^# Pets API$/m);
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

  it("markdown mentioning openapi stays markdown", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "specmock-md-"));
    try {
      const md = path.join(dir, "README.md");
      await writeFile(md, "# Our API\n\nExample spec:\n\n```yaml\nopenapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths: {}\n```\n", "utf8");
      const input = await ingestOne(md);
      expect(input.kind).toBe("markdown");
      expect(input.title).toBe("Our API");
      expect(detectKind("README.md", "```yaml\nopenapi: 3.0.0\n```")).toBe("markdown");
      expect(detectKind("page.html", "openapi: 3.0.0\npaths: {}")).toBe("html");
      // 확장자·content-type이 없으면 여전히 내용으로 OpenAPI를 알아본다
      expect(detectKind("https://x.test/spec", "openapi: 3.0.0\npaths: {}", "text/plain")).toBe("openapi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("firstHeading skips # lines inside fenced code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "specmock-md-"));
    try {
      const md = path.join(dir, "notes.md");
      await writeFile(md, "```sh\n# not a heading\necho hi\n```\n\n# Real title\n", "utf8");
      expect((await ingestOne(md)).title).toBe("Real title");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// "한글" in EUC-KR: C7 D1 B1 DB
const HANGUL_EUC_KR = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
const EUC_KR_PAGE = Buffer.concat([
  Buffer.from("<html><head><title>"), HANGUL_EUC_KR, Buffer.from(" API</title></head><body><main><h1>"), HANGUL_EUC_KR,
  Buffer.from(" API</h1><p>"), Buffer.from("x".repeat(2500)), Buffer.from("</p></main></body></html>"),
]);
// 헤더에 charset이 없고 <meta charset>만 있는 경우
const META_CHARSET_PAGE = Buffer.concat([
  Buffer.from('<html><head><meta charset="euc-kr"><title>'), HANGUL_EUC_KR, Buffer.from(" API</title></head><body><main><h1>"), HANGUL_EUC_KR,
  Buffer.from(" API</h1><p>"), Buffer.from("x".repeat(2500)), Buffer.from("</p></main></body></html>"),
]);

describe("ingest over http", () => {
  let server: Server; let base: string; let hits = 0;
  beforeAll(async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === "/docs") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); return; }
      if (req.url === "/spec") { res.setHeader("content-type", "application/yaml"); res.end("openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths: {}\n"); return; }
      if (req.url === "/plain") { res.removeHeader("content-type"); res.end("GET /pets returns pets.\nNothing else here."); return; }
      if (req.url === "/empty-html") { res.setHeader("content-type", "text/html"); res.end(""); return; }
      if (req.url === "/euckr") { res.setHeader("content-type", "text/html; charset=euc-kr"); res.end(EUC_KR_PAGE); return; }
      if (req.url === "/meta-charset") { res.setHeader("content-type", "text/html"); res.end(META_CHARSET_PAGE); return; }
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

  it("fails clearly on a connection error with the origin and cause code", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(ingest(ws, "x", [`http://127.0.0.1:${port}/`])).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${port}/ 요청 실패: ECONNREFUSED`));
  });

  it("treats a URL with no content-type and a non-html body as text", async () => {
    await ingest(ws, "plain", [`${base}/plain`]);
    const src = await ws.read("plain", "source.json", SourceSchema);
    expect(src.inputs[0].kind).toBe("text");
    expect(src.inputs[0].content).toContain("GET /pets returns pets.");
  });

  it("does not throw on an empty text/html body", async () => {
    await ingest(ws, "empty", [`${base}/empty-html`]);
    const src = await ws.read("empty", "source.json", SourceSchema);
    expect(src.inputs[0].kind).toBe("html");
  });

  it("decodes non-UTF-8 pages using the header charset", async () => {
    await ingest(ws, "euckr", [`${base}/euckr`]);
    const src = await ws.read("euckr", "source.json", SourceSchema);
    expect(src.inputs[0].title).toBe("한글 API");
    expect(src.inputs[0].content).toContain("한글");
  });

  it("decodes non-UTF-8 pages using <meta charset> when the header has none", async () => {
    await ingest(ws, "meta", [`${base}/meta-charset`]);
    const src = await ws.read("meta", "source.json", SourceSchema);
    expect(src.inputs[0].content).toContain("한글");
  });
});
