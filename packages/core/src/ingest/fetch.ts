export interface Fetched {
  bytes: Uint8Array;
  contentType: string; // 소문자, 파라미터 제거. 예: "text/html"
  finalUrl: string;
}

export async function fetchOrigin(url: string, timeoutMs = 30_000): Promise<Fetched> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json, application/yaml, text/yaml, text/markdown, text/html, application/pdf, text/plain, */*",
      "user-agent": "specmock/0.1 (+https://github.com/geonhos/specmock)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} 요청 실패: HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType, finalUrl: res.url || url };
}
