import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
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

it("연속 쓰기 중에도 maxWaitMs마다 알린다", async () => {
  const dir = path.join(root, ".specmock");
  await mkdir(path.join(dir, "pets"), { recursive: true });
  const got: unknown[] = [];
  const w = watchWorkspace(dir, (e) => got.push(e), { debounceMs: 200, maxWaitMs: 300 });
  try {
    const end = Date.now() + 900;
    let i = 0;
    while (Date.now() < end) { await writeFile(path.join(dir, "pets", "a.json"), String(i++)); await new Promise((r) => setTimeout(r, 50)); }
    expect(got.length).toBeGreaterThanOrEqual(2);
  } finally { w.close(); }
});

it("감시자 오류 → 백오프로 재감시, 재감시도 계속 실패하면 onError", async () => {
  const dir = path.join(root, ".specmock");
  await mkdir(dir, { recursive: true });
  const calls: FSWatcher[] = [];
  let attempts = 0;
  const watchFn = (() => {
    if (++attempts > 1) throw new Error(`watch 실패 ${attempts}`); // 처음만 성공, 재감시는 계속 실패
    const w = new EventEmitter() as FSWatcher; (w as any).close = () => {}; (w as any).unref = () => w; calls.push(w); return w;
  }) as unknown as typeof watch;
  const errors: Error[] = [];
  const w = watchWorkspace(dir, () => {}, { watchFn, retry: { attempts: 2, baseMs: 10 }, onError: (e) => errors.push(e) });
  expect(attempts).toBe(1);
  calls[0]!.emit("error", new Error("boom"));
  await expect.poll(() => errors.length, { timeout: 1000 }).toBe(1);
  expect(attempts).toBe(3); // 처음 1 + 재시도 2
  expect(errors[0]!.message).toBe("watch 실패 3");
  await new Promise((r) => setTimeout(r, 100));
  expect(attempts).toBe(3);
  w.close();
});

it("재감시에 성공하면 {system:null, files:[]}를 한 번 알리고, 실패 횟수도 0으로 되돌린다", async () => {
  const dir = path.join(root, ".specmock");
  await mkdir(dir, { recursive: true });
  const calls: FSWatcher[] = [];
  const watchFn = (() => { const w = new EventEmitter() as FSWatcher; (w as any).close = () => {}; (w as any).unref = () => w; calls.push(w); return w; }) as unknown as typeof watch;
  const got: { system: string | null; files: string[] }[] = [];
  const errors: Error[] = [];
  const w = watchWorkspace(dir, (e) => got.push(e), { watchFn, retry: { attempts: 1, baseMs: 10 }, onError: (e) => errors.push(e) });
  expect(got).toEqual([]); // 처음 감시 시작은 알리지 않는다
  calls[0]!.emit("error", new Error("boom"));
  await expect.poll(() => calls.length, { timeout: 1000 }).toBe(2);
  expect(got).toEqual([{ system: null, files: [] }]);
  calls[1]!.emit("error", new Error("boom2")); // 재감시가 성공했으니 다시 재시도 기회가 있다
  await expect.poll(() => calls.length, { timeout: 1000 }).toBe(3);
  expect(errors).toEqual([]);
  expect(got).toHaveLength(2);
  w.close();
});
