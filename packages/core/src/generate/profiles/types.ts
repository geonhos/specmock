// packages/core/src/generate/profiles/types.ts
import type { Command } from "../generator.js";

export interface LanguageProfile {
  language: string;
  displayName: string;
  /** 프롬프트 5항목. 한 줄에 규칙 하나. */
  rules: string[];
  /** core의 templates/<언어>/ 아래 상대 경로. outDir에 같은 상대 경로로 복사한다. mode는 실행 권한(mvnw). */
  staticFiles: { path: string; mode?: number }[];
  /** 플랫폼별 설치 명령. null이면 설치 단계 없음. */
  install: (platform: NodeJS.Platform) => Command | null;
  start: Command;
  healthPath: string;
  startTimeoutMs: number;
  installTimeoutMs: number;
  /** 모델이 쓸 수 있는 곳이자 증분 생성 때 기존 소스로 읽는 범위. */
  sourceGlobs: string[];
  /** 모델이 쓰면 안 되는 곳. */
  protectedPaths: string[];
  maxFiles: number;
  /** 사용자 안내용 환경 요구. */
  requires: string;
  /** 프롬프트 6항목: templates/<언어>/ 아래 참조 발췌 파일. */
  referenceFiles: string[];
  /** 빌드 로그에 보이면 재시도하지 않는 환경 오류 패턴. */
  environmentErrors?: RegExp[];
}
