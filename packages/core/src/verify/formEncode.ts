/** 계약 body(object)를 Stripe 규약의 form-encoded 문자열로 만든다.
 *  중첩 object `a[b]`, 배열 `a[0]`, boolean `true`/`false`, number는 String(n).
 *  null · 빈 object · 빈 배열은 생략한다. */
export function encodeForm(body: unknown): string {
  const params = new URLSearchParams();
  const walk = (value: unknown, key: string | null): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, key === null ? String(i) : `${key}[${i}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, key === null ? k : `${key}[${k}]`);
      }
      return;
    }
    if (key === null) return; // 최상위 스칼라는 form으로 표현할 수 없어 생략한다.
    params.append(key, typeof value === "string" ? value : String(value));
  };
  walk(body, null);
  return params.toString();
}

export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** 병합된(소문자 키) headers의 content-type이 form-encoded인지. */
export function isFormContentType(headers: Record<string, string>): boolean {
  const ct = headers["content-type"] ?? "";
  return ct.split(";")[0].trim().toLowerCase() === FORM_CONTENT_TYPE;
}
