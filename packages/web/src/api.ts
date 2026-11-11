import type { ApiErr, ApiOk, EnvInfo, FeatureList, Job, JobList, SystemOverview, SystemSummary } from "@specmock/ui-server/api-types";
import type { ChunkSummary, Feature, Selection } from "@specmock/core";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string, readonly jobId?: string, readonly from?: string, readonly to?: string) { super(message); this.name = "ApiError"; }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as ApiOk<T> | (ApiErr & { jobId?: string });
  if (j.ok) return j.data;
  throw new ApiError(r.status, j.error.code, j.error.message, j.error.hint, j.jobId, j.error.from, j.error.to);
}
const s = (name: string) => `/api/systems/${encodeURIComponent(name)}`;

export const api = {
  env: () => call<EnvInfo>("GET", "/api/env"),
  systems: () => call<SystemSummary[]>("GET", "/api/systems"),
  ingest: (system: string, origins: string[]) => call<unknown>("POST", "/api/systems", { system, origins }),
  overview: (name: string) => call<SystemOverview>("GET", s(name)),
  analyze: (name: string) => call<{ mode: "catalog" | "prepared" }>("POST", `${s(name)}/analyze`),
  chunks: (name: string) => call<ChunkSummary[]>("GET", `${s(name)}/chunks`),
  features: (name: string, group?: string) => call<FeatureList>("GET", `${s(name)}/features${group ? `?group=${encodeURIComponent(group)}` : ""}`),
  feature: (name: string, id: string) => call<Feature>("GET", `${s(name)}/features/${encodeURIComponent(id)}`),
  selection: (name: string) => call<Selection | null>("GET", `${s(name)}/selection`),
  saveSelection: (name: string, ids: string[]) => call<{ selected: string[] }>("POST", `${s(name)}/selection`, { ids }),
  extract: (name: string, refresh = false) => call<{ jobId: string }>("POST", `${s(name)}/extract`, { refresh }),
  generate: (name: string, outDir: string, force = false, language?: string) =>
    call<{ jobId: string }>("POST", `${s(name)}/generate`, { outDir, force, ...(language ? { language } : {}) }),
  verify: (name: string) => call<{ jobId: string }>("POST", `${s(name)}/verify`, {}),
  jobs: () => call<JobList>("GET", "/api/jobs"),
  cancel: (id: string) => call<{ state: Job["state"] }>("POST", `/api/jobs/${id}/cancel`),
};
