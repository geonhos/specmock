import { useEffect, useRef, useState } from "react";

export type ServerEventName = "job-started" | "job-progress" | "job-done" | "job-failed" | "workspace-changed" | "watch-error";
const NAMES: ServerEventName[] = ["job-started", "job-progress", "job-done", "job-failed", "workspace-changed", "watch-error"];

export interface ServerHandlers {
  /** 이벤트 이름별 핸들러. data는 JSON으로 푼 값이다. */
  on?: Partial<Record<ServerEventName, (data: any) => void>>;
  /** 끊겼다가 다시 연결됐을 때. 놓친 이벤트를 목록 다시 불러오기로 메운다. */
  onReconnect?: () => void;
}

/** /api/events 하나를 열어 두고 이벤트를 핸들러로 나눠 준다. EventSource가 스스로 재연결한다. 반환값은 연결 상태. */
export function useServerEvents(handlers: ServerHandlers): { connected: boolean } {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const es = new EventSource("/api/events");
    let dropped = false;
    es.addEventListener("ready", () => {
      setConnected(true);
      if (dropped) { dropped = false; ref.current.onReconnect?.(); }
    });
    es.onerror = () => { dropped = true; setConnected(false); };
    for (const name of NAMES) {
      es.addEventListener(name, (e) => {
        let data: unknown;
        try { data = JSON.parse((e as MessageEvent).data as string); } catch { return; }
        ref.current.on?.[name]?.(data);
      });
    }
    return () => es.close();
  }, []);
  return { connected };
}
