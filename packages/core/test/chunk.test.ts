import { describe, expect, it } from "vitest";
import { splitIntoChunks } from "../src/analyze/chunk.js";

const md = (n: number) => `# Title\n\nintro\n\n${Array.from({ length: n }, (_, i) => `## Section ${i}\n\n${"body ".repeat(100)}\n`).join("\n")}`;

const fenceCount = (text: string) => (text.match(/^```/gm) ?? []).length;

describe("splitIntoChunks", () => {
  it("returns one chunk for a short document, with the first heading", () => {
    const chunks = splitIntoChunks("# Pets API\n\nhello\n\n## List\n\nGET /pets\n", { maxChars: 6000, overlap: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("Pets API");
    expect(chunks[0].text).toContain("GET /pets");
  });

  it("splits on headings and never exceeds maxChars", () => {
    const chunks = splitIntoChunks(md(40), { maxChars: 3000, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(3000);
    // 각 청크는 헤딩으로 시작한다(첫 청크는 문서 제목).
    for (const c of chunks.slice(1)) expect(c.text).toMatch(/^## Section \d+/);
  });

  it("carries an overlap tail from the previous chunk when a section itself is too long", () => {
    const long = `## Big\n\n${"word ".repeat(2000)}`; // 10,000자
    const chunks = splitIntoChunks(long, { maxChars: 4000, overlap: 200 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const tail = chunks[0].text.slice(-200);
    expect(chunks[1].text.startsWith(tail.trimStart())).toBe(true);
    for (const c of chunks) expect(c.heading).toBe("Big");
  });

  it("does not crawl one char at a time across a long whitespace run", () => {
    const doc = `## W\n\n${"a".repeat(100)}${"\n".repeat(400)}${"b".repeat(100)}`;
    const chunks = splitIntoChunks(doc, { maxChars: 200, overlap: 20 });
    expect(chunks.length).toBeLessThanOrEqual(3);
    for (const c of chunks) expect(c.text.trim().length).toBeGreaterThan(0);
    expect(chunks.filter((c) => c.text.includes("a".repeat(100)))).toHaveLength(1);
    expect(chunks.at(-1)!.text).toContain("b".repeat(100));
  });

  it("pulls the cut back before a fence opener when the fence would otherwise be split", () => {
    const doc = `## A\n\n${"x ".repeat(600)}\n\n\`\`\`json\n${"{\"k\": 1},\n\n".repeat(300)}\`\`\`\n\nafter\n`;
    const chunks = splitIntoChunks(doc, { maxChars: 3500, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(fenceCount(c.text) % 2).toBe(0);
    expect(chunks[0].text).not.toContain("```json");
    expect(chunks[1].text).toContain("```json");
  });

  it("does not split inside a fenced code block when it can avoid it", () => {
    const doc = `## A\n\n${"x ".repeat(1500)}\n\n\`\`\`json\n${"{\"k\": 1},\n".repeat(200)}\`\`\`\n\n## B\n\nend\n`;
    const chunks = splitIntoChunks(doc, { maxChars: 3500, overlap: 100 });
    for (const c of chunks) {
      expect(fenceCount(c.text) % 2, `chunk has unbalanced fences:\n${c.text.slice(0, 80)}`).toBe(0);
    }
  });

  it("does not start the overlap tail inside a fenced code block", () => {
    // 펜스 블록이 조각 경계 바로 앞에서 끝난다. 겹침 꼬리를 단순히 end-overlap 에서 시작하면 닫는 펜스만 들어간다.
    const doc = `## A\n\n${"x ".repeat(1000)}\n\n\`\`\`\n${"line\n".repeat(100)}\`\`\`\n\n${"y ".repeat(1000)}\n`;
    const chunks = splitIntoChunks(doc, { maxChars: 3500, overlap: 300 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(fenceCount(c.text) % 2, `chunk has unbalanced fences:\n${c.text.slice(0, 80)}`).toBe(0);
    }
    const all = chunks.map((c) => c.text).join("\n");
    expect(all).toContain("```\nline\n");
    expect(chunks.at(-1)!.text).toMatch(/^y y /);
  });

  it("keeps a leading HTML comment and uses the first real heading", () => {
    const doc = "<!-- source: https://docs.example.test/pets -->\n\n# Pets API\n\nintro\n\n## List\n\nGET /pets\n";
    const chunks = splitIntoChunks(doc, { maxChars: 6000, overlap: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("Pets API");
    expect(chunks[0].text.startsWith("<!-- source: https://docs.example.test/pets -->")).toBe(true);
    expect(chunks[0].text).toContain("# Pets API");
  });

  it("gives a heading-less document an empty heading", () => {
    const chunks = splitIntoChunks("just some text\n\nmore text\n", { maxChars: 6000, overlap: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("");
    expect(chunks[0].text).toBe("just some text\n\nmore text");
  });

  it("ignores heading-like lines inside ``` ~~~ and nested fences", () => {
    const doc = [
      "# Doc",
      "",
      "````md",
      "```",
      "# not a heading (inner fence)",
      "```",
      "# still not a heading (outer fence open)",
      "````",
      "",
      "~~~",
      "# not a heading (tilde fence)",
      "~~~",
      "",
      "## Real",
      "",
      "body",
      "",
    ].join("\n");
    const chunks = splitIntoChunks(doc, { maxChars: 60, overlap: 10 });
    const headings = chunks.map((c) => c.heading);
    expect(headings).not.toContain("not a heading (inner fence)");
    expect(headings).not.toContain("still not a heading (outer fence open)");
    expect(headings).not.toContain("not a heading (tilde fence)");
    expect(headings).toContain("Real");
    expect(headings[0]).toBe("Doc");
  });

  it("keeps a trailing # that is part of the heading and allows up to 3 leading spaces", () => {
    const chunks = splitIntoChunks("# C#\n\nbody\n\n   ## Indented ##\n\nmore\n\n    ## code block\n", { maxChars: 40, overlap: 0 });
    expect(chunks.map((c) => c.heading)).toEqual(["C#", "Indented"]);
  });

  it("holds size, non-blank and line-coverage properties across option combinations", () => {
    const docs: Record<string, string> = {
      sections: md(12),
      fence: `## A\n\n${"x ".repeat(600)}\n\n\`\`\`json\n${"{\"k\": 1},\n\n".repeat(300)}\`\`\`\n\nafter\n`,
      pages: Array.from({ length: 10 }, (_, i) => `## [page ${i + 1}]\n\n${`line ${i} of pdf text\n`.repeat(30)}`).join("\n"),
      blankHeavy: `# B\n\n${Array.from({ length: 40 }, (_, i) => `para ${i}${"\n".repeat(50 + (i % 7) * 40)}`).join("")}tail`,
      noNewlines: "a".repeat(7000),
    };
    for (const [name, doc] of Object.entries(docs)) {
      const lines = doc.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      for (const maxChars of [60, 200, 1500, 6000]) {
        for (const overlap of [0, 50, 5000]) {
          const label = `${name} max=${maxChars} ov=${overlap}`;
          const chunks = splitIntoChunks(doc, { maxChars, overlap });
          expect(chunks.length, label).toBeGreaterThan(0);
          for (const c of chunks) {
            expect(c.text.length, label).toBeLessThanOrEqual(maxChars);
            expect(c.text.trim().length, label).toBeGreaterThan(0);
          }
          for (const line of lines) {
            if (line.length >= maxChars / 2) continue;
            expect(chunks.some((c) => c.text.includes(line)), `${label}: line "${line.slice(0, 30)}"`).toBe(true);
          }
        }
      }
    }
  });

  it("returns [] for empty input and normalizes CRLF", () => {
    expect(splitIntoChunks("", { maxChars: 100, overlap: 10 })).toEqual([]);
    expect(splitIntoChunks("\n\n  \n", { maxChars: 100, overlap: 10 })).toEqual([]);
    const chunks = splitIntoChunks("# A\r\n\r\nx\r\n\r\n## B\r\n\r\ny\r\n", { maxChars: 100, overlap: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("# A\n\nx\n\n## B\n\ny");
  });

  it("is deterministic", () => {
    const a = splitIntoChunks(md(12), { maxChars: 2500, overlap: 150 });
    const b = splitIntoChunks(md(12), { maxChars: 2500, overlap: 150 });
    expect(a).toEqual(b);
  });
});
