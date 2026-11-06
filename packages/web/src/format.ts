export const KIND_LABEL: Record<string, string> = { openapi: "OpenAPI", html: "웹 페이지", markdown: "Markdown", pdf: "PDF", text: "텍스트" };
export const kindLabel = (kind: string | undefined): string => (kind ? (KIND_LABEL[kind] ?? kind) : "");
