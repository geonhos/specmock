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
    ["**/x", "x", true],
    ["**/x", "a/b/x", true],
    ["**/x", "ax", false],
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
  it.each([
    ["lib/", "디렉터리 경로는 쓸 수 없습니다: lib/"],
    ["lib", "디렉터리 경로는 쓸 수 없습니다: lib"],
    ["lib/a\u0000.mjs", /제어 문자/],
    ["lib/a\n.mjs", /제어 문자/],
    ["src\\..\\..\\x", "경로가 outDir을 벗어납니다: src\\..\\..\\x"],
    ["lib/a/../../../x", "경로가 outDir을 벗어납니다: lib/a/../../../x"],
    ["C:\\x", "절대 경로는 쓸 수 없습니다: C:\\x"],
    ["c:x", "절대 경로는 쓸 수 없습니다: c:x"],
    ["//srv/x", "절대 경로는 쓸 수 없습니다: //srv/x"],
  ])("경로 %s 거부(회귀)", (p, msg) => {
    const r = validateOutput({ files: [{ path: p, content: "x" }], notes: [] }, fakeProfile);
    expect(r.ok).toBe(false);
    if (typeof msg === "string") expect(!r.ok && r.errors).toContain(msg);
    else expect(!r.ok && r.errors.join("\n")).toMatch(msg);
  });
  it("중간 ..로 보호 경로로 돌아가도 거부", () => {
    const r = validateOutput({ files: [{ path: "lib/../fixtures/a.json", content: "x" }], notes: [] }, fakeProfile);
    expect(!r.ok && r.errors).toContain("보호 경로입니다: fixtures/a.json");
  });
  it("대소문자·유니코드 정규화만 다른 경로는 중복", () => {
    const r = validateOutput({ files: [{ path: "lib/A.mjs", content: "a" }, { path: "lib/a.mjs", content: "b" }], notes: [] }, fakeProfile);
    expect(!r.ok && r.errors).toContain("같은 경로가 두 번 나옵니다: lib/a.mjs");
    const n = validateOutput({ files: [{ path: "lib/\u00e9.mjs", content: "a" }, { path: "lib/e\u0301.mjs", content: "b" }], notes: [] }, fakeProfile);
    expect(n.ok).toBe(false);
  });
  it("sourceGlobs 안에 있는 보호 경로는 보호가 이긴다", () => {
    const profile = { ...fakeProfile, sourceGlobs: ["server.mjs", "lib/**", "mvnw*"], protectedPaths: [...fakeProfile.protectedPaths, "lib/locked.mjs"] };
    const r = validateOutput({ files: [{ path: "lib/locked.mjs", content: "x" }], notes: [] }, profile);
    expect(!r.ok && r.errors).toEqual(["보호 경로입니다: lib/locked.mjs"]);
  });
  it("content:null은 삭제 표시로 통과한다", () => {
    expect(validateOutput({ files: [{ path: "lib/old.mjs", content: null }], notes: ["x"] }, fakeProfile)).toMatchObject({ ok: true, notes: ["x"] });
  });
});
