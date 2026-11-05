import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/analyze/index.js";
import { merge } from "../../src/analyze/merge.js";
import { prepare } from "../../src/analyze/prepare.js";
import { ingest } from "../../src/ingest/index.js";
import { CatalogSchema, type Catalog } from "../../src/types.js";
import { Workspace } from "../../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIX = path.join(here, "..", "fixtures");
export const GOLDEN = here;

export interface GoldenCase { name: string; inputs: string[]; extracted?: string }
export const CASES: GoldenCase[] = [
  { name: "petstore", inputs: [path.join(FIX, "petstore.yaml")] },
  { name: "with-auth", inputs: [path.join(FIX, "openapi", "with-auth.yaml")] },
  { name: "circular", inputs: [path.join(FIX, "circular.yaml")] },
  { name: "pets-md", inputs: [path.join(FIX, "docs", "pets.md")], extracted: path.join(FIX, "docs", "extracted") },
  { name: "pets-html", inputs: [path.join(FIX, "docs", "pets.html")], extracted: path.join(FIX, "docs", "extracted-html") },
];

/** generatedAt처럼 실행마다 달라지는 값을 뺀다. */
export function stable(catalog: Catalog): Omit<Catalog, "generatedAt"> {
  const { generatedAt: _g, ...rest } = catalog;
  return rest;
}

export async function produce(c: GoldenCase): Promise<Catalog> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `specmock-golden-${c.name}-`));
  try {
    const ws = new Workspace(dir);
    await ingest(ws, c.name, c.inputs);
    const outcome = await analyze(ws, c.name);
    if (outcome.mode === "needs-llm") {
      await prepare(ws, c.name);
      if (c.extracted) await cp(c.extracted, path.join(dir, c.name, "extracted"), { recursive: true });
      await merge(ws, c.name);
    }
    return await ws.read(c.name, "catalog.json", CatalogSchema);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
