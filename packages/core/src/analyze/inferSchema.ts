import type { JsonSchema } from "../types.js";

/** 이보다 깊은 중첩은 `{}`(any)로 끊는다. 샘플이 비정상적으로 깊어도 재귀가 스택을 넘지 않게. */
export const INFER_MAX_DEPTH = 32;

/**
 * 샘플 값에서 느슨한 JSON Schema를 만든다(설계 5.3 "응답 스키마 없고 샘플만 있으면 유추").
 * 규칙은 단순하다: 값 타입 그대로, 배열은 첫 요소, 객체는 properties. required는 넣지 않는다(샘플 하나로 필수 여부를 알 수 없다).
 */
export function inferSchema(value: unknown, depth = 0): JsonSchema {
  if (depth > INFER_MAX_DEPTH) return {};
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return value.length === 0 ? { type: "array" } : { type: "array", items: inferSchema(value[0], depth + 1) };
  switch (typeof value) {
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "string":
      return { type: "string" };
    case "object": {
      // Object.fromEntries는 own property로 만들므로 "__proto__" 같은 키도 프로토타입을 건드리지 않는다.
      const properties: Record<string, JsonSchema> = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, inferSchema(v, depth + 1)]),
      );
      return { type: "object", properties };
    }
    default:
      return {};
  }
}
