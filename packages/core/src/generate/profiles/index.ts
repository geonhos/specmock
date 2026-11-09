import type { LanguageProfile } from "./types.js";

/** 프로필 등록표 항목. ts는 템플릿 생성기라 LLM 프로필이 없다. */
export interface LanguageEntry {
  language: string;
  /** 언어 변경(--force) 때 지우는 빌드 산출물(outDir 상대). */
  artifacts: string[];
  /** 설치 뒤 있어야 하는 결과물. null = 검사 없음. */
  installCheck: string | null;
  profile: LanguageProfile | null;
}

const REGISTRY: Record<string, LanguageEntry> = {
  ts: { language: "ts", artifacts: ["node_modules", "package-lock.json"], installCheck: "node_modules", profile: null },
};

/** 사용자에게 허용하는 언어. 각 언어는 실제 기동·검증 테스트가 있어야 등록한다. */
export const SUPPORTED_LANGUAGES: string[] = Object.keys(REGISTRY);

export function assertLanguage(language: string): void {
  if (!(language in REGISTRY)) {
    throw new Error(`'${language}' 언어는 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
}

export function getEntry(language: string): LanguageEntry | null {
  return REGISTRY[language] ?? null;
}

export function getProfile(language: string): LanguageProfile | null {
  return REGISTRY[language]?.profile ?? null;
}

/** 테스트 전용: 언어를 임시로 등록하고 되돌리는 함수를 돌려준다. SUPPORTED_LANGUAGES는 건드리지 않는다. */
export function registerLanguageForTest(entry: LanguageEntry): () => void {
  REGISTRY[entry.language] = entry;
  return () => { delete REGISTRY[entry.language]; };
}

export type { LanguageProfile } from "./types.js";
