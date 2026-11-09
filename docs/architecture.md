# specmock 아키텍처 한눈에 보기

> 상세 설계는 [설계 문서](superpowers/specs/2026-11-04-specmock-design.md)를 참고. 이 문서는 그림으로 전체를 파악하기 위한 요약이다.

## 무엇을 하는가

어떤 형태의 API 스펙이든 읽어서 언어 무관한 **MockSpec**으로 정규화하고, 그중 **필요한 기능만 골라** mock 서버와 검증 테스트를 생성한다.

```mermaid
flowchart LR
    IN["스펙<br/>(OpenAPI · 웹 문서 · PDF)"] --> CAT["기능 카탈로그<br/>(출처 · 신뢰도 · 샘플)"]
    CAT --> SEL{"필요한 기능<br/>선택"}
    SEL --> MS["MockSpec<br/>(언어 무관)"]
    MS --> GEN["mock 서버<br/>(TS · Hono / Java · Javalin)"]
    MS --> CT["contract test"]
    CT -.검증.-> GEN
    GEN --> REP["커버리지 리포트"]
```

## 레이어 구조

```mermaid
flowchart TB
    subgraph 인터페이스["인터페이스 (얇음)"]
        CLI[CLI]
        SKILL[Claude Code 스킬]
        MCP["MCP 서버 (2A)"]
        WEB["Web UI (2B)"]
    end

    subgraph CORE["core (두꺼움 · 결정적 · 테스트됨)"]
        direction LR
        ING[ingest] --> ANA[analyze] --> SELM[select] --> GENM[generate] --> VER[verify]
        HARV[harvest<br/>ego-browser 스크립트] -.-> ING
    end

    subgraph GENL["generate의 언어 생성기 (3A)"]
        direction LR
        TSG["TsHonoGenerator<br/>(템플릿)"]
        LLMG["LlmGenerator<br/>(언어 프로필 + 검증 루프)"]
        PROF["프로필 등록표<br/>java: Maven + Javalin"]
        LLMG --- PROF
    end

    subgraph LLM["LLM 어댑터 (교체 가능)"]
        A1["세션 자신<br/>(스킬 모드)"]
        A2["claude --print<br/>(CLI · Web · 코드 생성도)"]
        A3["API 키<br/>(3단계)"]
    end

    CLI & SKILL & MCP & WEB --> CORE
    ANA -.비구조 문서.-> LLM
    GENM --> GENL
    LLMG -.코드 작성.-> LLM
```

**원칙**: LLM은 "비구조 문서에서 기능 추출"과 "다른 언어 생성"에만 쓴다. 나머지는 전부 결정적 코드다.

2A부터 CLI와 MCP 서버는 같은 **서비스 층**(`packages/core/src/service/`)을 호출한다. 흐름 조립과 판정은 서비스 층 한 곳에 있고, 인터페이스는 옵션 파싱과 출력만 맡는다.

3A부터 `generate`는 언어와 무관한 부분(fixtures·contracts·lock·보존 판정, `scaffold`)과 언어 종속 부분(`LanguageGenerator`)으로 나뉜다. `LanguageGenerator`는 `LanguageOutput`(파일·install·start·sourceGlobs)을 돌려주고, verify는 lock의 install·start만 보고 기동한다. TS는 `TsHonoGenerator`(템플릿), 그 밖의 언어는 `LlmGenerator`가 언어 프로필(`core/src/generate/profiles/`)과 TS 참조 구현을 프롬프트로 claude에 보내고, 임시 디렉터리에서 빌드·contract·런타임 계약(501·404)을 통과한 결과만 반영한다. 왜: 새 언어마다 템플릿을 손으로 쓰는 대신 검증된 MockSpec과 같은 verify로 정확성을 보장한다. 지원 언어 목록은 `SUPPORTED_LANGUAGES`이고 입력 단계(CLI·MCP·Web)에서 `assertLanguage`로 검사한다. MCP 도구는 12개(`finalize_generation` 추가).

```mermaid
flowchart LR
    CLI["packages/cli"] --> SVC["core/src/service<br/>ingestSpec · analyzeSpec · summarizeChunks/getChunk<br/>listFeatures/findFeature · verifyMock · runPipeline"]
    MCP["packages/mcp<br/>stdio · 도구 11개"] --> SVC
    CLI --> UIS["packages/ui-server<br/>Hono · HTTP/SSE · 작업 관리 · 파일 감시"]
    MCP --> UIS
    UIS --> SVC
    UIS -. 실행 중 읽기 .-> WEBD["packages/web/dist<br/>(React 화면 빌드)"]
    WEB["packages/web<br/>React + Vite"] -. 타입만 .-> UIS
    WEB -. 빌드 .-> WEBD
    SVC --> CORE["core 단계 함수<br/>ingest · prepare · submitExtraction · merge · select · generate · verify"]
    PLUGIN["plugin.json mcpServers"] -. node 실행 .-> MCP
```

`specmock ui`(CLI)와 `open_ui`(MCP)가 같은 `ui-server`를 띄운다. 화면 서버는 `core` 서비스 층을 그대로 호출하므로 화면에서 한 일은 CLI·대화와 같은 `.specmock/` 파일로 남는다.

### 화면의 데이터 흐름

```mermaid
sequenceDiagram
    participant B as 브라우저(web)
    participant S as ui-server
    participant C as core 서비스 층
    participant F as .specmock/ (파일 잠금)
    B->>S: HTTP 요청 (등록 · 선택 · 생성 · 검증 · 추출)
    S->>C: 서비스 함수 호출 (오래 걸리면 작업으로 등록)
    C->>F: 시스템별 잠금을 잡고 읽기·쓰기
    S-->>B: 작업 진행·완료 (SSE job 이벤트)
    F-->>S: 파일 변경 감시 (fs.watch, 시스템별 디바운스)
    S-->>B: workspace-changed (SSE)
    Note over B,F: MCP·CLI가 같은 파일을 바꿔도 화면이 다시 읽는다
```

화면 서버는 127.0.0.1에만 열리고(Host·Origin 검사), 시스템당 한 번에 하나의 작업만 받는다. 서버가 끝나면 진행 중인 작업을 취소하고 자식 프로세스를 정리한다. MCP 안에서 띄운 화면 서버도 stdio가 닫히면 함께 끝난다.

## 상태 파일 (파일이 인터페이스)

모든 단계는 `.specmock/<system>/` 아래 파일로 이어진다. 어떤 인터페이스로 시작하든 같은 파일을 쓰고, 중간에 멈췄다 이어갈 수 있다.

```mermaid
flowchart LR
    S[source.json<br/>정규화된 원문] --> C[catalog.json<br/>모든 기능 + 출처·신뢰도]
    C --> SL[selection.json<br/>사용자 선택]
    SL --> M[mockspec.json<br/>선택된 기능 + fixture + contract]
    M --> MOCK["mock/&lt;system&gt;/<br/>서버 코드 · fixtures · contracts"]
    MOCK --> COV[coverage.md<br/>믿을 수 있는 범위]
    T[target.json<br/>실제 시스템] --> REC[record]
    M --> REC
    REC --> RD[recorded/ · drift.md]
    RD -.->|fixture 출처 recorded| SL
```

| 파일 | 만드는 단계 | 쓰는 단계 | 핵심 내용 |
|---|---|---|---|
| `source.json` | ingest | analyze | 원문 보존. HTML 본문(Markdown으로 변환), PDF 텍스트(페이지 헤딩), dereference된 OpenAPI, 수확 결과(`harvested`, `notes`) |
| `analyze-request.json` | analyze (prepare) | LLM 어댑터 / 세션의 Claude | 프롬프트, 출력 JSON 스키마, 청크 목록(해시 포함). 추출 작업 지시서 |
| `chunks/NNN.md` | analyze (prepare) | LLM 어댑터 / 세션의 Claude | 헤딩 기준 청크(최대 6,000자, 겹침 200자). 호출 수 = 청크 수 |
| `extracted/NNN.json` | LLM 어댑터 / 세션의 Claude | analyze (merge) | 청크별 추출 결과. 재현의 기준이라 남겨 둔다 |
| `extracted/manifest.json` | analyze (extract) | analyze (extract) | 청크 번호별 추출 당시 본문 해시. 본문이 바뀐 청크만 다시 추출 |
| `catalog.json` | analyze | list / select | 모든 기능. `provenance`, `confidence`, `hasExample`, `evidence`, `notes` |
| `catalog-diff.json` | analyze | select | 이전 카탈로그와 id 기준으로 비교한 추가·삭제 목록(내용 변경은 감지하지 않음) |
| `selection.json` | select | select / generate | 선택 표현식, 해석 결과, 선택 시점의 `catalogIds`. 재현과 추가 선택의 기준 |
| `mockspec.json` | select | generate / verify | 선택된 기능 + fixtures + contracts + assumptions. **단일 진실** |
| `coverage.md` | verify | 사용자 | fixture 출처 비율, 신뢰도 분포, 가정 목록, contract 결과 |
| `target.json` | 사용자 | record | 실제 시스템 `baseUrl`·`headers`(`${ENV}`만)·`params`·`timeoutMs`. 커밋 금지 |
| `recorded/<기능>.json` | record | select | 실제 응답(상태·헤더·본문, 비밀 마스킹)과 `mockspecHash` |
| `drift.md` | record | 사용자 | 스펙과 다름·상태 불일치·건너뜀·실패 |

## 입력별 처리 경로

```mermaid
flowchart TD
    U[입력] --> K{형식?}
    K -->|OpenAPI| P1["swagger-parser<br/>$ref 해석"] --> D1["결정적 변환<br/>confidence 1.0"]
    K -->|웹 URL| F["fetch + 본문 추출"] --> Q{"본문 빈약 or<br/>select/탭/details 감지?"}
    Q -->|예| H["ego-browser 수확<br/>아코디언 펼치기 · 탭 순회 · select 옵션 순회"] --> CH
    Q -->|아니오| CH["청크 분할"]
    K -->|Markdown / PDF / 텍스트| CH
    CH --> L["LLM 추출<br/>(청크별 · JSON 스키마 고정)"] --> MRG["merge<br/>스키마 검증 · 근거 대조 · 병합"]
    D1 & MRG --> CAT[catalog.json]
```

수확은 ego-browser가 있을 때만 일어난다. 없으면 건너뛰고 `source.json`의 `harvested.notes`와 stderr에 기록한다. 수확은 ego-browser의 로그인 상태로 페이지를 열고, 결과는 비밀값을 마스킹한 뒤 저장한다. 같은 출처의 docs/reference 류 링크만 깊이 2, 50페이지까지 따라가며 bare `/api/` 경로는 따라가지 않는다. 커스텀 드롭다운은 자동 수확하지 않고 스킬의 수동 절차로 넘긴다.

## LLM 추출 3단계

비구조 문서의 `analyze`는 세 단계로 나뉜다. 가운데 단계만 어댑터에 따라 다르고, 나머지는 결정적 코드다. 단계 사이의 모든 산출물이 파일이라 어느 단계에서든 멈췄다 이어갈 수 있다.

```mermaid
sequenceDiagram
    participant CLI as specmock analyze
    participant WS as .specmock/SYSTEM/
    participant AD as 어댑터
    Note over CLI,WS: 1. prepare (결정적)
    CLI->>WS: source.json 읽기
    CLI->>WS: chunks/000.md … , analyze-request.json 쓰기
    Note over CLI,AD: 2. 추출 (어댑터마다 다름)
    alt --llm claude-code
        loop 청크마다 (이미 있고 낡지 않았으면 건너뜀)
            CLI->>AD: claude --print --json-schema (빈 임시 cwd)
            AD-->>CLI: structured_output
            CLI->>WS: extracted/NNN.json, manifest.json
        end
    else --llm session (스킬 모드)
        CLI-->>AD: analyze-request.json 위치를 안내하고 멈춤
        AD->>WS: 세션의 Claude가 chunks/NNN.md를 읽고 extracted/NNN.json 작성
    end
    Note over CLI,WS: 3. merge (결정적, --merge로 단독 실행 가능)
    CLI->>WS: extracted/*.json 읽기
    CLI->>CLI: 스키마 검증 → 근거 대조 → confidence 보정 → method+path 병합
    CLI->>WS: catalog.json, catalog-diff.json 쓰기
```

- 일부 청크가 실패하면 나머지로 `catalog.json`을 만들고 종료 코드 2를 돌려준다. 같은 명령을 다시 실행하면 실패한 청크만 재시도한다.
- `--prepare`는 1단계에서 멈추고, `--merge`는 3단계만 실행한다. `--refresh`는 기존 `extracted/`를 무시(claude-code)하거나 지운다(session).

### MCP로 추출할 때

```mermaid
sequenceDiagram
    participant C as Claude
    participant M as MCP 서버
    C->>M: analyze_spec
    M-->>C: prompt · schema · chunks[index, heading, chars, contentHash, done]
    loop done=false 인 청크
        C->>M: get_chunk(i)
        C->>M: submit_extraction(i, contentHash, result)
        M-->>C: ok / ok=false(errors)
    end
    C->>M: merge_extractions
```

`submit_extraction`은 다음 순서로 처리한다.
1. 해시로 청크가 지금 문서와 같은지 확인한다.
2. 모르는 키까지 거부하는 엄격 검증을 한다.
3. 원자적으로 쓴다.
4. manifest에 해시를 남긴다.

`--llm claude-code` 자동 추출도 청크마다 같은 함수를 쓴다(모르는 키는 버리는 관대한 모드).

## 기능 선택 흐름

```mermaid
sequenceDiagram
    participant U as 사용자
    participant T as 도구
    T-->>U: 기능 목록 (그룹별 · 출처 · 신뢰도 · 샘플 배지)
    U->>T: 선택 표현식 (all / 번호 / users.* / confidence>=0.8 / -제외)
    T-->>U: 해석 결과 N개 확인
    T->>T: selection.json 저장, mockspec.json 생성
    Note over U,T: 나중에 기능이 더 필요하면
    U->>T: select --add "payments.*"
    T->>T: 추가 라우트만 생성, 기존 fixture 보존
```

선택되지 않은 경로로 요청이 오면 mock은 `501 not_mocked`와 함께 "이 기능을 추가하려면 `specmock select <system> --add <id>`" 안내를 돌려준다.

## 로드맵

```mermaid
gantt
    dateFormat  X
    axisFormat  %s
    section 1단계
    core · CLI · Claude Code 스킬        :done, a1, 0, 3
    section 2단계
    MCP 서버(2A) · Web UI(2B)            :done, a2, after a1, 2
    section 3단계
    다른 언어 생성(3A, Java)             :done, a3, after a2, 1
    녹화(record, 3B)                     :done, a4, after a3, 1
    API 키                               :a5, after a4, 1
```

| 단계 | 완료 기준 |
|---|---|
| 1 | OpenAPI와 웹 문서에서 TS mock 생성, contract test 통과, coverage.md 출력, 기능 추가 재생성 |
| 2 | 2A: MCP로 Claude Code에서 도구 호출(셸 없이 끝까지). 2B: 브라우저 화면에서 같은 흐름 |
| 3 | 3A(완료): 검증된 MockSpec으로 Java mock을 LLM이 생성하고 같은 verify 통과. 3B(완료): `record`가 실제 시스템 응답을 녹화해 fixture로 반영, drift.md. 이후: API 키 어댑터 |
