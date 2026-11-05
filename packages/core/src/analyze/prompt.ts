/**
 * 청크 하나를 LLM에 줄 때 앞에 붙이는 지시문. 출력 형식은 JSON 스키마(extractionJsonSchema)로 강제하므로
 * 여기서는 "무엇을 어떻게 채울지"만 말한다. 세션 어댑터(스킬 모드)에서도 같은 문장을 쓴다.
 */
export const EXTRACTION_PROMPT = `당신은 API 문서에서 HTTP 엔드포인트를 추출하는 도구입니다. 아래 "문서 청크"만 보고 답하세요. 추측으로 채우지 말고, 모르면 비워 두세요.

규칙:
1. 청크 안에서 확인되는 엔드포인트만 endpoints에 넣습니다. 없으면 빈 배열입니다.
2. method는 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS 중 하나. path는 "/"로 시작하고 경로 변수는 {name} 형태로 씁니다(":id"나 "<id>"는 {id}로 바꿉니다). base URL(호스트, /v1 같은 공통 접두)은 path에서 제외합니다. 단, 문서가 모든 경로에 접두를 붙여 쓰면 그대로 둡니다.
3. method나 path를 문맥으로 추측했으면 inferred.method / inferred.path를 true로 표시합니다.
4. responses에는 문서가 언급한 상태 코드마다 항목을 만듭니다. 샘플 응답 JSON이 있으면 example에 **원문 그대로** 파싱해 넣습니다(값을 바꾸거나 줄이지 않습니다). 스키마는 알 수 있는 범위에서 JSON Schema(type/properties/items/required/enum)로 적습니다. 모르면 null입니다.
5. pathParams/queryParams/headers/requestBody도 문서에 있는 만큼만 적습니다. 인증 헤더는 auth(bearer/apiKey/basic/none)로 표시하고 headers에는 넣지 않습니다.
6. evidence에는 그 엔드포인트가 있다고 판단한 근거가 된 **원문 문장을 글자 그대로** 1~3개 복사합니다. 바꿔 쓰지 않습니다. 이 인용은 나중에 원문과 대조됩니다.
7. confidence는 0~1. method와 path가 문서에 명시돼 있고 응답 예시까지 있으면 0.9 이상, 설명만 있으면 0.6~0.8, 추측이 섞이면 0.5 이하.
8. title은 한 줄 이름(문서의 소제목이 있으면 그것), summary는 한두 문장, group은 문서의 상위 섹션 이름이나 리소스 이름(없으면 빈 문자열).

문서 청크:
`;

export function buildChunkPrompt(chunkText: string): string {
  return `${EXTRACTION_PROMPT}\n<<<\n${chunkText}\n>>>\n`;
}
