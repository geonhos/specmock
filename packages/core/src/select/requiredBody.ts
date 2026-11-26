import type { Feature } from "../types.js";

export interface RequiredBodyField { name: string; example?: unknown }

/**
 * 요청 본문의 필수 최상위 필드(설계 §2 규칙 6). 값은 스펙의 `example`·`examples[0]`만 쓰고, 없으면 비운다.
 * 생성기(faker)는 쓰지 않는다 — 계약 fixture(`select/fixtures.ts`)는 그대로 둔다.
 */
export function requiredBodyFields(feature: Feature): RequiredBodyField[] {
  const body = feature.request.body;
  if (!body || body.type !== "object" || !Array.isArray(body.required)) return [];
  const props = (body.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return (body.required as unknown[]).filter((n): n is string => typeof n === "string").map((name) => {
    const p = props[name];
    const ex = p?.example !== undefined ? p.example : Array.isArray(p?.examples) && p.examples.length > 0 ? p.examples[0] : undefined;
    return ex === undefined ? { name } : { name, example: ex };
  });
}
