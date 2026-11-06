import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { watchWorkspace } from "../src/watch.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-watch-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("시스템 파일 변경 → workspace-changed{system,files}, .tmp·.lock은 무시, 디바운스로 한 번", async () => {
  const dir = path.join(root, ".specmock");
  await mkdir(path.join(dir, "pets"), { recursive: true });
  const got: { system: string | null; files: string[] }[] = [];
  const w = watchWorkspace(dir, (e) => got.push(e), { debounceMs: 100 });
  try {
    await writeFile(path.join(dir, "pets", "selection.json.123.tmp"), "x");
    await writeFile(path.join(dir, "pets", ".lock"), "x");
    await writeFile(path.join(dir, "pets", "selection.json"), "{}");
    await writeFile(path.join(dir, "pets", "mockspec.json"), "{}");
    await mkdir(path.join(dir, "pets", "extracted"), { recursive: true });
    await writeFile(path.join(dir, "pets", "extracted", "000.json"), "{}");
    await expect.poll(() => got.length, { timeout: 2000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(1);
    expect(got[0]!.system).toBe("pets");
    expect(got[0]!.files).toEqual(expect.arrayContaining(["extracted/000.json", "mockspec.json", "selection.json"]));
    expect(got[0]!.files.some((f) => /\.tmp$|\.lock$/.test(f))).toBe(false);
  } finally { w.close(); }
});

it("close 뒤에는 이벤트가 오지 않는다", async () => {
  const dir = path.join(root, ".specmock");
  await mkdir(path.join(dir, "pets"), { recursive: true });
  const got: unknown[] = [];
  const w = watchWorkspace(dir, (e) => got.push(e), { debounceMs: 50 });
  await writeFile(path.join(dir, "pets", "a.json"), "{}");
  w.close();
  await new Promise((r) => setTimeout(r, 250));
  expect(got).toEqual([]);
});
