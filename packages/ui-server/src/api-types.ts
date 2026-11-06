import type { Feature, FeatureRow, GenerateInfo, Selection, SourceInput } from "@specmock/core";
import type { ApiErrorBody } from "./errors.js";

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = ApiErrorBody;
export type EnvInfo = { root: string; claude: boolean };

export type StepFlags = { registered: boolean; analyzed: boolean; selected: boolean; generated: boolean; verified: boolean };
export type StaleFlags = { select: boolean; generate: boolean; verify: boolean };
export type SystemSummary = {
  name: string;
  kind: SourceInput["kind"] | null;
  steps: StepFlags;
  stale: StaleFlags;
  chunks?: { done: number; total: number };
};
export type SystemOverview = {
  summary: SystemSummary;
  source: SourceInput[];
  analyze: "none" | "prepared" | "catalog";
  catalogTotal: number;
  selection: Selection | null;
  generate: GenerateInfo | null;
  coverage: string | null;
  defaultOutDir: string;
};
export type FeatureList = { total: number; rows: FeatureRow[]; groups: string[] };
export type { AnalyzeSpecResult, ChunkSummary, Feature, FeatureRow, GenerateInfo, IngestSpecResult, Selection, SelectResult, SourceInput } from "@specmock/core";

export type JobKind = "extract" | "generate" | "verify";
export type Job = {
  id: string; system: string; kind: JobKind;
  state: "running" | "done" | "failed" | "cancelled";
  /** false면 화면이 취소 버튼을 보이지 않는다. */
  cancellable: boolean;
  startedAt: string; endedAt?: string;
  progress?: { message: string; done?: number; total?: number };
  result?: unknown; error?: ApiErrorBody["error"];
};
export type JobList = { running: Job[]; recent: Job[] };
export type WorkspaceChanged = { system: string | null; files: string[] };
export type WatchError = { message: string };
