/**
 * source.json에 저장하기 전에 토큰처럼 보이는 문자열을 가린다(설계 §6).
 * 패턴 기반이라 완전하지 않다: Bearer 토큰, `sk_live_` 류 키, `api_key: <값>` 형태의 키-값만 다룬다.
 * 값이 8자 미만이거나 `{`·`"`로 시작하면(스키마 정의, 파라미터 이름 등) 건드리지 않는다.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9\-_.=]{16,}/g, "$1***"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_***"],
  [/(["']?(?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]{8,}/gi, "$1***"],
];

export function maskSecrets(text: string): string {
  return PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}
