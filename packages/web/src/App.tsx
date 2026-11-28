import type { Job, SystemSummary } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Notice } from "./components/Notice";
import { Sidebar } from "./components/Sidebar";
import { Flows } from "./screens/Flows";
import { Register } from "./screens/Register";
import { useServerEvents } from "./events";
import { pathFor, useRoute, type Screen } from "./route";

const TITLES: Record<Screen, string> = { home: "불러오는 중이에요", new: "서비스를 등록해 주세요", flows: "흐름" };

/**
 * 작업 상태는 되돌아가지 않는다. 목록 스냅숏(GET /api/jobs)은 작업 중에 찍혀 SSE의 끝남 이벤트보다 늦게 올 수 있으므로,
 * 이미 끝난(done/failed/cancelled) 로컬 상태를 같은 jobId의 running으로 되돌리지 않는다.
 */
function mergeJob(local: Job, incoming: Job): Job {
  return local.state !== "running" && incoming.state === "running" ? local : incoming;
}

export function App() {
  const route = useRoute();
  const [systems, setSystems] = useState<SystemSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [watchStopped, setWatchStopped] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    api.systems().then((s) => { setSystems(s); setError(null); }).catch((e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "failed", String(e))));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const upsert = useCallback((j: Job) => setJobs((all) => (all.some((x) => x.id === j.id) ? all.map((x) => (x.id === j.id ? mergeJob(x, j) : x)) : [...all, j])), []);
  const refreshJobs = useCallback(() => {
    api.jobs().then((l) => setJobs((all) => {
      const fresh = [...l.recent, ...l.running];
      return [...all.map((x) => { const f = fresh.find((y) => y.id === x.id); return f ? mergeJob(x, f) : x; }), ...fresh.filter((f) => !all.some((x) => x.id === f.id))];
    })).catch(() => undefined);
  }, []);
  useEffect(() => { refreshJobs(); }, [refreshJobs]);

  const { connected, dead } = useServerEvents({
    on: {
      "workspace-changed": () => {
        reload(); setTick((t) => t + 1);
      },
      "job-started": upsert, "job-progress": upsert, "job-done": upsert, "job-failed": upsert,
      "watch-error": () => setWatchStopped(true),
    },
    onReconnect: () => { reload(); setTick((t) => t + 1); refreshJobs(); },
  });

  // "/"는 첫 서비스의 흐름 화면, 없으면 등록 화면으로 보낸다.
  const { screen, go } = route;
  useEffect(() => {
    if (screen !== "home" || systems === null) return;
    const first = systems[0];
    go(first ? pathFor("flows", first.name) : "/new", { replace: true });
  }, [screen, systems, go]);

  const head = (
    <>
      {dead ? <Notice message="서버와 연결이 끊겼어요" hint="새로고침해 주세요." /> : !connected ? <Notice message="연결이 끊겼어요" hint="다시 연결하는 중이에요." /> : null}
      {watchStopped ? <Notice message="변경 감지가 멈췄어요" hint="화면을 새로고침해 주세요." /> : null}
      {error ? <Notice message={error.message} hint={error.hint} /> : null}
      <h1>{TITLES[route.screen]}</h1>
    </>
  );
  return (
    <div className="app">
      <div className="body">
        <Sidebar systems={systems ?? []} current={route.system} go={go} />
        <main className="panel mid">
          {head}
          {route.screen === "new" ? <Register go={go} onRegistered={reload} /> : null}
          {route.screen === "flows" && route.system ? <Flows key={route.system} system={route.system} jobs={jobs} tick={tick} refreshJobs={refreshJobs} /> : null}
        </main>
      </div>
    </div>
  );
}
