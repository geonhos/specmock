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
/** 화면 목록용 행: core FeatureRow에 한 줄 설명(summary)과 응답 코드(codes)를 더한다. MCP 응답 형식은 그대로다. */
export type FeatureListRow = FeatureRow & { summary: string; codes: string[] };
export type FeatureList = { total: number; rows: FeatureListRow[]; groups: string[] };
export type { AnalyzeSpecResult, ChunkSummary, Feature, FeatureRow, GenerateInfo, IngestSpecResult, Selection, SelectResult, SourceInput } from "@specmock/core";

export type JobKind = "extract" | "generate" | "verify";
export type Job = {
  id: string; system: string; kind: JobKind;
  state: "running" | "done" | "failed" | "cancelled";
  /** false면 화면이 취소 버튼을 보이지 않는다. */
  cancellable: boolean;
  startedAt: string; endedAt?: string;
  progress?: { message: string; done?: number; total?: number };
  /** 작업을 시작할 때의 입력(화면이 다른 화면에서 시작한 작업도 설명할 수 있게). generate는 outDir. */
  input?: { outDir?: string; language?: string };
  result?: unknown; error?: ApiErrorBody["error"];
};
export type JobList = { running: Job[]; recent: Job[] };
export type WorkspaceChanged = { system: string | null; files: string[] };
export type WatchError = { message: string };
