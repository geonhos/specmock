import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASES, GOLDEN, produce, stable } from "./golden/cases.js";

describe("golden catalogs", () => {
  for (const c of CASES) {
    it(`${c.name} matches expected-catalog.json`, async () => {
      const actual = stable(await produce(c));
      const expected = JSON.parse(await readFile(path.join(GOLDEN, c.name, "expected-catalog.json"), "utf8"));
      expect(actual, `바뀐 것이 의도한 것이면: node --import tsx packages/core/test/golden-update.mjs ${c.name}`).toEqual(expected);
    });
  }
});
