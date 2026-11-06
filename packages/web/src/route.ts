import { useCallback, useEffect, useState } from "react";

export type Screen = "home" | "new" | "analyze" | "select" | "generate" | "verify";
export interface Route { screen: Screen; system?: string }

export const STEP_SCREENS = ["new", "analyze", "select", "generate", "verify"] as const;

export function parseRoute(pathname: string): Route {
  if (pathname === "/new") return { screen: "new" };
  const m = /^\/systems\/([^/]+)\/(analyze|select|generate|verify)$/.exec(pathname);
  if (m) return { screen: m[2] as Screen, system: decodeURIComponent(m[1]!) };
  return { screen: "home" };
}

export function pathFor(screen: Screen, system?: string): string {
  if (screen === "new" || !system) return screen === "home" ? "/" : "/new";
  return `/systems/${encodeURIComponent(system)}/${screen}`;
}

/** 라우터 없이 history API로 처리한다. 서버가 SPA 폴백을 주므로 새로 고침해도 같은 화면이 열린다. */
export function useRoute(): Route & { go: (path: string, opts?: { replace?: boolean }) => void } {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (to === window.location.pathname) return;
    if (opts?.replace) window.history.replaceState(null, "", to); else window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  return { ...parseRoute(path), go };
}
