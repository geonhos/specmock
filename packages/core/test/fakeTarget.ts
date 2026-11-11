// packages/core/test/fakeTarget.ts
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface FakeReq { method: string; path: string; query: Record<string, string>; headers: IncomingHttpHeaders; /** 받은 요청 본문(UTF-8 문자열). */ body: string }
/** body가 있으면 JSON으로, raw가 있으면 그대로 보낸다. delayMs만큼 늦게 응답한다. */
export interface FakeRes { status: number; body?: unknown; raw?: string; contentType?: string; delayMs?: number; headers?: Record<string, string>; /** true면 응답 없이 소켓을 끊는다(연결 실패 재현). */ destroy?: boolean }
export interface FakeTarget {
  url: string;
  requests: FakeReq[];
  /** 동시에 처리 중이던 요청 수의 최댓값. 순차 실행이면 1. */
  maxConcurrent: () => number;
  close: () => Promise<void>;
}

/** `listen(0, "127.0.0.1")` 가짜 실제 시스템. handler가 요청마다 응답을 정한다. */
export async function startFakeTarget(handler: (req: FakeReq) => FakeRes): Promise<FakeTarget> {
  const requests: FakeReq[] = [];
  let active = 0; let max = 0;
  const server: Server = createServer((req, res) => {
    active++; max = Math.max(max, active);
    const u = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const fr: FakeReq = { method: req.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(fr);
      const out = handler(fr);
      setTimeout(() => {
        if (out.destroy) { active--; res.socket?.destroy(); return; }
        const text = out.raw ?? (out.body === undefined ? "" : JSON.stringify(out.body));
        res.writeHead(out.status, { "content-type": out.contentType ?? "application/json", "content-length": String(Buffer.byteLength(text)), ...out.headers });
        res.end(text, () => { active--; });
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    maxConcurrent: () => max,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** 열었다 닫은 포트. 연결 거부(ECONNREFUSED)를 재현한다. */
export async function closedPortUrl(): Promise<string> {
  const t = await startFakeTarget(() => ({ status: 200 }));
  await t.close();
  return t.url;
}
