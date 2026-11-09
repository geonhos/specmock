import { generateSync } from "json-schema-faker";
import type { Feature, Fixture, JsonSchema, Recorded } from "../types.js";

export const FIXTURE_SEED = 42;

/** 순환 참조 표식({ "x-specmock-circular": true })을 null 타입으로 바꾼 사본을 만든다. */
function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "x-specmock-circular" && obj["x-specmock-circular"] === true) return { type: "null" };
    return Object.fromEntries(keys.map((k) => [k, normalizeSchema(obj[k])]));
  }
  return value;
}

export function generateFromSchema(schema: JsonSchema, seed = FIXTURE_SEED): unknown {
  return generateSync(normalizeSchema(schema) as Parameters<typeof generateSync>[0], {
    seed,
    alwaysFakeOptionals: true,
    useExamplesValue: true,
    useDefaultValue: true,
    failOnInvalidTypes: false,
  });
}

function wanted(status: number): boolean {
  return (status >= 200 && status < 300) || (status >= 400 && status < 500);
}

export function buildFixtures(feature: Feature, recorded: Recorded | null = null): { fixtures: Fixture[]; assumptions: string[] } {
  const fixtures: Fixture[] = [];
  const assumptions: string[] = [];
  const statuses = Object.keys(feature.responses).map(Number).filter(wanted).sort((a, b) => a - b);

  for (const status of statuses) {
    const res = feature.responses[String(status)];
    if (status === 204) {
      fixtures.push({ status, body: null, source: "empty" });
      continue;
    }
    if (res.examples.length > 0) {
      fixtures.push({ status, body: res.examples[0].body, source: res.examples[0].source });
      continue;
    }
    if (res.schema) {
      fixtures.push({ status, body: generateFromSchema(res.schema), source: "schema-generated" });
      continue;
    }
    fixtures.push({ status, body: {}, source: "empty" });
    assumptions.push(`${feature.id}: ${status} 응답 스키마 없음. 빈 객체를 반환한다.`);
  }

  // 2xx fixture가 하나도 없으면(응답 정의가 없거나 4xx만 있는 경우) 라우트가 읽을 성공 응답이 없으므로 200 빈 객체를 보장한다.
  if (!fixtures.some((x) => x.status >= 200 && x.status < 300)) {
    fixtures.push({ status: 200, body: {}, source: "empty" });
    fixtures.sort((a, b) => a.status - b.status);
    assumptions.push(`${feature.id}: 2xx 응답 정의 없음. 200 빈 객체를 반환한다.`);
  }
  if (recorded) {
    const served = fixtures.filter((x) => x.status >= 200 && x.status < 300).sort((a, b) => a.status - b.status)[0];
    const r = recorded.response;
    const skip = (why: string) => assumptions.push(`${feature.id}: ${why} 사용하지 않음(추측 fixture 사용)`);
    if (r.status !== served.status) skip(`녹화 응답이 ${r.status}라`);
    else if (r.kind === "json") fixtures[fixtures.indexOf(served)] = { status: served.status, body: r.body, source: "recorded" };
    else if (r.kind === "truncated") skip("녹화 응답이 1MB를 넘어");
    else if (r.kind === "raw" || served.status !== 204) skip("녹화 응답 바디가 JSON이 아니라");
    // 204 + 빈 바디: 기존 empty fixture와 같으므로 그대로 둔다.
  }
  return { fixtures, assumptions };
}
