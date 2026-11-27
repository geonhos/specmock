import type { ApiErr, ApiOk, EnvInfo, EnvPutBody, EnvPutResult, FeatureGroups, FeatureList, FlowDetail, FlowList, FlowSource, FlowTargetName, Job, JobList, SafetyState, SystemOverview, SystemSummary, TargetInfo, TargetPutBody } from "@specmock/ui-server/api-types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string, readonly jobId?: string, readonly from?: string, readonly to?: string) { super(message); this.name = "ApiError"; }
}

export type { TargetInfo };

async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
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
  features: (name: string, group?: string) => call<FeatureList>("GET", `${s(name)}/features${group ? `?group=${encodeURIComponent(group)}` : ""}`),
  featureGroups: (name: string) => call<FeatureGroups>("GET", `${s(name)}/feature-groups`),
  flows: (name: string) => call<FlowList>("GET", `${s(name)}/flows`),
  inferFlows: (name: string) => call<unknown>("POST", `${s(name)}/flows/infer`, {}),
  flow: (name: string, id: string) => call<FlowDetail>("GET", `${s(name)}/flows/${encodeURIComponent(id)}`),
  setFlowInput: (name: string, id: string, stepId: string, slot: string, source: FlowSource) =>
    call<FlowDetail>("POST", `${s(name)}/flows/${encodeURIComponent(id)}/inputs`, { stepId, slot, source }),
  runFlow: (name: string, id: string, targets: FlowTargetName[], cleanup: boolean) =>
    call<{ jobId: string }>("POST", `${s(name)}/flows/${encodeURIComponent(id)}/run`, { targets, cleanup }),
  safety: (name: string) => call<SafetyState>("GET", `${s(name)}/safety`),
  setSafety: (name: string, on: boolean) => call<SafetyState>("POST", `${s(name)}/safety`, { on }),
  saveSelection: (name: string, ids: string[]) => call<{ selected: string[] }>("POST", `${s(name)}/selection`, { ids }),
  target: (name: string) => call<TargetInfo>("GET", `${s(name)}/target`),
  putTarget: (name: string, body: TargetPutBody) => call<TargetInfo>("PUT", `${s(name)}/target`, body),
  setEnv: (name: string, values: EnvPutBody["values"]) => call<EnvPutResult>("POST", `${s(name)}/env`, { values }),
  jobs: () => call<JobList>("GET", "/api/jobs"),
  cancel: (id: string) => call<{ state: Job["state"] }>("POST", `/api/jobs/${id}/cancel`),
};
