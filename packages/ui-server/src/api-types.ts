import type { Feature, FeatureRow, FlowTargetName as FlowTargetNameT, GenerateInfo, Selection, SourceInput } from "@specmock/core";
import type { ApiErrorBody } from "./errors.js";

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = ApiErrorBody;
export type EnvInfo = { root: string; claude: boolean };

export type StepFlags = { registered: boolean; analyzed: boolean; selected: boolean; generated: boolean; verified: boolean; record: boolean };
export type StaleFlags = { select: boolean; generate: boolean; verify: boolean; record: boolean };
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
export type FeatureGroups = { total: number; groups: { group: string; total: number }[] };
export type FeatureList = { total: number; rows: FeatureListRow[]; groups: string[] };
export type { AnalyzeSpecResult, ChunkSummary, Feature, FeatureRow, GenerateInfo, IngestSpecResult, Selection, SelectResult, SourceInput } from "@specmock/core";
export type { Flow, FlowDetail, FlowInput, FlowList, FlowRun, FlowRunOutcome, FlowSource, FlowStep, FlowSummary, FlowTargetName, Leftover, StepResult, StepState } from "@specmock/core";
export type FlowRunBody = { targets: FlowTargetNameT[]; cleanup?: boolean };
export type SafetyState = { on: boolean };

/** `literal`이 true면 `${이름}` 참조만으로 된 값이 아니다(직접 적은 값을 포함). 헤더의 literal 값만 `value`가 `"***"`고, 공통 값·기능별 값은 원문이다. false면 `${이름}` 참조 원문이다. */
export type TargetEntry = { name: string; value: string; literal: boolean };
export type EnvStatus = "process" | "session" | "missing";
export type TargetInfo = {
  exists: boolean;
  example: string;
  /** 파일이 있지만 형식 오류. */
  error?: string;
  /** 기존 화면 호환용(PR 2에서 새 화면이 `target.baseUrl`을 쓰면 제거). */
  baseUrl?: string;
  suggestedBaseUrl?: string | null;
  target?: {
    baseUrl: string;
    timeoutMs: number;
    headers: TargetEntry[];
    params: TargetEntry[];
    features: Record<string, TargetEntry[]>;
  };
  env?: { name: string; status: EnvStatus }[];
};
/** `keep: true`면 기존 파일의 같은 이름 값을 그대로 둔다(값을 보내지 않는다). */
export type TargetPutItem = { name: string; value?: string; keep?: true };
export type TargetPutBody = {
  baseUrl: string;
  timeoutMs?: number;
  headers: TargetPutItem[];
  params: TargetPutItem[];
  features: Record<string, TargetPutItem[]>;
};
export type EnvPutBody = { values: Record<string, string> };
export type EnvPutResult = { names: string[] };
export type RecordBody = { allowMutating?: boolean; refresh?: boolean; features?: string[]; apply?: boolean };
/** GET /record/last. 녹화된 응답 본문은 싣지 않는다. */
export type RecordLast = {
  exists: boolean;
  driftMarkdown?: string;
  recordedAt?: string;
  recorded: { featureId: string; status: number; at: string }[];
};

export type JobKind = "extract" | "generate" | "verify" | "record" | "flow";
export type Job = {
  id: string; system: string; kind: JobKind;
  state: "running" | "done" | "failed" | "cancelled";
  /** false면 화면이 취소 버튼을 보이지 않는다. */
  cancellable: boolean;
  startedAt: string; endedAt?: string;
  progress?: { message: string; stage?: string; done?: number; total?: number };
  /** 작업을 시작할 때의 입력(화면이 다른 화면에서 시작한 작업도 설명할 수 있게). generate는 outDir. */
  input?: { outDir?: string; language?: string };
  result?: unknown; error?: ApiErrorBody["error"];
};
export type JobList = { running: Job[]; recent: Job[] };
export type WorkspaceChanged = { system: string | null; files: string[] };
export type WatchError = { message: string };
