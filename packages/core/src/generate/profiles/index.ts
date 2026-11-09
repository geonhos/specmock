/** 사용자에게 허용하는 언어. 각 언어는 실제 기동·검증 테스트가 있어야 등록한다. */
export const SUPPORTED_LANGUAGES: string[] = ["ts"];

export function assertLanguage(language: string): void {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`'${language}' 언어는 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
}
