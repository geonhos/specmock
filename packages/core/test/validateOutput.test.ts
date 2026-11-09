// packages/core/test/validateOutput.test.ts
import { describe, expect, it } from "vitest";
import { matchGlob } from "../src/generate/glob.js";
import { validateOutput } from "../src/generate/validateOutput.js";
import { fakeProfile } from "./fakeProfile.js";

describe("matchGlob", () => {
  it.each([
    ["src/**", "src/a/b/C.java", true],
    ["src/**", "srcx/a", false],
    ["pom.xml", "pom.xml", true],
    ["mvnw*", "mvnw.cmd", true],
    [".mvn/**", ".mvn/wrapper/maven-wrapper.properties", true],
    ["fixtures/**", "fixtures", true],
    ["*.mjs", "lib/a.mjs", false],
  ])("%s ~ %s → %s", (pattern, rel, expected) => {
    expect(matchGlob(pattern, rel)).toBe(expected);
  });
});

describe("validateOutput", () => {
  const ok = { files: [{ path: "server.mjs", content: "x" }], notes: [] };
  it("통과하면 정규화된 files·notes를 돌려준다", () => {
    expect(validateOutput(ok, fakeProfile)).toEqual({ ok: true, files: [{ path: "server.mjs", content: "x" }], notes: [] });
  });
  it("스키마 위반", () => {
    const r = validateOutput({ files: "x" }, fakeProfile);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/^응답 형식:/);
  });
  it.each([
    ["../evil.mjs", "경로가 outDir을 벗어납니다: ../evil.mjs"],
    ["/etc/passwd", "절대 경로는 쓸 수 없습니다: /etc/passwd"],
    ["fixtures/getPet/200.json", "보호 경로입니다: fixtures/getPet/200.json"],
    ["notes.txt", "sourceGlobs 밖입니다: notes.txt (허용: server.mjs, lib/**)"],
  ])("경로 %s 거부", (p, msg) => {
    const r = validateOutput({ files: [{ path: p, content: "x" }], notes: [] }, fakeProfile);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toContain(msg);
  });
  it("중복 경로와 maxFiles 초과", () => {
    const dup = validateOutput({ files: [{ path: "server.mjs", content: "a" }, { path: "server.mjs", content: "b" }], notes: [] }, fakeProfile);
    expect(!dup.ok && dup.errors).toContain("같은 경로가 두 번 나옵니다: server.mjs");
    const many = validateOutput({ files: Array.from({ length: 6 }, (_, i) => ({ path: `lib/${i}.mjs`, content: "" })), notes: [] }, fakeProfile);
    expect(!many.ok && many.errors).toContain("파일이 너무 많습니다: 6개 (최대 5)");
  });
  it("content:null은 삭제 표시로 통과한다", () => {
    expect(validateOutput({ files: [{ path: "lib/old.mjs", content: null }], notes: ["x"] }, fakeProfile)).toMatchObject({ ok: true, notes: ["x"] });
  });
});
