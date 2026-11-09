// packages/core/src/generate/generator.ts
import type { MockSpec } from "../types.js";

export interface Command { command: string; args: string[] }

/** 증분 생성 입력: 기존 언어 종속 파일과 사용자 수정 여부. */
export interface ExistingSources {
  files: { path: string; content: string; userModified: boolean }[];
}

/** 진행 단계. ui-server가 SSE로, CLI가 stderr로 흘린다. */
export interface GenerateProgress {
  stage: "generating" | "building" | "verifying";
  attempt: number;
  maxAttempts: number;
  message: string;
}

export interface GenerateContext {
  spec: MockSpec;
  outDir: string;
  existing: ExistingSources | null;
  signal?: AbortSignal;
  onProgress?: (e: GenerateProgress) => void;
}

export interface LanguageOutput {
  /** 언어 종속 파일만. outDir 상대 경로. content가 null이면 삭제(LLM 증분). mode는 실행 권한(mvnw = 0o755). */
  files: { path: string; content: string | null; mode?: number }[];
  install: Command | null;
  /** 설치 뒤 outDir 상대 경로로 존재해야 하는 결과물. 없으면(undefined) lock에 null로 기록한다. */
  installCheck?: string | null;
  start: Command;
  healthPath: string;
  startTimeoutMs?: number;
  installTimeoutMs?: number;
  /** 모델의 가정·경고 → coverage.md. 템플릿 생성기는 빈 배열. */
  notes: string[];
  /** 이 디렉터리에서 이번에 쓰지 않은 `ext` 파일을 지운다(TS의 src/routes). */
  prune?: { dir: string; ext: string }[];
  /** LLM 생성기의 시도 횟수. 템플릿은 0. */
  attempts?: number;
}

export interface LanguageGenerator {
  readonly language: string;
  readonly generator: "llm" | "template";
  generate(ctx: GenerateContext): Promise<LanguageOutput>;
}

export interface GenerateReport {
  outDir: string;
  language: string;
  /** 이번 실행에서 쓴 파일 (outDir 기준 상대 경로). */
  written: string[];
  /** 사용자가 수정해 덮어쓰지 않은 fixture. */
  preserved: string[];
  /** 더 이상 선택되지 않은 기능의 fixture 중 사용자가 수정해 남겨둔 것. */
  orphaned: string[];
  /** 실행 안내: `cd <outDir> && <install> && <start>`. */
  launch: string;
  attempts: number;
  notes: string[];
  /** 사용자가 고쳤는데 이번 생성이 다시 쓴 언어 종속 파일. */
  userModified: string[];
  /** mockspec이 바뀌지 않아 LLM을 부르지 않았다. */
  skipped: boolean;
}
