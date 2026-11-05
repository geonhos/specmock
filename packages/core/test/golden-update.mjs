#!/usr/bin/env node
// 사용: pnpm build:core && node --import tsx packages/core/test/golden-update.mjs [case...]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const { CASES, produce, stable } = await import("./golden/cases.ts");
const only = new Set(process.argv.slice(2));
for (const c of CASES) {
  if (only.size && !only.has(c.name)) continue;
  const dir = path.join(here, "golden", c.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "expected-catalog.json"), JSON.stringify(stable(await produce(c)), null, 2) + "\n");
  console.log(`updated ${c.name}`);
}
