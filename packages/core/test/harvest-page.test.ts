import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { collectInteractives, expandAll, panelHtml, panelVisible, referenceLinks, visibleBlocks } from "../src/harvest/pageScript.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async () => parseHTML(await readFile(path.join(here, "fixtures", "docs", "pets.html"), "utf8"));

describe("harvest pageScript", () => {
  it("expandAll opens details and aria-expanded=false", async () => {
    const { document } = await load();
    const n = expandAll(document as unknown as Document);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("collectInteractives lists tabs with their panel ids and selects with options", async () => {
    const { document } = await load();
    const r = collectInteractives(document as unknown as Document);
    expect(r.tabs).toEqual([
      { selector: "[role='tab'][aria-controls='tab-curl']", label: "curl", panel: "tab-curl" },
      { selector: "[role='tab'][aria-controls='tab-node']", label: "Node", panel: "tab-node" },
    ]);
    expect(r.selects).toEqual([{ selector: "#resp", label: "Response example", options: [{ value: "200", label: "200" }, { value: "404", label: "404" }] }]);
    expect(r.listboxes).toEqual([]);
  });

  it("panelHtml returns the panel markup", async () => {
    const { document } = await load();
    expect(panelHtml(document as unknown as Document, "tab-node")).toContain('await fetch("https://api.example.com/v1/pets")');
  });

  it("referenceLinks keeps same-origin api/docs/reference links only", async () => {
    const { document } = await load();
    const links = referenceLinks(document as unknown as Document, "https://x.test/docs/pets");
    expect(links).toEqual(["https://x.test/docs"]);
  });

  it("referenceLinks excludes bare /api/ but keeps /api-reference/", () => {
    const { document } = parseHTML("<a href='/api/logout'>x</a><a href='/api-reference/x'>y</a>");
    expect(referenceLinks(document as unknown as Document, "https://x.test/")).toEqual(["https://x.test/api-reference/x"]);
  });

  it("visibleBlocks fallback skips hidden and display:none blocks", () => {
    const { document } = parseHTML("<main><p>shown</p><p hidden>h1</p><div hidden><p>h2</p></div><div style='display: none'><p>h3</p></div><p style='display:none'>h4</p></main>");
    const out = visibleBlocks(document as unknown as Document);
    expect(out).toEqual(["<p>shown</p>"]);
  });

  it("panelVisible fallback reflects hidden and inline display:none", () => {
    const { document } = parseHTML("<div id='a'>a</div><div id='b' hidden>b</div><div id='c' style='display:none'>c</div>");
    const d = document as unknown as Document;
    expect([panelVisible(d, "a"), panelVisible(d, "b"), panelVisible(d, "c"), panelVisible(d, "zz")]).toEqual([true, false, false, false]);
  });
});
