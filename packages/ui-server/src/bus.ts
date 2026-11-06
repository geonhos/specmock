export interface BusEvent { event: string; data: unknown }

/** SSE로 내보낼 이벤트의 단순 발행·구독 통로. */
export class EventBus {
  private subs = new Set<(e: BusEvent) => void>();
  subscribe(fn: (e: BusEvent) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  publish(event: string, data: unknown): void { for (const fn of this.subs) fn({ event, data }); }
  /** 현재 구독자 수. 연결이 정리되는지 확인하는 테스트용. */
  get size(): number { return this.subs.size; }
}
