# 세션 내 추출 절차

`specmock analyze <system>`(세션 모드, 기본)이 "LLM 추출 준비 완료"를 출력했을 때. 이 단계는 CLI가 아니라 **당신(Claude)이** 한다.

1. `cat .specmock/<system>/analyze-request.json` — `prompt`(규칙), `schema`(출력 형식), `chunks`(파일 목록)를 읽는다. CLI가 `chunks/NNN.md`와 빈 `extracted/` 디렉터리를 이미 만들어 두었다.
2. 청크마다:
   - `chunks/NNN.md`를 읽는다. 한 번에 한 파일만.
   - `prompt`의 규칙 1~8을 적용해 JSON을 만든다. 핵심: method/path는 문서에 있는 그대로, 샘플 응답은 원문 JSON 그대로, `evidence`는 원문 문장 복사, 확신이 없으면 `confidence`를 낮춘다.
   - `schema`에 맞는지 스스로 확인한다(필수 키: `endpoints[]`, 각 항목 `method path title responses evidence confidence`).
   - `.specmock/<system>/extracted/NNN.json`에 `{"endpoints": [...]}` 형태로 쓴다. 엔드포인트가 없으면 `{"endpoints": []}`.
   - `extracted/manifest.json`은 CLI가 관리한다. 만들거나 고치지 않는다.
3. `specmock analyze <system> --merge`.
   - 일부 청크가 비어 있으면 merge가 "미추출"로 기록하고 진행한다.
4. 출력의 "거절 N건"이 있으면 `catalog.json`의 `rejected[].reason`을 읽고, 수정 가능한 것(예: path에 호스트가 섞임)은 해당 `extracted/NNN.json`을 고친 뒤 다시 `--merge`.

청크를 건너뛰면 merge가 "미추출"로 기록하고 그 청크의 기능은 카탈로그에 빠진다. 건너뛴 사실을 사용자에게 말한다.

청크가 많아(20개 초과) 세션에서 하기 부담스러우면 `specmock analyze <system> --llm claude-code`를 제안한다. 구독으로 청크당 `claude` 호출 1회가 나가므로 사용자 동의를 받는다. 재실행 시 이미 추출된 청크는 재사용되고, `--refresh`를 주면 모두 다시 추출한다.

## MCP 도구로 제출할 때

파일을 직접 쓰는 대신 `submit_extraction`으로 청크 하나씩 제출한다. 서버가 다음을 해 준다:
- 스키마를 검증한다. 모르는 키도 거부한다.
- `extracted/NNN.json`을 원자적으로 쓴다.
- `manifest.json`에 청크 해시를 남긴다.

그래서 문서가 바뀐 뒤 예전 결과가 섞이지 않는다. 결과 모양은 위와 같은 `{ "endpoints": [...] }`다. 모두 제출하면 `merge_extractions`를 부른다.
