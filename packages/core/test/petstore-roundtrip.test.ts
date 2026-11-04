import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { buildContracts } from "../src/select/contracts.js";
import { buildFixtures } from "../src/select/fixtures.js";
import { CatalogSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-roundtrip-"));
  ws = new Workspace(dir);
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) ajv.addFormat(f, true);
  return ajv;
}

describe("petstore fixtures and contracts round trip", () => {
  it("generated fixtures validate against their response schemas", async () => {
    const catalog = await ws.read("petstore", "catalog.json", CatalogSchema);
    const ajv = makeAjv();
    let checked = 0;
    for (const feature of catalog.features) {
      const { fixtures } = buildFixtures(feature);
      for (const fx of fixtures) {
        const schema = feature.responses[String(fx.status)]?.schema;
        if (fx.body === null || !schema) continue;
        const ok = ajv.validate(schema, fx.body);
        expect(ok, `${feature.id} ${fx.status}: ${ajv.errorsText()}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("happy-path contract bodies validate against the request body schema", async () => {
    const catalog = await ws.read("petstore", "catalog.json", CatalogSchema);
    const ajv = makeAjv();
    let checked = 0;
    for (const feature of catalog.features) {
      const { fixtures } = buildFixtures(feature);
      const [happy] = buildContracts(feature, fixtures);
      if (!happy || happy.request.body === null || !feature.request.body) continue;
      const ok = ajv.validate(feature.request.body, happy.request.body);
      expect(ok, `${feature.id}: ${ajv.errorsText()}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
