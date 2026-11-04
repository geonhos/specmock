import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src/ingest/mask.js";

describe("maskSecrets", () => {
  it("masks Bearer tokens", () => {
    expect(maskSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc")).toBe("Authorization: Bearer ***");
    // 짧은 값(예: 문서의 placeholder)은 그대로 둔다.
    expect(maskSecrets("Bearer <token>")).toBe("Bearer <token>");
  });

  it("masks sk_/pk_/rk_ live/test keys", () => {
    // 실제 키처럼 보이는 리터럴은 GitHub push protection에 걸리므로 런타임에 조합한다.
    const fakeBody = "Ab1".repeat(8);
    expect(maskSecrets(`key=sk_live_${fakeBody}`)).toBe("key=sk_live_***");
    expect(maskSecrets(`pk_test_${fakeBody}`)).toBe("pk_test_***");
    expect(maskSecrets("rk_live_abcdefgh1234")).toBe("rk_live_***");
    expect(maskSecrets("sk_live_short")).toBe("sk_live_short");
  });

  it("masks key-value pairs for api_key / access_token / secret / password / authorization", () => {
    expect(maskSecrets('"api_key": "0123456789abcdef"')).toBe('"api_key": "***"');
    expect(maskSecrets("apiKey=0123456789abcdef")).toBe("apiKey=***");
    expect(maskSecrets("access-token: 0123456789abcdef")).toBe("access-token: ***");
    expect(maskSecrets('{"password":"hunter2hunter2"}')).toBe('{"password":"***"}');
    expect(maskSecrets("SECRET = topsecretvalue")).toBe("SECRET = ***");
    expect(maskSecrets('"authorization": "dXNlcjpwYXNzd29yZA=="')).toBe('"authorization": "***"');
  });

  it("leaves OpenAPI parameter names and schema definitions untouched", () => {
    // 파라미터 이름이 X-API-Key인 것은 값이 아니다.
    const param = '{"name": "X-API-Key", "in": "header", "required": true}';
    expect(maskSecrets(param)).toBe(param);
    // 스키마 속성 정의: 값이 `{`로 시작한다.
    const schema = '{"password": {"type": "string", "format": "password"}, "apiKey": {"type": "string"}}';
    expect(maskSecrets(schema)).toBe(schema);
    // securitySchemes의 `type: apiKey`는 키 이름이 type이다.
    const scheme = '{"ApiKeyAuth": {"type": "apiKey", "in": "header", "name": "X-API-Key"}}';
    expect(maskSecrets(scheme)).toBe(scheme);
  });
});
