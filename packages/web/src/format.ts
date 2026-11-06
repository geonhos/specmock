export const KIND_LABEL: Record<string, string> = { openapi: "OpenAPI", html: "웹 페이지", markdown: "Markdown", pdf: "PDF", text: "텍스트" };
export const kindLabel = (kind: string | undefined): string => (kind ? (KIND_LABEL[kind] ?? kind) : "");
export const JOB_KIND_LABEL: Record<string, string> = { extract: "추출", generate: "생성", verify: "검증" };
export const jobKindLabel = (kind: string): string => JOB_KIND_LABEL[kind] ?? kind;
/** 원본 표시: URL이면 호스트, 파일 경로면 파일 이름. */
export function originLabel(origin: string): string {
  if (/^https?:\/\//.test(origin)) { try { return new URL(origin).host; } catch { return origin; } }
  return origin.split(/[\\/]/).filter(Boolean).pop() ?? origin;
}
