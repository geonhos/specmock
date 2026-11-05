import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { collectInteractives, expandAll, panelHtml, referenceLinks } from "../src/harvest/pageScript.js";

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
});
