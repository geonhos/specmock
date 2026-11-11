import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

/** dir 아래 모든 파일의 상대 경로 → sha256. lock은 generatedAt 때문에 뺀다. */
async function treeHashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(rel: string): Promise<void> {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (r !== "specmock.lock.json") out[r] = createHash("sha256").update(await readFile(path.join(dir, r))).digest("hex");
    }
  }
  await walk("");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-snap-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("TS 생성 결과 바이트 불변", () => {
  it("일부 선택(getPet, createPet, deletePet)", async () => {
    await select(ws, "petstore", ["getPet", "createPet", "deletePet"]);
    const out = path.join(dir, "mock", "petstore");
    await generate(ws, "petstore", { outDir: out });
    expect(await treeHashes(out)).toMatchSnapshot();
  });

  it("전체 선택", async () => {
    await select(ws, "petstore", ["all"]);
    const out = path.join(dir, "mock", "petstore");
    await generate(ws, "petstore", { outDir: out });
    expect(await treeHashes(out)).toMatchSnapshot();
  });
});
