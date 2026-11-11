/**
 * source.json에 저장하기 전에 토큰처럼 보이는 문자열을 가린다(설계 §6).
 * 패턴 기반이라 완전하지 않다: Bearer 토큰, `sk_live_` 류 키, `api_key: <값>` 형태의 키-값만 다룬다.
 * 값이 8자 미만이거나 `{`·`"`로 시작하면(스키마 정의, 파라미터 이름 등) 건드리지 않는다.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9\-_.=]{16,}/g, "$1***"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_***"],
  [/(["']?(?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}&]{8,}/gi, "$1***"],
];

export function maskSecrets(text: string): string {
  return PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}

const SECRET_HEADER_EXACT = new Set(["authorization", "cookie", "set-cookie"]);
const SECRET_HEADER_PART = ["key", "token", "secret", "password", "auth", "session"];

/** 헤더 이름만 보고 값 전체를 가린다(값 길이·모양은 보지 않는다). 키 대소문자는 그대로 둔다. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => {
    const lower = k.toLowerCase();
    const secret = SECRET_HEADER_EXACT.has(lower) || SECRET_HEADER_PART.some((p) => lower.includes(p));
    return [k, secret ? "***" : v];
  }));
}

/** 출처 기반 마스킹: 값의 정확한 문자열을 `***`로 바꾼다(긴 값부터). 4자 미만 값은 다른 텍스트를 지우는 오탐이 커서 가리지 않는다. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const v of [...new Set(secrets)].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
  return out;
}
