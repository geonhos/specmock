// packages/core/test/request.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { buildGenerateRequest, retrySection } from "../src/generate/request.js";
import { javaProfile } from "../src/generate/profiles/java.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let spec: MockSpec;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-req-"));
  const ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
  spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("buildGenerateRequest", () => {
  it("프롬프트 8항목을 순서대로 담고 fixture 바디는 넣지 않는다", async () => {
    const req = await buildGenerateRequest({ spec, profile: fakeProfile, outDir: "/abs/mock/petstore", existing: null });
    const heads = [...req.prompt.matchAll(/^## (\d)\. /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual([1, 2, 3, 4, 5, 6, 8]);   // 7(증분)은 existing이 있을 때만
    expect(req.prompt).toContain("GET /pets/{petId}");
    expect(req.prompt).toContain("listPets");                 // notMocked
    expect(req.prompt).toContain("### src/server.ts");        // TS 참조
    expect(req.prompt).not.toContain('"source": "spec-example"');
    expect(req.reference.files.map((f) => f.path)).toContain("src/routes/pets.ts");
    expect(req.runtimeContract).toHaveLength(9);
    expect(req.outputSchema).toMatchObject({ type: "object", required: ["files"] });
    expect(req).toMatchObject({ system: "petstore", language: "fake", outDir: "/abs/mock/petstore", sourceGlobs: ["server.mjs", "lib/**"] });
  });

  it("form-encoded 규칙을 런타임 계약과 java 프로필 규칙에 담는다", async () => {
    const req = await buildGenerateRequest({ spec, profile: fakeProfile, outDir: "/abs/mock/petstore", existing: null });
    expect(req.runtimeContract[5]).toContain("application/x-www-form-urlencoded");
    const java = await buildGenerateRequest({ spec, profile: javaProfile, outDir: "/abs/mock/petstore", existing: null });
    expect(java.prompt).toContain("application/x-www-form-urlencoded");
    expect(java.prompt).toContain("specmock.runtime.FormBody");
  });

  it("증분이면 7항목과 existingSources·userModified를 넣는다", async () => {
    const req = await buildGenerateRequest({
      spec, profile: fakeProfile, outDir: "/o",
      existing: { files: [{ path: "server.mjs", content: "// old", userModified: true }] },
    });
    expect(req.prompt).toMatch(/^## 7\. 증분 생성/m);
    expect(req.prompt).toContain("### server.mjs (사용자 수정)");
    expect(req.existingSources).toEqual([{ path: "server.mjs", content: "// old", userModified: true }]);
  });
});

describe("retrySection", () => {
  it("실패 단계·오류 최대 50줄·실패 contract를 적는다", () => {
    const log = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const s = retrySection({ attempt: 1, stage: "build", errors: [log], contracts: [{ featureId: "getPet", name: "200", expectedStatus: 200, actualStatus: 500, passed: false, errors: ["status: expected 200, got 500"] }], runtime: [] });
    expect(s).toMatch(/^## 이전 시도 결과 \(1번째\)/);
    expect(s).toContain("실패 단계: 빌드");
    expect(s).toContain("line 79");
    expect(s).not.toContain("line 29\n");
    expect(s).toContain("- getPet [200] 기대 200, 실제 500: status: expected 200, got 500");
  });
  it("spec이 있으면 실패 contract의 요청(method·path·query·body)을 적는다", () => {
    const c = spec.contracts[0]!;
    const s = retrySection({ attempt: 2, stage: "contract", errors: [], contracts: [{ featureId: c.featureId, name: c.name, expectedStatus: c.expect.status, actualStatus: 500, passed: false, errors: ["x"] }], runtime: [] }, spec);
    expect(s).toContain(`요청 ${JSON.stringify({ method: c.request.method, path: c.request.path, query: c.request.query, body: c.request.body })}`);
  });
});
