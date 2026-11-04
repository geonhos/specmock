# specmock 아키텍처 한눈에 보기

> 상세 설계는 [설계 문서](superpowers/specs/2026-11-04-specmock-design.md)를 참고. 이 문서는 그림으로 전체를 파악하기 위한 요약이다.

## 무엇을 하는가

어떤 형태의 API 스펙이든 읽어서 언어 무관한 **MockSpec**으로 정규화하고, 그중 **필요한 기능만 골라** mock 서버와 검증 테스트를 생성한다.

```mermaid
flowchart LR
    IN["스펙<br/>(OpenAPI · 웹 문서 · PDF)"] --> CAT["기능 카탈로그<br/>(출처 · 신뢰도 · 샘플)"]
    CAT --> SEL{"필요한 기능<br/>선택"}
    SEL --> MS["MockSpec<br/>(언어 무관)"]
    MS --> GEN["mock 서버<br/>(TS · Hono)"]
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
        MCP["MCP 서버 (2단계)"]
        WEB["Web UI (2단계)"]
    end

    subgraph CORE["core (두꺼움 · 결정적 · 테스트됨)"]
        direction LR
        ING[ingest] --> ANA[analyze] --> SELM[select] --> GENM[generate] --> VER[verify]
        HARV[harvest<br/>ego-browser 스크립트] -.-> ING
    end

    subgraph LLM["LLM 어댑터 (교체 가능)"]
        A1["세션 자신<br/>(스킬 모드)"]
        A2["claude --print<br/>(CLI · Web)"]
        A3["API 키<br/>(3단계)"]
    end

    CLI & SKILL & MCP & WEB --> CORE
    ANA -.비구조 문서.-> LLM
```

**원칙**: LLM은 "비구조 문서에서 기능 추출"과 "다른 언어 생성"에만 쓴다. 나머지는 전부 결정적 코드다.

## 상태 파일 (파일이 인터페이스)

모든 단계는 `.specmock/<system>/` 아래 파일로 이어진다. 어떤 인터페이스로 시작하든 같은 파일을 쓰고, 중간에 멈췄다 이어갈 수 있다.

```mermaid
flowchart LR
    S[source.json<br/>정규화된 원문] --> C[catalog.json<br/>모든 기능 + 출처·신뢰도]
    C --> SL[selection.json<br/>사용자 선택]
    SL --> M[mockspec.json<br/>선택된 기능 + fixture + contract]
    M --> MOCK["mock/&lt;system&gt;/<br/>서버 코드 · fixtures · contracts"]
    MOCK --> COV[coverage.md<br/>믿을 수 있는 범위]
```

| 파일 | 만드는 단계 | 쓰는 단계 | 핵심 내용 |
|---|---|---|---|
| `source.json` | ingest | analyze | 원문 보존. HTML 본문, PDF 텍스트, dereference된 OpenAPI, 수확 결과 |
| `catalog.json` | analyze | list / select | 모든 기능. `provenance`, `confidence`, `hasExample`, `evidence`, `notes` |
| `selection.json` | select | select / generate | 선택 표현식과 해석 결과. 재현과 추가 선택의 기준 |
| `mockspec.json` | select | generate / verify | 선택된 기능 + fixtures + contracts + assumptions. **단일 진실** |
| `coverage.md` | verify | 사용자 | fixture 출처 비율, 신뢰도 분포, 가정 목록, contract 결과 |

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
    core · CLI · Claude Code 스킬        :a1, 0, 3
    section 2단계
    MCP 서버 · Web UI                    :a2, after a1, 2
    section 3단계
    다른 언어 생성 · Proxy/녹화 · API 키 :a3, after a2, 2
```

| 단계 | 완료 기준 |
|---|---|
| 1 | OpenAPI와 웹 문서에서 TS mock 생성, contract test 통과, coverage.md 출력, 기능 추가 재생성 |
| 2 | 브라우저 화면에서 같은 흐름. MCP로 Claude Code에서 도구 호출 |
| 3 | 검증된 MockSpec으로 임의 언어 생성. 키 있으면 실제 시스템 전달·녹화 |
