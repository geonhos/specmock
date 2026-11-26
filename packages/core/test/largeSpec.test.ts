import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string;
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** 400개 operation이 큰 공유 스키마 하나를 $ref로 쓴다(공유 $ref가 파일마다 펼쳐지는 경우). */
function bigSpec(n: number) {
  const props = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { type: "string", description: "x".repeat(40) }]));
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) paths[`/r${i}/{id}`] = { get: { operationId: `get${i}`, tags: [`t${i % 20}`], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Big" } } } } } } };
  return { openapi: "3.0.3", info: { title: "big", version: "1" }, paths, components: { schemas: { Big: { type: "object", properties: props } } } };
}

it("select writes only the selected features of a large spec to mockspec.json", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-big-"));
  const spec = path.join(dir, "big.json");
  await writeFile(spec, JSON.stringify(bigSpec(400)));
  const ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "big", [spec]);
  await analyze(ws, "big");
  await select(ws, "big", ["get1", "get2"], { literalIds: true });
  const mock = await ws.read("big", "mockspec.json", MockSpecSchema);
  expect(mock.features.map((f) => f.id).sort()).toEqual(["get1", "get2"]);
  expect(mock.contracts.every((c) => c.featureId === "get1" || c.featureId === "get2")).toBe(true);
  const catalogBytes = (await stat(ws.file("big", "catalog.json"))).size;
  const mockBytes = (await stat(ws.file("big", "mockspec.json"))).size;
  expect(mockBytes * 50).toBeLessThan(catalogBytes);
}, 60_000);
