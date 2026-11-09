// packages/core/test/install.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockSchema, resolveInstallCheck, type Lock } from "../src/generate/lock.js";
import { ensureInstalled, installKey, markInstalled } from "../src/verify/server.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-inst-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** 호출될 때마다 log에 한 줄 쓰는 설치 스크립트. FAIL_OUT이 있으면 stdout에 쓰고 exit 3. */
async function fakeInstaller(): Promise<{ command: string; args: string[]; log: string }> {
  const log = path.join(dir, "install.log");
  const script = path.join(dir, "inst.mjs");
  await writeFile(script, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "run\\n");
if (process.env.FAIL_OUT) { process.stdout.write("[ERROR] COMPILATION ERROR : Main.java:[3,1] ';' expected\\n"); process.exit(3); }
`);
  return { command: process.execPath, args: [script], log };
}

function lockWith(install: Lock["install"], sourceFiles: Record<string, string> = {}, installCheck: string | null = null): Lock {
  return LockSchema.parse({
    system: "s", language: "fake", mockspecHash: "h", generatedAt: "t", install, installCheck,
    start: { command: "true", args: [] }, healthPath: "/h", fixtureHashes: {}, sourceFiles,
  });
}

describe("ensureInstalled(lock)", () => {
  it("lock의 install을 실행하고, 같은 설치 키면 다시 실행하지 않는다", async () => {
    const inst = await fakeInstaller();
    const lock = lockWith({ command: inst.command, args: inst.args });
    await ensureInstalled(dir, { lock });
    await ensureInstalled(dir, { lock });
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await readFile(path.join(dir, ".specmock-installed"), "utf8")).toBe(await installKey(dir, lock));
  });

  it("sourceFiles에 있는 파일이 바뀌면 다시 설치한다", async () => {
    const inst = await fakeInstaller();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "Main.java"), "a");
    const lock = lockWith({ command: inst.command, args: inst.args }, { "src/Main.java": "whatever" });
    await ensureInstalled(dir, { lock });
    await writeFile(path.join(dir, "src", "Main.java"), "b");
    await ensureInstalled(dir, { lock });
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("install이 null이면 아무것도 실행하지 않는다", async () => {
    await ensureInstalled(dir, { lock: lockWith(null) });
    await expect(readFile(path.join(dir, ".specmock-installed"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("실패하면 stdout까지 오류에 담는다(Maven은 컴파일 오류를 stdout에 쓴다)", async () => {
    const inst = await fakeInstaller();
    process.env.FAIL_OUT = "1";
    try {
      await expect(ensureInstalled(dir, { lock: lockWith({ command: inst.command, args: inst.args }) })).rejects.toThrow(/설치 실패 \(exit 3\)[\s\S]*COMPILATION ERROR/);
    } finally { delete process.env.FAIL_OUT; }
  });

  it("installTimeoutMs를 넘기면 프로세스 그룹을 죽이고 시간 초과로 거부한다", async () => {
    const script = path.join(dir, "slow.mjs");
    await writeFile(script, "setTimeout(() => {}, 60_000);\n");
    const lock = lockWith({ command: process.execPath, args: [script] });
    await expect(ensureInstalled(dir, { lock, timeoutMs: 300 })).rejects.toThrow("설치가 300ms 안에 끝나지 않았습니다");
  });

  it("markInstalled는 같은 키를 써서 설치를 건너뛰게 한다", async () => {
    const inst = await fakeInstaller();
    const lock = lockWith({ command: inst.command, args: inst.args });
    await markInstalled(dir, lock);
    await ensureInstalled(dir, { lock });
    await expect(readFile(inst.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("마커가 맞아도 installCheck 경로가 없으면 다시 설치한다", async () => {
    const inst = await fakeInstaller();
    const lock = lockWith({ command: inst.command, args: inst.args }, {}, "node_modules");
    await markInstalled(dir, lock);
    await ensureInstalled(dir, { lock });   // node_modules 없음 → 설치
    await mkdir(path.join(dir, "node_modules"));
    await ensureInstalled(dir, { lock });   // 있음 → 건너뜀
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(1);
    await rm(path.join(dir, "node_modules"), { recursive: true });
    await ensureInstalled(dir, { lock });   // 지우면 다시
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("installCheck가 null이면 존재 검사 없이 키만 본다", async () => {
    const inst = await fakeInstaller();
    const lock = lockWith({ command: inst.command, args: inst.args }, {}, null);
    await markInstalled(dir, lock);
    await ensureInstalled(dir, { lock });
    await expect(readFile(inst.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("옛 lock(installCheck 필드 없음)은 node_modules를 본다", async () => {
    const inst = await fakeInstaller();
    const lock = LockSchema.parse({
      system: "s", language: "ts", mockspecHash: "h", generatedAt: "t", install: { command: inst.command, args: inst.args },
      start: { command: "true", args: [] }, healthPath: "/h", fixtureHashes: {},
    });
    expect(resolveInstallCheck(lock)).toBe("node_modules");
    await markInstalled(dir, lock);
    await ensureInstalled(dir, { lock });
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});
