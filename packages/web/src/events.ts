import { useEffect, useRef, useState } from "react";

export type ServerEventName = "job-started" | "job-progress" | "job-done" | "job-failed" | "workspace-changed" | "watch-error";
const NAMES: ServerEventName[] = ["job-started", "job-progress", "job-done", "job-failed", "workspace-changed", "watch-error"];

/** 연결이 영구히 닫혔을 때(비 200 응답 등) 직접 다시 만드는 백오프. 이 횟수를 넘기면 포기한다. */
export const RECONNECT = { baseMs: 500, maxMs: 8000, attempts: 5 };

export interface ServerHandlers {
  /** 이벤트 이름별 핸들러. data는 JSON으로 푼 값이다. */
  on?: Partial<Record<ServerEventName, (data: any) => void>>;
  /** 끊겼다가 다시 연결됐을 때. 놓친 이벤트를 목록 다시 불러오기로 메운다. */
  onReconnect?: () => void;
}

/**
 * /api/events 하나를 열어 두고 이벤트를 핸들러로 나눠 준다.
 * 일시적 끊김은 EventSource가 스스로 재연결한다. 연결이 CLOSED로 끝나면 백오프로 새로 만들고, 계속 실패하면 dead가 된다.
 */
export function useServerEvents(handlers: ServerHandlers): { connected: boolean; dead: boolean } {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [state, setState] = useState({ connected: true, dead: false });
  useEffect(() => {
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dropped = false;
    let failures = 0;
    let stopped = false;
    const connect = () => {
      const cur = new EventSource("/api/events");
      es = cur;
      cur.addEventListener("ready", () => {
        failures = 0;
        setState({ connected: true, dead: false });
        if (dropped) { dropped = false; ref.current.onReconnect?.(); }
      });
      cur.onerror = () => {
        dropped = true;
        if (cur.readyState !== EventSource.CLOSED) { setState((s) => ({ ...s, connected: false })); return; } // 브라우저가 재연결한다
        cur.close();
        if (failures >= RECONNECT.attempts) { setState({ connected: false, dead: true }); return; }
        setState((s) => ({ ...s, connected: false }));
        timer = setTimeout(() => { if (!stopped) connect(); }, Math.min(RECONNECT.baseMs * 2 ** failures++, RECONNECT.maxMs));
      };
      for (const name of NAMES) {
        cur.addEventListener(name, (e) => {
          let data: unknown;
          try { data = JSON.parse((e as MessageEvent).data as string); } catch { return; }
          ref.current.on?.[name]?.(data);
        });
      }
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); };
  }, []);
  return state;
}
