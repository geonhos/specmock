import type { EnvInfo, Job, SystemSummary } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Notice } from "./components/Notice";
import { nextScreen, Sidebar } from "./components/Sidebar";
import { Analyze } from "./screens/Analyze";
import { Register } from "./screens/Register";
import { Select, type Change } from "./screens/Select";
import { StepBar } from "./components/StepBar";
import { useServerEvents } from "./events";
import { pathFor, useRoute, type Screen } from "./route";

const TITLES: Record<Screen, string> = {
  home: "불러오는 중이에요",
  new: "스펙을 등록해 주세요",
  analyze: "스펙을 분석해요",
  select: "mock에 넣을 기능을 골라 주세요",
  generate: "mock 생성",
  verify: "mock 검증",
};

export function App() {
  const route = useRoute();
  const [systems, setSystems] = useState<SystemSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [watchStopped, setWatchStopped] = useState(false);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tick, setTick] = useState(0);
  const [change, setChange] = useState<Change | null>(null);

  const reload = useCallback(() => {
    api.systems().then((s) => { setSystems(s); setError(null); }).catch((e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "failed", String(e))));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { api.env().then(setEnv).catch(() => undefined); }, []);

  const upsert = useCallback((j: Job) => setJobs((all) => (all.some((x) => x.id === j.id) ? all.map((x) => (x.id === j.id ? j : x)) : [...all, j])), []);
  const refreshJobs = useCallback(() => {
    api.jobs().then((l) => setJobs((all) => {
      const fresh = [...l.recent, ...l.running];
      return [...all.filter((x) => !fresh.some((f) => f.id === x.id)), ...fresh];
    })).catch(() => undefined);
  }, []);
  useEffect(() => { refreshJobs(); }, [refreshJobs]);

  const { connected, dead } = useServerEvents({
    on: {
      "workspace-changed": (d: { system?: string | null; files?: string[] }) => {
        reload(); setTick((t) => t + 1);
        setChange((c) => ({ n: (c?.n ?? 0) + 1, system: d?.system ?? null, files: d?.files ?? [] }));
      },
      "job-started": upsert, "job-progress": upsert, "job-done": upsert, "job-failed": upsert,
      "watch-error": () => setWatchStopped(true),
    },
    onReconnect: () => { reload(); setTick((t) => t + 1); setChange((c) => ({ n: (c?.n ?? 0) + 1, system: null, files: [] })); refreshJobs(); },
  });

  // "/"는 첫 시스템의 다음 단계, 없으면 등록 화면으로 보낸다.
  const { screen, go } = route;
  useEffect(() => {
    if (screen !== "home" || systems === null) return;
    const first = systems[0];
    go(first ? pathFor(nextScreen(first), first.name) : "/new", { replace: true });
  }, [screen, systems, go]);

  const current = systems?.find((s) => s.name === route.system);
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
      <StepBar system={current} screen={route.screen} go={go} />
      <div className={`body${route.screen === "select" ? " with-detail" : ""}`}>
        <Sidebar systems={systems ?? []} current={route.system} go={go} />
        {route.screen === "select" && route.system ? (
          <Select key={route.system} system={route.system} change={change} go={go} header={head} />
        ) : (
          <main className="panel mid">
            {head}
            {route.screen === "new" ? <Register go={go} onRegistered={reload} /> : null}
            {route.screen === "analyze" && route.system ? (
              <Analyze key={route.system} system={route.system} claude={env?.claude} jobs={jobs} tick={tick} go={go} refreshJobs={refreshJobs} onChanged={reload} />
            ) : null}
          </main>
        )}
      </div>
    </div>
  );
}
