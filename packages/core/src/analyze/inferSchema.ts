import type { JsonSchema } from "../types.js";

/**
 * 샘플 값에서 느슨한 JSON Schema를 만든다(설계 5.3 "응답 스키마 없고 샘플만 있으면 유추").
 * 규칙은 단순하다: 값 타입 그대로, 배열은 첫 요소, 객체는 properties. required는 넣지 않는다(샘플 하나로 필수 여부를 알 수 없다).
 */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return value.length === 0 ? { type: "array" } : { type: "array", items: inferSchema(value[0]) };
  switch (typeof value) {
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "string":
      return { type: "string" };
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = inferSchema(v);
      return { type: "object", properties };
    }
    default:
      return {};
  }
}
