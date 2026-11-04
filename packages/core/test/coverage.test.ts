import { describe, expect, it } from "vitest";
import type { MockSpec } from "../src/types.js";
import { renderCoverage } from "../src/verify/coverage.js";
import type { VerifyResult } from "../src/verify/index.js";

const spec: MockSpec = {
  system: "demo",
  baseUrl: "/",
  language: "ts",
  features: [
    {
      id: "getThing",
      group: "things",
      title: "getThing",
      summary: "",
      method: "GET",
      path: "/things/{id}",
      request: { params: {}, query: {}, headers: {}, body: null },
      responses: { "200": { schema: null, examples: [] } },
      auth: "none",
      provenance: "openapi",
      confidence: 1,
      hasExample: false,
      evidence: [],
      notes: [],
      fixtures: [{ status: 200, body: {}, source: "spec-example" }],
    },
  ],
  notMocked: [],
  contracts: [],
  assumptions: [],
};

describe("renderCoverage", () => {
  it("prints '실행하지 않음' when verify was not run", () => {
    const md = renderCoverage(spec, null);
    expect(md).toContain("# demo coverage");
    expect(md).toContain("실행하지 않음");
  });

  it("escapes pipes and newlines inside failed-contract table cells", () => {
    const result: VerifyResult = {
      mockDir: "/tmp/demo",
      total: 1,
      passed: 0,
      failed: 1,
      results: [
        {
          featureId: "getThing",
          name: "정상 | 케이스",
          passed: false,
          expectedStatus: 200,
          actualStatus: 500,
          errors: ["/id must be integer | got string", "line one\nline two"],
        },
      ],
    };
    const md = renderCoverage(spec, result);
    const row = md.split("\n").find((l) => l.startsWith("| getThing |"));
    expect(row).toBeDefined();
    expect(row).toContain("정상 \\| 케이스");
    expect(row).toContain("must be integer \\| got string");
    expect(row).toContain("line one line two");
    expect(row).not.toMatch(/\n/);
    // 셀 구분자는 헤더와 같은 5열이어야 한다.
    expect(row!.split(/(?<!\\)\|/).length).toBe(7);
  });
});
