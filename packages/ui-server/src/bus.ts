export interface BusEvent { event: string; data: unknown }

/** SSE로 내보낼 이벤트의 단순 발행·구독 통로. */
export class EventBus {
  private subs = new Set<(e: BusEvent) => void>();
  subscribe(fn: (e: BusEvent) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  publish(event: string, data: unknown): void { for (const fn of this.subs) fn({ event, data }); }
  /** 현재 구독자 수. 연결이 정리되는지 확인하는 테스트용. */
  get size(): number { return this.subs.size; }
}

/** 느린 SSE 클라이언트용 큐 상한. 넘치면 오래된 job-progress(와 ping)부터 버린다. 완료·실패·변경 알림은 버리지 않는다. */
export function pushBounded(queue: BusEvent[], e: BusEvent, limit: number): void {
  queue.push(e);
  while (queue.length > limit) {
    const i = queue.findIndex((x) => x.event === "job-progress" || x.event === "ping");
    if (i < 0) return;
    queue.splice(i, 1);
  }
}
