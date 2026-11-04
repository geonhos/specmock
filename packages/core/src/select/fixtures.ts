import { generateSync } from "json-schema-faker";
import type { Feature, Fixture, JsonSchema } from "../types.js";

export const FIXTURE_SEED = 42;

export function generateFromSchema(schema: JsonSchema, seed = FIXTURE_SEED): unknown {
  return generateSync(schema as Parameters<typeof generateSync>[0], {
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

export function buildFixtures(feature: Feature): { fixtures: Fixture[]; assumptions: string[] } {
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

  if (fixtures.length === 0) {
    fixtures.push({ status: 200, body: {}, source: "empty" });
    assumptions.push(`${feature.id}: 응답 정의 없음. 200 빈 객체를 반환한다.`);
  }
  return { fixtures, assumptions };
}
