import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { documentText, prepare, pruneExtracted } from "../src/analyze/prepare.js";
import { EXTRACTION_PROMPT, buildChunkPrompt } from "../src/analyze/prompt.js";
import { AnalyzeRequestSchema, SourceSchema, type SourceInput } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PETS_MD = path.join(here, "fixtures", "docs", "pets.md");

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-prepare-"));
  ws = new Workspace(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("prepare", () => {
  it("writes chunks/NNN.md and analyze-request.json for a markdown input", async () => {
    await ingest(ws, "pets", [PETS_MD]);
    const req = await prepare(ws, "pets", { maxChars: 400, overlap: 50 });
    expect(req.chunks.length).toBeGreaterThan(1);
    const files = (await readdir(path.join(dir, "pets", "chunks"))).sort();
    expect(files[0]).toBe("000.md");
    expect(files).toHaveLength(req.chunks.length);
    const saved = await ws.read("pets", "analyze-request.json", AnalyzeRequestSchema);
    expect(saved.prompt).toBe(EXTRACTION_PROMPT);
    expect(saved.schema.required).toEqual(["endpoints"]);
    expect(saved.chunks[0]).toMatchObject({ index: 0, file: "chunks/000.md", inputIndex: 0 });
    const first = await readFile(path.join(dir, "pets", "chunks", "000.md"), "utf8");
    expect(first).toContain("# Pets API");
    expect(await readdir(path.join(dir, "pets", "extracted"))).toEqual([]);
  });

  it("numbers chunks contiguously across inputs and never leaves a heading empty", async () => {
    const plain = path.join(dir, "notes.txt");
    await writeFile(plain, "GET /things returns things.\n\nPOST /things creates one.\n", "utf8");
    await ingest(ws, "two", [PETS_MD, plain]);
    const req = await prepare(ws, "two", { maxChars: 400, overlap: 50 });
    req.chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.file).toBe(`chunks/${String(i).padStart(3, "0")}.md`);
      expect(c.heading).not.toBe("");
    });
    const fromText = req.chunks.filter((c) => c.inputIndex === 1);
    expect(fromText).toHaveLength(1);
    // 헤딩 없는 텍스트 입력은 title이 없으므로 origin으로 대신한다.
    expect(fromText[0].heading).toBe(plain);
    expect(fromText[0].index).toBe(req.chunks.length - 1);
  });

  it("skips openapi inputs and counts them", async () => {
    await ingest(ws, "mixed", [PETSTORE, PETS_MD]);
    const req = await prepare(ws, "mixed");
    expect(req.openapiFeatures).toBe(5);
    for (const c of req.chunks) expect(c.inputIndex).toBe(1);
  });

  it("appends harvested pages and interactions as extra sections", async () => {
    await ingest(ws, "pets", [PETS_MD]);
    // 수확 결과를 흉내 낸다.
    const src = await ws.read("pets", "source.json", SourceSchema);
    src.inputs[0].harvested = {
      pages: [{ url: "https://x.test/more", title: "More", content: "## Update a pet\n\n`PATCH /pets/{petId}`" }],
      interactions: [{ type: "select", label: "Response example = 404", content: '{"code": 404}' }],
      notes: [],
    };
    await ws.write("pets", "source.json", SourceSchema, src);
    const req = await prepare(ws, "pets");
    const all = (await Promise.all(req.chunks.map((c) => readFile(path.join(dir, "pets", c.file), "utf8")))).join("\n");
    expect(all).toContain("## [수확] 페이지: More");
    expect(all).toContain("PATCH /pets/{petId}");
    expect(all).toContain("## [수확] select: Response example = 404");
  });

  it("removes stale chunk files from a previous prepare", async () => {
    await ingest(ws, "pets", [PETS_MD]);
    await prepare(ws, "pets", { maxChars: 300, overlap: 30 });
    const many = (await readdir(path.join(dir, "pets", "chunks"))).length;
    await prepare(ws, "pets");
    const few = (await readdir(path.join(dir, "pets", "chunks"))).length;
    expect(few).toBeLessThan(many);
  });

  it("throws when there is nothing to extract", async () => {
    await ingest(ws, "only", [PETSTORE]);
    await expect(prepare(ws, "only")).rejects.toThrow(/LLM 추출이 필요한 입력이 없습니다/);
  });
});

describe("documentText", () => {
  const base: SourceInput = {
    kind: "markdown", origin: "doc.md", fetchedAt: "2026-01-01T00:00:00.000Z", contentHash: "x", content: "# Doc\n\nbody\n\n",
  };

  it("skips blank harvested content and collapses multi-line titles and labels", () => {
    const text = documentText({
      ...base,
      harvested: {
        pages: [
          { url: "https://x.test/a", title: "  Page\n  A  ", content: "## A\n\ncontent a" },
          { url: "https://x.test/empty", title: "Empty", content: "   \n\n" },
          { url: "https://x.test/untitled", title: "", content: "untitled content" },
        ],
        interactions: [
          { type: "tab", label: "Response\n\texample  = 200", content: '{"ok": true}' },
          { type: "select", label: "Blank", content: "" },
        ],
        notes: [],
      },
    });
    expect(text).toBe(
      "# Doc\n\nbody\n\n" +
        "## [수확] 페이지: Page A\n\n<!-- https://x.test/a -->\n\n## A\n\ncontent a\n\n" +
        "## [수확] 페이지: https://x.test/untitled\n\n<!-- https://x.test/untitled -->\n\nuntitled content\n\n" +
        '## [수확] tab: Response example = 200\n\n{"ok": true}\n',
    );
    expect(text).not.toContain("Empty");
    expect(text).not.toContain("Blank");
  });

  it("returns the content alone when nothing was harvested", () => {
    expect(documentText(base)).toBe("# Doc\n\nbody\n");
  });
});

describe("buildChunkPrompt", () => {
  it("prefixes the extraction prompt and fences the chunk", () => {
    const p = buildChunkPrompt("## List pets\n\n`GET /pets`");
    expect(p.startsWith(EXTRACTION_PROMPT)).toBe(true);
    expect(p).toContain("\n<<<\n## List pets\n\n`GET /pets`\n>>>\n");
  });
});

describe("pruneExtracted", () => {
  it("removes extracted files numbered beyond the current chunk count", async () => {
    const extracted = path.join(dir, "pets", "extracted");
    await mkdir(extracted, { recursive: true });
    for (const n of ["000", "001", "002"]) await writeFile(path.join(extracted, `${n}.json`), "{}", "utf8");
    await writeFile(path.join(extracted, "notes.txt"), "keep", "utf8");
    const removed = await pruneExtracted(ws, "pets", 2);
    expect(removed).toEqual(["002.json"]);
    expect((await readdir(extracted)).sort()).toEqual(["000.json", "001.json", "notes.txt"]);
  });

  it("returns an empty list when the directory does not exist", async () => {
    expect(await pruneExtracted(ws, "nothing", 1)).toEqual([]);
  });
});
