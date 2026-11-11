import { describe, expect, it } from "vitest";
import { maskHeaders, maskSecrets } from "../src/ingest/mask.js";

describe("maskSecrets", () => {
  it("masks Bearer tokens", () => {
    expect(maskSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc")).toBe("Authorization: Bearer ***");
    // 짧은 값(예: 문서의 placeholder)은 그대로 둔다.
    expect(maskSecrets("Bearer <token>")).toBe("Bearer <token>");
  });

  it("masks sk-ant- keys", () => {
    const body = "Ab1_".repeat(6);
    expect(maskSecrets(`key sk-ant-api03-${body} end`)).toBe("key sk-ant-*** end");
    expect(maskSecrets("sk-ant-short")).toBe("sk-ant-short");   // 8자 미만 본문은 그대로
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

describe("maskSecrets query", () => {
  it("api_key 값만 가리고 뒤의 &x=1은 남긴다", () => {
    expect(maskSecrets("GET /pets?api_key=abcdefgh123&x=1")).toBe("GET /pets?api_key=***&x=1");
    expect(maskSecrets("/a?access_token=0123456789ab&limit=2&secret=zzzzzzzzzz")).toBe("/a?access_token=***&limit=2&secret=***");
  });
});

describe("maskHeaders", () => {
  it("키 이름만 보고 값 전체를 가리며 원래 키 대소문자를 지킨다", () => {
    expect(maskHeaders({
      Authorization: "Basic dXNlcjpwYXNz",
      cookie: "sid=1",
      "Set-Cookie": "a=b",
      "x-api-key": "k",
      token: "t",
      "X-Client-Secret": "s",
      "x-password-hint": "p",
      "Proxy-Authorization": "Basic x",
      "x-auth": "a",
      "x-session-id": "s",
      "X-Tenant": "dev",
      accept: "application/json",
    })).toEqual({
      Authorization: "***",
      cookie: "***",
      "Set-Cookie": "***",
      "x-api-key": "***",
      token: "***",
      "X-Client-Secret": "***",
      "x-password-hint": "***",
      "Proxy-Authorization": "***",
      "x-auth": "***",
      "x-session-id": "***",
      "X-Tenant": "dev",
      accept: "application/json",
    });
  });

  it("빈 객체는 빈 객체", () => {
    expect(maskHeaders({})).toEqual({});
  });
});
