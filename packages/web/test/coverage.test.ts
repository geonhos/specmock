// @vitest-environment node
import { renderCoverage } from "@specmock/core";
import { expect, it } from "vitest";
import { parseCoverage } from "../src/coverage";

const MD = [
  "# petstore coverage", "", "선택 기능: 3 / 5", "",
  "## fixture 출처 (기본 응답 기준)", "", "| 출처 | 개수 | 의미 |", "|---|---|---|",
  "| spec-example | 2 | 스펙의 example 그대로. 실제 모양에 가장 가깝다 |",
  "| doc-sample | 0 | 문서에서 추출한 샘플 |",
  "| schema-generated | 1 | 스키마로 생성. 구조는 맞지만 값은 임의 |",
  "| empty | 0 | 스키마 없음. 빈 객체 |", "",
  "## 신뢰도 분포", "", "| 구간 | 개수 |", "|---|---|", "| 1.0 | 2 |", "| 0.8 이상 | 1 |", "| 0.5 이상 | 0 |", "| 0.5 미만 | 0 |", "",
  "## 가정 (assumptions)", "", "- 첫 번째 가정", "- 두 번째 | 가정", "",
  "## contract test", "", "contract: 통과 3 / 실패 0 / 전체 3", "",
  "## 선택되지 않은 기능", "", "- `pets.delete` DELETE /pets/{petId}", "- `pets.patch` PATCH /pets/{petId}", "",
].join("\n");

it("core가 쓰는 coverage.md를 요약 카드용 데이터로 푼다", () => {
  expect(parseCoverage(MD)).toEqual({
    selected: 3, total: 5,
    sources: [
      { name: "spec-example", count: 2, meaning: "스펙의 example 그대로. 실제 모양에 가장 가깝다" },
      { name: "doc-sample", count: 0, meaning: "문서에서 추출한 샘플" },
      { name: "schema-generated", count: 1, meaning: "스키마로 생성. 구조는 맞지만 값은 임의" },
      { name: "empty", count: 0, meaning: "스키마 없음. 빈 객체" },
    ],
    confidence: [{ range: "1.0", count: 2 }, { range: "0.8 이상", count: 1 }, { range: "0.5 이상", count: 0 }, { range: "0.5 미만", count: 0 }],
    assumptions: ["첫 번째 가정", "두 번째 | 가정"],
    notMocked: [{ id: "pets.delete", text: "DELETE /pets/{petId}" }, { id: "pets.patch", text: "PATCH /pets/{petId}" }],
  });
});

it("가정·선택 안 한 기능이 '없음'이면 빈 목록", () => {
  const md = MD.replace("- 첫 번째 가정\n- 두 번째 | 가정", "없음").replace(/- `pets\.delete`.*\n- `pets\.patch`.*\n/, "없음\n");
  expect(parseCoverage(md)).toMatchObject({ assumptions: [], notMocked: [] });
});

it("모르는 형식이면 null(화면은 원문으로 대신 보인다)", () => {
  expect(parseCoverage("# 아무 글\n\n본문")).toBeNull();
  expect(parseCoverage("")).toBeNull();
});

it("core renderCoverage의 실제 출력과 맞는다(출력 형식이 바뀌면 여기서 깨진다)", () => {
  const fx = (source: string, status = 200) => ({ status, source, body: {} });
  const spec = {
    system: "s", assumptions: ["a | b"],
    features: [
      { id: "f1", confidence: 1, fixtures: [fx("spec-example")] },
      { id: "f2", confidence: 0.6, fixtures: [fx("schema-generated"), fx("empty", 404)] },
    ],
    notMocked: [{ id: "n1", method: "GET", path: "/x" }],
  } as never;
  const parsed = parseCoverage(renderCoverage(spec, null));
  expect(parsed).toMatchObject({ selected: 2, total: 3, assumptions: ["a | b"], notMocked: [{ id: "n1", text: "GET /x" }] });
  expect(parsed!.sources.find((s) => s.name === "spec-example")!.count).toBe(1);
  expect(parsed!.sources.find((s) => s.name === "schema-generated")!.count).toBe(1);
  expect(parsed!.confidence.find((c) => c.range === "0.5 이상")!.count).toBe(1);
});

it("recorded 행이 더해진 5행 표도 푼다", () => {
  const md = MD.replace("| spec-example |", "| recorded | 1 | 실제 시스템 응답을 녹화 |\n| spec-example |");
  const parsed = parseCoverage(md)!;
  expect(parsed.sources).toHaveLength(5);
  expect(parsed.sources[0]).toEqual({ name: "recorded", count: 1, meaning: "실제 시스템 응답을 녹화" });
});
