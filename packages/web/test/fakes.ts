import { vi } from "vitest";

type Route = (body?: unknown) => { status?: number; body: unknown };

/** 가짜 fetch. 키는 "GET /api/systems" 형식이고 호출은 calls에 쌓인다. */
export function fakeApi(routes: Record<string, Route>) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push(body);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ ok: false, error: { code: "not-found", message: `가짜 API에 없는 요청: ${key}` } }), { status: 404 });
    const r = route(body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return { calls, bodies };
}

/** 가짜 EventSource. emit으로 서버 이벤트를, fail로 연결 끊김을 흉내 낸다. */
export class FakeEventSource {
  static last: FakeEventSource | undefined;
  static all: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(readonly url: string) { FakeEventSource.last = this; FakeEventSource.all.push(this); }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn); this.listeners.set(name, set);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void) { this.listeners.get(name)?.delete(fn); }
  close() { this.closed = true; this.readyState = 2; }
  emit(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
  /** 연결 끊김. permanent면 브라우저가 재연결을 포기한 상태(readyState CLOSED, 비 200 응답 등). */
  fail(permanent = false) { this.readyState = permanent ? 2 : 0; this.onerror?.(new Event("error")); }
}
