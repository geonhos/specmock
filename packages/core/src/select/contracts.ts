import type { Contract, Feature, Fixture, JsonSchema } from "../types.js";
import { generateFromSchema } from "./fixtures.js";

/** 스키마 하나에 대한 대표 값. 경로·쿼리 파라미터용. 제약(범위·길이·패턴·포맷)을 지킨다. */
export function sampleScalar(schema: JsonSchema | null): string {
  if (!schema) return "sample";
  if (schema.example !== undefined && (typeof schema.example !== "object" || schema.example === null)) return String(schema.example);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return String(schema.enum[0]);
  if (schema.default !== undefined && typeof schema.default !== "object") return String(schema.default);
  if (schema.type === "boolean") return "true";
  const numericConstraint = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((k) => schema[k] !== undefined);
  if ((schema.type === "integer" || schema.type === "number") && !numericConstraint) return "1";
  const generated = generateFromSchema(schema);
  if (generated !== null && generated !== undefined && typeof generated !== "object") return String(generated);
  switch (schema.type) {
    case "integer":
    case "number": return "1";
    case "boolean": return "true";
    default: return "sample";
  }
}

export function fillPath(feature: Feature): string {
  return feature.path.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    encodeURIComponent(sampleScalar(feature.request.params[name]?.schema ?? null)),
  );
}

function lowest2xx(fixtures: Fixture[]): Fixture | undefined {
  return fixtures.filter((f) => f.status >= 200 && f.status < 300).sort((a, b) => a.status - b.status)[0];
}

export function buildContracts(feature: Feature, fixtures: Fixture[]): Contract[] {
  const ok = lowest2xx(fixtures);
  if (!ok) return [];
  const requiredQuery = Object.fromEntries(
    Object.entries(feature.request.query).filter(([, p]) => p.required).map(([k, p]) => [k, sampleScalar(p.schema)]),
  );
  const body = feature.request.body ? generateFromSchema(feature.request.body) : null;
  const contracts: Contract[] = [
    {
      featureId: feature.id,
      name: "정상 요청",
      request: { method: feature.method, path: fillPath(feature), headers: {}, query: requiredQuery, body },
      expect: { status: ok.status, schema: feature.responses[String(ok.status)]?.schema ?? null },
    },
  ];

  const errorStatus = [400, 422].find((s) => fixtures.some((f) => f.status === s));
  const hasRequired = Object.keys(requiredQuery).length > 0 || Boolean(feature.request.body);
  if (errorStatus && hasRequired) {
    contracts.push({
      featureId: feature.id,
      name: "필수 값 누락",
      request: { method: feature.method, path: fillPath(feature), headers: {}, query: {}, body: null },
      expect: { status: 400, schema: null },
    });
  }
  return contracts;
}
