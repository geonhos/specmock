/** 등록되는 도구 이름의 단일 출처. 스킬 문서 검사도 이 목록과 비교한다. */
export const TOOL_NAMES = [
  "ingest_spec", "analyze_spec", "get_chunk", "submit_extraction", "merge_extractions",
  "list_features", "show_feature", "select_features", "generate_mock", "verify_mock", "open_ui",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
