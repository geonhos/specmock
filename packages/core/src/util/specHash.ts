// packages/core/src/util/specHash.ts
import type { MockSpec } from "../types.js";
import { hashJson } from "./hash.js";

/**
 * 생성기 입력으로서의 mockspec 해시. fixture는 status 목록만 남기고(본문·출처 제외) assumptions는 뺀다.
 * LLM 지시서는 fixture 본문을 싣지 않으므로(generate/request.ts) 이 값이 같으면 생성 소스도 같다.
 */
export function specInputHash(spec: MockSpec): string {
  return hashJson({
    system: spec.system,
    baseUrl: spec.baseUrl,
    features: spec.features.map(({ fixtures, ...f }) => ({ ...f, fixtures: fixtures.map((x) => x.status) })),
    notMocked: spec.notMocked,
    contracts: spec.contracts,
  });
}

/** 녹화 파일의 mockspecHash. 한 기능(fixture는 status만)과 그 기능의 contract만 본다. 다른 기능 선택이 바뀌어도 그대로다. */
export function featureInputHash(spec: MockSpec, featureId: string): string {
  const f = spec.features.find((x) => x.id === featureId);
  return hashJson({
    system: spec.system,
    feature: f ? { ...f, fixtures: f.fixtures.map((x) => x.status) } : null,
    contracts: spec.contracts.filter((c) => c.featureId === featureId),
  });
}
