import { describe, expect, it } from "vitest";
import { normalizeHarvest } from "../src/harvest/normalize.js";

describe("normalizeHarvest", () => {
  const key = "sk_" + "live_" + "Ab1".repeat(8);
  const bearer = "Bearer " + "x9Yz".repeat(10);
  const raw = {
    pages: [{ url: "https://x.test/docs", title: `t ${key}`, html: `<main><p>key ${key}</p></main>` }],
    interactions: [
      { type: "tab" as const, label: `tab ${key}`, html: `<pre>Authorization: ${bearer}</pre>` },
      { type: "tab" as const, label: "dup", html: `<pre>Authorization: ${bearer}</pre>` },
    ],
    notes: [`note ${key}`],
  };
  it("masks secrets everywhere and dedupes after masking", () => {
    const h = normalizeHarvest(raw, "https://x.test/");
    const all = JSON.stringify(h);
    expect(all).not.toContain(key);
    expect(all).not.toContain("x9Yz".repeat(10));
    expect(all).toContain("***");
    expect(h.interactions).toHaveLength(1);
  });
});
