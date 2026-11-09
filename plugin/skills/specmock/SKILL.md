---
name: specmock
description: Use when the user wants a mock server for an external API from a spec, docs URL, PDF or Markdown — "이 API mock 만들어줘", "스펙 분석해서 필요한 것만", "연동 테스트용 가짜 서버". Walks ingest → analyze → feature list → user selection → generate → verify with the specmock MCP tools (or the specmock CLI when the tools are not available), doing the LLM extraction in-session for unstructured docs.
---

# specmock

스펙에서 **기능 목록을 먼저 보여주고, 사용자가 고른 것만** mock으로 만든다. 모든 상태는 `.specmock/<system>/` 파일이다. 아래 단계를 순서대로 밟고, 각 단계의 출력을 요약해 보여준다.

## MCP 도구가 있으면 도구로 진행한다

specmock 플러그인을 로드하면 specmock MCP 서버의 도구 12개가 함께 켜진다. 이 도구들이 보이면 **셸 명령 대신 도구를 쓴다**. 권한 확인 창이 없고 결과가 구조화되어 돌아온다. 보이지 않으면 아래 0~5의 CLI 흐름을 쓴다.

도구가 안 보이면 `packages/mcp/dist/server.js`가 없는 경우(저장소에서 `pnpm build`를 안 함)가 흔하다. 사용자에게 `pnpm build` 후 Claude Code에서 `/mcp`로 specmock 서버가 연결됐는지 확인하게 하고, 그래도 없으면 CLI 흐름으로 간다. 실제 도구 이름은 `mcp__plugin_specmock_specmock__<이름>` 형태다.

| 도구 | 하는 일 |
|---|---|
| `ingest_spec` | 파일/URL을 읽어 source.json으로 (`origins`, `harvest`, `refresh`) |
| `analyze_spec` | OpenAPI면 카탈로그. 문서면 추출 프롬프트 · 스키마 · 청크 목록(본문 없음) |
| `get_chunk` | 청크 하나의 본문 |
| `submit_extraction` | 청크 하나의 추출 결과 제출. 검증 실패면 `ok: false`와 오류 위치 |
| `merge_extractions` | 제출된 결과를 합쳐 카탈로그 |
| `list_features` | 기능 표(그대로 보여 줄 것) + 행 데이터 |
| `show_feature` | 기능 하나의 스키마 · 샘플 · 근거 |
| `select_features` | 선택 표현식으로 선택 (`mode`: set/add/remove) |
| `generate_mock` | mock 서버 생성 (`./mock/<system>/`). `language`(ts·java). java는 지시서를 쓰고 멈춤(`mode: "session"`) |
| `finalize_generation` | 세션에서 쓴 파일 확정(보호 경로·범위 검사, fixtures·contracts·lock 작성). 실패면 `ok: false`와 `reason` |
| `verify_mock` | contract test + coverage.md |
| `record_responses` | `target.json`의 실제 시스템에 정상 요청을 보내 녹화 + drift.md, mock fixture에 반영 (`allowMutating`, `features`, `refresh`, `apply`) |
| `open_ui` | 브라우저 화면 서버를 띄우고 URL만 돌려줌(두 번 불러도 같은 URL) |

흐름:

1. `ingest_spec` → `analyze_spec`.
2. `mode: "needs-extraction"`이면 `done: false`인 청크마다 **하나씩** `get_chunk` → `prompt` 규칙대로 `schema`에 맞는 `{ "endpoints": [...] }`를 만든다 → `submit_extraction`(`contentHash`는 `get_chunk`가 준 값 그대로).
   - 응답의 `remaining`(아직 제출하지 않은 청크 번호)으로 진행을 추적한다. 비면 모두 끝난 것이다.
   - `ok: false, reason: "invalid"`면 `errors`의 경로를 보고 고쳐 같은 청크를 다시 제출한다.
   - `reason: "stale-chunk"`면 문서가 다시 분석된 것이므로 `analyze_spec`부터 다시 한다.
   - `reason: "unknown-chunk"`면 청크 번호가 현재 목록에 없는 것이므로 `analyze_spec`을 다시 불러 청크 목록을 갱신한다.
   - 모든 청크가 끝나면 `merge_extractions`. `missingChunks`가 남으면 사용자에게 알린다.
   - 청크가 20개를 넘으면 수를 먼저 알리고 진행할지 묻는다.
3. `list_features`의 `table`을 그대로 보여 주고 선택을 받는다(아래 3절의 설명과 규칙이 같다).
4. `select_features` → `generate_mock` → `verify_mock`. `failed > 0`이면 `failures`를 옮겨 적는다(CLI의 종료 코드 2와 같은 상황).
   - 사용자가 TypeScript가 아닌 언어(예: Java)를 원하면 `generate_mock(language: "java")`. `mode: "session"`이 오면 **당신이 직접** 작성한다:
     1. `requestPath`의 지시서(`generate-request.json`)에서 `prompt`를 읽는다. 런타임 계약·TS 참조 구현·Java 규칙·참조 예시가 들어 있다.
     2. `outDir` 아래 `sourceGlobs`(Java: `pom.xml`, `src/**`) 범위에만 파일을 쓴다. `protectedPaths`(fixtures·contracts·lock·`mvnw*`·`.mvn/**`)는 건드리지 않는다.
     3. `outDir`에서 `./mvnw -q -DskipTests package`로 컴파일을 확인하고 오류를 고친다(JDK 17 이상, 첫 실행은 Maven 다운로드로 오래 걸린다).
     4. `finalize_generation` → `verify_mock`. 실패하면 소스를 고치고 `finalize_generation` → `verify_mock`을 다시 한다. `reason: "stale-request"`면 선택이 바뀐 것이므로 `generate_mock`부터 다시.
   - 사용자가 "화면으로 고르고 싶다"고 하면 `open_ui`를 불러 URL을 알려 주고 열어 달라고 안내한다. 화면에서 끝낸 뒤 돌아오면 `list_features`로 선택 상태를 다시 읽는다.
   - 사용자가 "실제 응답으로 바꾸고 싶다" · "실제 시스템과 비교해 달라"고 하면 `record_responses`. `target.json`이 없다는 오류면 예시를 보여 주고 사용자에게 만들어 달라고 한다(비밀 값은 `${환경변수}`로만). `driftSummary`를 보여 주고 다름·불일치가 있으면 스펙과 실제 중 어느 쪽이 맞는지 묻는다.
5. 도구가 `isError`로 답하면 메시지의 다음 단계 안내(예: "먼저 `analyze_spec`")를 따른다. 사용자 입력 오류(잘못된 표현식, 없는 id)는 사용자에게 다시 묻는다.

안전 규칙:

- `generate_mock`이 "specmock이 만든 디렉터리가 아닙니다"로 실패하면, `force: true`로 다시 부르기 **전에** 사용자에게 대상 경로와 덮어쓸 내용(`package.json`·`src` 등이 교체되고 `routes`·`contracts`가 정리된다)을 알리고 확인받는다. 확인 없이 `force: true`를 쓰지 않는다.
- `generate_mock`이 "이 디렉터리는 …로 생성됐습니다"로 실패하면 언어를 바꾸려는 것이다(ts→java, java→ts 모두). `force: true`는 이전 언어의 소스·빌드 산출물을 지운다고(fixtures의 수정은 보존, contracts는 다시 생성) 알리고 확인받은 뒤에만 쓴다. 아니면 `outDir`을 다른 곳으로 준다.
- `outDir`은 사용자가 위치를 지정했을 때만 준다. 아니면 생략해 기본 `mock/<system>`을 쓴다.
- `submit_extraction`의 `ok: false`는 실패가 아니라 고쳐서 다시 내라는 뜻이다. `errors`를 읽고 같은 청크를 고쳐 제출한다.
- `record_responses`의 `allowMutating: true`는 실제 시스템에 생성·삭제 요청을 보낸다. 대상 `baseUrl`과 건너뛴 기능(`skipped`)을 알리고 확인받은 뒤에만 쓴다. `target.json` 헤더의 `${ENV}`는 Claude Code를 실행한 셸에 있어야 한다. 없다는 오류면 그 셸에서 변수를 설정하고 Claude Code를 다시 띄우라고 안내한다. 사용자에게 키 값을 대화에 붙여 넣으라고 하지 않는다.

추출 규칙(근거 인용은 원문 그대로, 청크에 없는 엔드포인트를 보태지 않음)은 CLI 흐름과 같다. [extraction.md](references/extraction.md).

## 0. 준비

- CLI 확인: `specmock --version`. 없으면 저장소 루트에서 `pnpm specmock`으로 대신 실행한다(이 저장소 안일 때). 둘 다 안 되면 사용자에게 설치를 안내하고 멈춘다.
- 옵션이 헷갈리면 `specmock <명령> --help`가 기준이다.
- 시스템 이름을 정한다(예: `stripe`, `partner-api`). 사용자가 말하지 않았으면 입력 파일명에서 짧게 만든다.
- 종료 코드: `0` 성공, `1` 오류(메시지를 그대로 전달), `2`는 명령마다 뜻이 다르다(아래 각 단계).

## 1. ingest — 스펙 읽기

```bash
specmock ingest <system> <파일|URL>... [--harvest auto|always|never] [--refresh] [--json]
```

- 웹 문서에서 탭·셀렉트박스·접힘 영역 같은 상호작용 요소가 감지되면(기본 `auto`) ego-browser로 **자동 수확**한다. ego-browser에 로그인된 상태로 페이지를 열고, 결과는 비밀값을 마스킹한 뒤 저장한다. 같은 문서 안의 참조 링크도 따라가지만 bare `/api/` 경로 링크는 따라가지 않는다.
- 커스텀 드롭다운(listbox/combobox)은 자동 수확하지 않는다. 필요하면 [수동 수확](references/manual-harvest.md).
- 출력(stderr)에 "ego-browser가 없어 수확을 건너뜀"이나 "수확 실패"가 보이면(같은 내용이 `source.json`의 `harvested.notes`에도 기록된다) 사용자에게 알리고, 필요하면 [수동 수확](references/manual-harvest.md)으로 보충한다.
- 같은 URL을 다시 읽을 때는 캐시가 쓰인다. 문서가 바뀌었다고 하면 `--refresh`.

## 2. analyze — 기능 카탈로그

```bash
specmock analyze <system>
```

**OpenAPI만 있으면** 바로 표가 나온다. 3단계로 간다.

**문서(HTML/Markdown/PDF/텍스트)가 있으면** "LLM 추출 준비 완료"가 나오고 `analyze-request.json`, `chunks/NNN.md`, 빈 `extracted/` 디렉터리가 생긴다. 이때 추출은 **당신(Claude)이 직접** 한다(세션 모드, 기본값). 절차는 [extraction.md](references/extraction.md). 요약:

1. `.specmock/<system>/analyze-request.json`의 `prompt`와 `schema`를 읽는다.
2. 청크 파일을 **하나씩** 읽고, `prompt`의 규칙대로 `schema`에 맞는 JSON을 `.specmock/<system>/extracted/NNN.json`에 `{"endpoints": [...]}` 형태로 쓴다. 근거 인용은 원문 그대로 복사한다. 엔드포인트가 없으면 `{"endpoints": []}`. `extracted/manifest.json`은 CLI가 관리하므로 건드리지 않는다.
3. 모든 청크가 끝나면 `specmock analyze <system> --merge`.

청크가 20개를 넘으면 사용자에게 수를 알리고, 로컬 CLI 자동 추출(`specmock analyze <system> --llm claude-code [--model sonnet|opus]`)을 쓸지 묻는다. **구독으로 청크당 `claude` 호출이 1회씩 나간다**는 점을 함께 알린다. 이미 있는 추출을 버리고 다시 하려면 `--refresh`(세션 모드에서는 prepare 전에 `extracted/`의 기존 결과를 모두 지운다).

**`analyze` 종료 코드 2** = 일부 청크 추출 실패(주로 `--llm claude-code` 자동 추출 중). merge는 진행되어 카탈로그는 만들어졌다. 사용자에게 "N개 청크 추출 실패, 해당 청크의 기능은 목록에 빠졌다"고 알리고, 같은 명령을 다시 실행하면 실패/미추출 청크만 다시 추출한다고 안내한다(재시도할지 묻는다). 1은 오류이므로 메시지를 전달하고 멈춘다.

## 3. 기능 목록 보여주기와 선택 받기

`analyze`(또는 `specmock list <system>`)의 표를 그대로 보여준다. 함께 설명할 것:

- `출처` 열: `spec`은 확실, `doc`은 문서에서 추출(신뢰도 참고), `inf`는 method/path를 추측한 것.
- `샘플` 열: `●`은 실제 응답 예시가 있어 mock 응답이 진짜와 비슷하다. `○`은 스키마로 임의 생성. `—`는 빈 객체.
- `⚠` 표시 행은 `specmock show <system> <id>`로 근거와 주의를 보여주고 포함 여부를 사용자에게 묻는다.
- `catalog.json`의 `rejected`가 비어 있지 않으면 "추출했지만 버린 항목 N개"와 이유를 요약한다.

사용자에게 **어떤 기능이 필요한지** 묻는다. 번호(`1,3-5`), id(`getPet`), id 글롭(`users.*`), `group:<그룹>`, `method:GET`, `has:example`, `confidence>=0.8`, `all`, `-제외`, `@selection.json`을 받을 수 있다. 사용자가 "다 해줘"라고 해도 `inf`와 신뢰도 0.5 미만 행은 포함할지 한 번 확인한다.

## 4. select → generate → verify

```bash
specmock select <system> <표현식>...
specmock generate <system>          # ./mock/<system>/
specmock generate <system> --lang java --llm claude-code [--model sonnet] [--max-attempts 3]   # Java: 생성·빌드·검증 통과분만 반영. 실패하면 종료 코드 5
specmock generate <system> --lang java --llm session    # 지시서만 쓴다. 대화에서 pom.xml·src/** 작성 후
specmock generate <system> --finalize                    # 확정 → specmock verify <system>
specmock verify <system>            # mock 기동 → contract test → coverage.md
specmock record <system> [--allow-mutating] [--feature <id>] [--refresh] [--no-apply] [--json]   # 실제 시스템 녹화 → drift.md, 종료 코드 2 = drift
```

verify 결과(`contract: 통과 N / 실패 M`)와 `coverage.md` 상단 요약(fixture 출처 비율, 가정 목록)을 보여준다.

**`verify` 종료 코드 2** = contract 또는 런타임 계약(선택 안 한 경로 501·모르는 경로 404) 실패. `run`의 종료 코드 2는 contract 실패 **또는** 일부 청크 추출 실패. 실패한 contract의 오류를 옮겨 적고, 보통 원인(문서 샘플이 스키마와 불일치 등)과 함께 사용자에게 알린다. mock 자체는 생성되어 있다. 고치는 방법은 `mock/<system>/fixtures/<id>/<status>.json` 편집이다. 종료 코드 1은 오류(예: mock 기동 실패)이므로 메시지를 전달한다. `generate`의 종료 코드 5는 LLM 생성이 시도 횟수 안에 검증을 통과하지 못한 것이다. 출력의 `.specmock-attempt/errors.md` 요약을 알리고 다시 시도할지 묻는다.

한 번에 돌리고 싶다는 요청이면 `specmock run <system> <origins...> [--select <expr>] [--llm claude-code]`가 ingest → verify까지 이어서 실행한다. 문서 입력에는 `--llm claude-code`가 필요하고(세션 모드는 `run`에서 지원하지 않는다) 구독 호출이 나가므로, 기능 선택을 보여주는 단계별 진행을 우선 권한다. Java는 `specmock run <system> <origins...> --lang java --llm claude-code`. 스킬 환경에서는 MCP `generate_mock(language)`의 세션 모드를 우선한다.

## 5. 마무리와 추가

- 실행법: generate 출력의 `실행:` 줄을 그대로 보여 준다. TS는 `cd mock/<system> && npm install && npm start`, Java는 `cd mock/<system> && ./mvnw -q -DskipTests package && java -jar target/mock.jar` (기본 포트 4010).
- 나중에 기능 추가: `specmock select <system> --add <id> && specmock generate <system>`. 선택하지 않은 경로를 호출하면 mock이 501과 함께 이 명령을 알려준다.
- 스펙이 바뀌면 `ingest --refresh` → `analyze <system> --refresh`(세션 모드면 기존 추출 결과를 지우고 시작) → 다시 추출 → `--merge`. 출력의 "이전 카탈로그 대비" 줄을 사용자에게 보여준다.

## 하지 말 것

- 카탈로그 표를 건너뛰고 바로 생성하지 않는다. 선택은 사용자의 것이다.
- 추출할 때 청크에 없는 엔드포인트를 상식으로 보태지 않는다. 없으면 빈 배열.
- `extracted/NNN.json`을 손으로 "정리"하지 않는다. merge가 검증한다. `extracted/manifest.json`은 편집 금지.
- 사용자 동의 없이 `--llm claude-code`(구독 호출)를 쓰지 않는다.
- MCP 도구가 있는데 셸로 `specmock` CLI를 돌리지 않는다. 도구 흐름에서 `extracted/` 파일을 직접 쓰지 않는다(`submit_extraction`이 검증과 manifest를 맡는다).
