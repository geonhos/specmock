import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";

export async function loadOpenApi(origin: string): Promise<OpenAPI.Document> {
  // 파일 경로와 URL 모두 지원. 순환 참조는 무시하고 나머지를 해석한다.
  const api = await SwaggerParser.dereference(origin, { dereference: { circular: "ignore" } });
  return api as OpenAPI.Document;
}

export function isOpenApiText(text: string): boolean {
  // YAML(`openapi: 3.0.0`)과 JSON(`{"swagger":"2.0"}`) 모두 앞부분에서 키를 찾는다.
  const head = text.slice(0, 2000);
  return /["']?(openapi|swagger)["']?\s*:/.test(head);
}
