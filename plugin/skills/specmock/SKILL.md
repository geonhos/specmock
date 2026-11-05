---
name: specmock
description: Use when the user wants a mock server for an external API from a spec, docs URL, PDF or Markdown — "이 API mock 만들어줘", "스펙 분석해서 필요한 것만", "연동 테스트용 가짜 서버". Walks ingest → analyze → feature list → user selection → generate → verify with the specmock CLI, doing the LLM extraction in-session for unstructured docs.
---

# specmock

스펙에서 **기능 목록을 먼저 보여주고, 사용자가 고른 것만** mock으로 만든다. 모든 상태는 `.specmock/<system>/` 파일이다. 아래 단계를 순서대로 밟고, 각 단계의 출력을 요약해 보여준다.

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
- 출력에 "ego-browser 미설치"나 "수확 실패"가 보이면 사용자에게 알리고, 필요하면 [수동 수확](references/manual-harvest.md)으로 보충한다.
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

청크가 20개를 넘으면 사용자에게 수를 알리고, 로컬 CLI 자동 추출(`specmock analyze <system> --llm claude-code [--model sonnet|opus]`)을 쓸지 묻는다. **구독으로 청크당 `claude` 호출이 1회씩 나간다**는 점을 함께 알린다. 이미 있는 추출을 버리고 다시 하려면 `--refresh`.

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
specmock verify <system>            # mock 기동 → contract test → coverage.md
```

verify 결과(`contract: 통과 N / 실패 M`)와 `coverage.md` 상단 요약(fixture 출처 비율, 가정 목록)을 보여준다.

**`verify` 종료 코드 2** = contract 실패(`run`도 같다). 실패한 contract의 오류를 옮겨 적고, 보통 원인(문서 샘플이 스키마와 불일치 등)과 함께 사용자에게 알린다. mock 자체는 생성되어 있다. 고치는 방법은 `mock/<system>/fixtures/<id>/<status>.json` 편집이다. 종료 코드 1은 오류(예: mock 기동 실패)이므로 메시지를 전달한다.

한 번에 돌리고 싶다는 요청이면 `specmock run <system> <origins...> [--select <expr>] [--llm claude-code]`가 ingest → verify까지 이어서 실행한다. 문서 입력에는 `--llm claude-code`가 필요하고(세션 모드는 `run`에서 지원하지 않는다) 구독 호출이 나가므로, 기능 선택을 보여주는 단계별 진행을 우선 권한다.

## 5. 마무리와 추가

- 실행법: `cd mock/<system> && npm install && npm start` (기본 포트 4010).
- 나중에 기능 추가: `specmock select <system> --add <id> && specmock generate <system>`. 선택하지 않은 경로를 호출하면 mock이 501과 함께 이 명령을 알려준다.
- 스펙이 바뀌면 `ingest --refresh` → `analyze`. 출력의 "이전 카탈로그 대비" 줄을 사용자에게 보여준다.

## 하지 말 것

- 카탈로그 표를 건너뛰고 바로 생성하지 않는다. 선택은 사용자의 것이다.
- 추출할 때 청크에 없는 엔드포인트를 상식으로 보태지 않는다. 없으면 빈 배열.
- `extracted/NNN.json`을 손으로 "정리"하지 않는다. merge가 검증한다. `extracted/manifest.json`은 편집 금지.
- 사용자 동의 없이 `--llm claude-code`(구독 호출)를 쓰지 않는다.
