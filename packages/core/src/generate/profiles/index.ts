import type { LanguageProfile } from "./types.js";

/** LLM으로 생성하는 언어의 프로필. 비어 있으면 ts만 지원한다. */
const PROFILES: Record<string, LanguageProfile> = {};

/** 사용자에게 허용하는 언어. 각 언어는 실제 기동·검증 테스트가 있어야 등록한다. */
export const SUPPORTED_LANGUAGES: string[] = ["ts", ...Object.keys(PROFILES)];

export function assertLanguage(language: string): void {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`'${language}' 언어는 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
}

export function getProfile(language: string): LanguageProfile | null {
  return PROFILES[language] ?? null;
}

export type { LanguageProfile } from "./types.js";
