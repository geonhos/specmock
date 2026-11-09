// packages/core/test/drift.test.ts
import { describe, expect, it } from "vitest";
import { renderDrift, statusHint, type DriftEntry } from "../src/record/drift.js";
import { isSafeFeatureId, recordedName } from "../src/record/recorded.js";
import type { MockSpec } from "../src/types.js";
import { featureInputHash, specInputHash } from "../src/util/specHash.js";

const AT = new Date(2026, 10, 9, 10, 0); // 로컬 2026-11-09 10:00

describe("renderDrift", () => {
  it("집계 줄과 절 구조", () => {
    const entries: DriftEntry[] = [
      { kind: "matched", featureId: "listPets", method: "GET", path: "/pets" },
      { kind: "matched", featureId: "inventory.list", method: "GET", path: "/store/inventory" },
      { kind: "drifted", featureId: "getPet", method: "GET", path: "/pets/123", status: 200, errors: ["/id must be integer"] },
      { kind: "statusMismatch", featureId: "getOrder", method: "GET", path: "/orders/1", expected: 200, actual: 401, hint: "인증 헤더를 확인하세요" },
      { kind: "skipped", featureId: "createPet", method: "POST", path: "/pets" },
    ];
    expect(renderDrift("pets", "https://api.example.com/v2", AT, entries)).toBe([
      "# pets 실제 시스템 대조 (2026-11-09 10:00, https://api.example.com/v2)",
      "요청 5 · 일치 2 · 스펙과 다름 1 · 상태 불일치 1 · 건너뜀(변경 요청) 1 · 실패 0",
      "",
      "## 스펙과 다름",
      "- getPet GET /pets/123 → 200. /id must be integer",
      "",
      "## 상태 불일치",
      "- getOrder GET /orders/1 → 기대 200, 실제 401. 인증 헤더를 확인하세요",
      "",
      "## 건너뜀",
      "- createPet POST /pets — 변경 요청. `--allow-mutating`으로 포함",
      "",
      "## 실패",
      "(없음)",
      "",
    ].join("\n"));
  });

  it("오류 문구와 경로의 비밀을 가린다", () => {
    const md = renderDrift("pets", "https://x.example", AT, [
      { kind: "failed", featureId: "a", method: "GET", path: "/a?api_key=abcdefgh123&x=1", reason: "연결 실패: Bearer abcdefghijklmnopqrstuvwxyz" },
    ]);
    expect(md).toContain("- a GET /a?api_key=***&x=1 — 연결 실패: Bearer ***");
    expect(md).not.toContain("abcdefgh123");
    expect(md).toContain("## 스펙과 다름\n(없음)");
  });

  it("statusHint", () => {
    expect(statusHint(401)).toBe("인증 헤더를 확인하세요");
    expect(statusHint(403)).toBe("인증 헤더를 확인하세요");
    expect(statusHint(404)).toBe("`target.json`의 `params`로 실제 값을 지정하세요");
    expect(statusHint(500)).toBeUndefined();
  });
});

describe("recordedName", () => {
  it("안전한 id만 파일 이름이 된다", () => {
    expect(recordedName("inventory.list")).toBe("recorded/inventory.list.json");
    expect(recordedName("주문_조회-2")).toBe("recorded/주문_조회-2.json");
    for (const bad of ["..", ".", "a/b", "a\\b", "", "a b"]) expect(isSafeFeatureId(bad)).toBe(false);
    expect(() => recordedName("../x")).toThrow("녹화 파일 이름으로 쓸 수 없는 기능 id");
  });
});

describe("specInputHash", () => {
  const base: MockSpec = {
    system: "pets", baseUrl: "/", notMocked: [], contracts: [], assumptions: ["a"],
    features: [{
      id: "getPet", group: "pets", title: "", summary: "", method: "GET", path: "/pets/{petId}",
      request: { params: {}, query: {}, headers: {}, body: null }, responses: {}, auth: "none", provenance: "openapi",
      confidence: 1, hasExample: false, evidence: [], notes: [],
      fixtures: [{ status: 200, body: { id: 1 }, source: "schema-generated" }],
    }],
  };

  it("fixture 본문·출처·assumptions가 바뀌어도 같고, status나 기능이 바뀌면 다르다", () => {
    const h = specInputHash(base);
    const recorded = { ...base, assumptions: [], features: [{ ...base.features[0], fixtures: [{ status: 200, body: { id: "p-1" }, source: "spec-example" as const }] }] };
    expect(specInputHash(recorded)).toBe(h);
    const otherStatus = { ...base, features: [{ ...base.features[0], fixtures: [{ status: 201, body: {}, source: "empty" as const }] }] };
    expect(specInputHash(otherStatus)).not.toBe(h);
    expect(specInputHash({ ...base, features: [{ ...base.features[0], path: "/pets/{id}" }] })).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("featureInputHash는 그 기능만 본다", () => {
    const h = featureInputHash(base, "getPet");
    expect(featureInputHash({ ...base, notMocked: [{ id: "x", method: "GET", path: "/x" }] }, "getPet")).toBe(h);
    expect(featureInputHash({ ...base, features: [{ ...base.features[0], fixtures: [{ status: 200, body: "other", source: "empty" as const }] }] }, "getPet")).toBe(h);
    expect(featureInputHash({ ...base, features: [{ ...base.features[0], method: "HEAD" }] }, "getPet")).not.toBe(h);
  });
});
