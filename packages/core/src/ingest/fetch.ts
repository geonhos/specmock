export interface Fetched {
  bytes: Uint8Array;
  contentType: string; // 소문자, 파라미터 제거. 예: "text/html"
  charset: string; // content-type의 charset 파라미터(소문자). 없으면 "".
  finalUrl: string;
}

/** "text/html; charset=UTF-8" → { type: "text/html", charset: "utf-8" } */
export function parseContentType(header: string | null): { type: string; charset: string } {
  const [first = "", ...params] = (header ?? "").split(";");
  const charset = params
    .map((p) => p.trim().match(/^charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ?? "")
    .find((c) => c.length > 0) ?? "";
  return { type: first.trim().toLowerCase(), charset: charset.toLowerCase() };
}

export async function fetchOrigin(url: string, timeoutMs = 30_000): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/json, application/yaml, text/yaml, text/markdown, text/html, application/pdf, text/plain, */*",
        "user-agent": "specmock/0.1 (+https://github.com/geonhos/specmock)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // undici는 "fetch failed"만 남기므로 원인 코드(ECONNREFUSED 등)와 origin을 메시지에 올린다.
    const err = e as Error & { cause?: { code?: string } };
    const reason = err.name === "TimeoutError" || err.name === "AbortError"
      ? `시간 초과 (${Math.round(timeoutMs / 1000)}초)`
      : err.cause?.code ?? err.message;
    throw new Error(`${url} 요청 실패: ${reason}`, { cause: e });
  }
  if (!res.ok) throw new Error(`${url} 요청 실패: HTTP ${res.status}`);
  const { type, charset } = parseContentType(res.headers.get("content-type"));
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: type, charset, finalUrl: res.url || url };
}
