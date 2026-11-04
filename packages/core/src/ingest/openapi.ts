import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";
import { parse as parseYaml } from "yaml";

/** JSON과 YAML 모두 파싱한다 (JSON은 YAML의 부분집합). */
export function parseSpecText(text: string): unknown {
  return parseYaml(text);
}

/** 최상위에 openapi 또는 swagger 버전 키가 있으면 OpenAPI 문서로 본다. */
export function isOpenApiDocument(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.openapi === "string" || typeof v.swagger === "string";
}

/**
 * origin(파일 경로 또는 URL)을 base로 삼아 이미 읽어 둔 문서를 dereference한다.
 * 순환 참조는 실제 객체 순환으로 남기고(circular: true 기본값), 직렬화 단계에서 끊는다.
 */
export async function dereferenceOpenApi(origin: string, parsed: unknown): Promise<OpenAPI.Document> {
  const api = await SwaggerParser.dereference(origin, parsed as OpenAPI.Document, {});
  return api as OpenAPI.Document;
}

/**
 * 순환 참조를 안전하게 직렬화한다. 조상 스택에 이미 있는 객체(진짜 back-edge)만
 * `{ "x-specmock-circular": true }`로 바꾸고, 여러 곳에서 공유되는 비순환 참조는 그대로 펼친다.
 * (WeakSet "seen" 방식은 공유 참조까지 잘라 버리므로 쓰지 않는다.)
 */
export function stringifyCycleSafe(doc: unknown): string {
  const stack: object[] = [];
  return JSON.stringify(doc, function (this: unknown, _key: string, value: unknown) {
    while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
    if (value && typeof value === "object") {
      if (stack.includes(value as object)) return { "x-specmock-circular": true };
      stack.push(value as object);
    }
    return value;
  });
}
