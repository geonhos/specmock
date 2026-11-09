// packages/core/test/target.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyParams, readTarget, substituteEnv, TARGET_EXAMPLE, TARGET_FILE } from "../src/record/target.js";
import { fillPath } from "../src/select/contracts.js";
import type { Contract, Feature } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string;
let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-target-")); ws = new Workspace(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function put(text: string): Promise<void> {
  const file = ws.file("pets", TARGET_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("substituteEnv", () => {
  it("있음·여러 개·한 값에 둘을 치환하고 ${가 없으면 그대로", () => {
    const env = { A: "1", B: "two" };
    expect(substituteEnv("Bearer ${A}", env)).toBe("Bearer 1");
    expect(substituteEnv("${A}:${B}", env)).toBe("1:two");
    expect(substituteEnv("plain", env)).toBe("plain");
  });

  it("없는 변수는 이름만 담아 던진다", () => {
    expect(() => substituteEnv("Bearer ${PETS_TOKEN}", {})).toThrow("환경변수 PETS_TOKEN이 없습니다");
  });

  it("빈 문자열 값도 없는 것과 같이 던진다", () => {
    expect(() => substituteEnv("Bearer ${PETS_TOKEN}", { PETS_TOKEN: "" })).toThrow("환경변수 PETS_TOKEN이 비어 있습니다");
  });
});

describe("readTarget", () => {
  it("baseUrl 끝 /를 지우고 헤더 env를 치환하며 기본 timeout 15000", async () => {
    await put(JSON.stringify({ baseUrl: "https://api.example.com/v2/", headers: { Authorization: "Bearer ${T}" }, params: { petId: "123" } }));
    const t = await readTarget(ws, "pets", { T: "tok" });
    expect(t).toEqual({ file: ws.file("pets", TARGET_FILE), baseUrl: "https://api.example.com/v2", headers: { Authorization: "Bearer tok" }, params: { petId: "123" }, timeoutMs: 15000 });
  });

  it("파일이 없으면 예시 JSON을 담은 오류", async () => {
    await expect(readTarget(ws, "pets", {})).rejects.toThrow(TARGET_EXAMPLE);
  });

  it("JSON 파싱 실패는 원문을 싣지 않는다", async () => {
    await put('{"baseUrl": "https://x", "headers": {"Authorization": "Bearer SECRET_VALUE_123"');
    const err = await readTarget(ws, "pets", {}).catch((e: Error) => e);
    expect((err as Error).message).toContain("JSON 파싱 실패");
    expect((err as Error).message).not.toContain("SECRET_VALUE_123");
  });

  it("모르는 키·잘못된 값은 필드 이름만 출력", async () => {
    await put(JSON.stringify({ baseUrl: "ftp://x", header: { Authorization: "Bearer SECRET_VALUE_123" }, timeoutMs: -1 }));
    const err = (await readTarget(ws, "pets", {}).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("형식 오류");
    expect(err.message).toContain("baseUrl");
    expect(err.message).toContain("header");
    expect(err.message).toContain("timeoutMs");
    expect(err.message).not.toContain("SECRET_VALUE_123");
  });

  it("baseUrl의 query·hash·계정 정보를 거부한다", async () => {
    for (const baseUrl of ["https://x.example/v2?k=1", "https://x.example/#a", "https://u:p@x.example"]) {
      await put(JSON.stringify({ baseUrl }));
      await expect(readTarget(ws, "pets", {})).rejects.toThrow("baseUrl");
    }
  });

  it("환경변수가 없으면 이름만", async () => {
    await put(JSON.stringify({ baseUrl: "https://x.example", headers: { Authorization: "Bearer ${PETS_TOKEN}" } }));
    await expect(readTarget(ws, "pets", {})).rejects.toThrow("환경변수 PETS_TOKEN이 없습니다");
  });
});

const FEATURE: Feature = {
  id: "getPet", group: "pets", title: "", summary: "", method: "GET", path: "/pets/{petId}",
  request: {
    params: { petId: { required: true, schema: { type: "integer" } } },
    query: { status: { required: false, schema: { type: "string" } } },
    headers: {}, body: null,
  },
  responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
} as Feature;
const CONTRACT: Contract = { featureId: "getPet", name: "정상 요청", request: { method: "GET", path: "/pets/1", headers: {}, query: { limit: "1" }, body: null }, expect: { status: 200, schema: null } };

describe("fillPath 덮어쓰기와 applyParams", () => {
  it("fillPath는 덮어쓴 값도 인코딩한다", () => {
    expect(fillPath(FEATURE)).toBe("/pets/1");
    expect(fillPath(FEATURE, { petId: "a b" })).toBe("/pets/a%20b");
  });

  it("경로·쿼리 파라미터를 같은 이름만 덮어쓴다", () => {
    expect(applyParams(FEATURE, CONTRACT, { petId: "123", status: "available", limit: "5", other: "x" }))
      .toEqual({ path: "/pets/123", query: { limit: "5", status: "available" } });
  });

  it("params가 없거나 feature를 못 찾으면 contract 값 그대로", () => {
    expect(applyParams(FEATURE, CONTRACT, {})).toEqual({ path: "/pets/1", query: { limit: "1" } });
    expect(applyParams(undefined, CONTRACT, { petId: "9" })).toEqual({ path: "/pets/1", query: { limit: "1" } });
  });
});
