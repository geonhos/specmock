# record Web UI 설계 — 화면 ⑥ 녹화, target 편집, 기능별 값, 환경 변수 입력

작성: 2026-11-25. 바탕: Stripe 실사용 점검 §4 27~29·32행(`docs/superpowers/notes/real-use-check-stripe.md`), 사전 조사 `.harness/record-ui-detail.md`(HEAD 92f41d5 기준).

## 1. 문제

Stripe 실사용 점검의 record 단계에서 사용자는 세 가지를 손으로 반복해야 했습니다.

| 번호 | 걸린 지점 | 원인 |
|---|---|---|
| 1 | 터미널에서 `export STRIPE_TEST_KEY=…`를 매번 실행 | ui-server의 record가 서버 프로세스의 `process.env`만 봅니다(`ui-server/src/app.ts:157-159`). 서버를 띄운 뒤 셸에서 export한 값은 반영되지 않습니다 |
| 2 | `target.json`을 직접 작성·편집 | Web에는 target 읽기 API(`GET /target`, baseUrl만)와 실행 버튼만 있고 쓰기 API가 없습니다. 3B 설계가 "Web에서 target 편집 없음"으로 정했습니다(3B 설계 :33, :42) |
| 3 | 고객 id와 결제 id를 한 번에 줄 수 없어 `--feature`로 3회 나눠 실행 | `target.params`가 전역 평면 맵입니다(`core/src/record/target.ts:25-30`, 3B 설계 :90) |
| 4 | 샘플 id 요청의 404가 "상태 불일치"로만 보임 | `statusHint`가 경로 변수에 샘플 값이 쓰였다는 사실을 알리지 않습니다(`core/src/record/drift.ts:17`) |

이 설계는 네 가지를 Web UI에서 해결합니다. CLI와 MCP는 바뀌지 않고, 파일에 추가되는 `features` 값을 자동으로 적용받습니다.

## 2. 결정

사용자와 2026-11-25에 하나씩 확인한 결정입니다.

| 결정 | 선택 | 버린 선택지 |
|---|---|---|
| API 키 전달 | **(가) 화면 입력 → ui-server 메모리.** `target.json`에는 `${ENV}` 참조만 둡니다. 화면에서 입력한 값은 서버 메모리에만 있고 서버가 꺼지면 사라집니다. 서버 프로세스 env에 이미 있으면 "설정됨"으로 표시합니다 | (나) 서버 env만 쓰고 미설정 경고만 표시, (다) 맥 키체인 연동 |
| target 편집 범위 | **(A) 구조화된 폼 전체.** baseUrl, 헤더, 공통 값, 기능별 값, 제한 시간 | (B) baseUrl과 기능별 값만, (C) JSON 원문 편집 |
| 화면 위치 | **(ㄱ) 새 단계 ⑥ 녹화.** 단계 막대 ①~⑥, 사이드바 점 6개, 경로 `/systems/:s/record` | (ㄴ) ⑤ 검증 화면 확장, (ㄷ) 단계가 아닌 별도 화면 |
| 3B 설계와의 관계 | 3B 설계의 세 결정(:33 "Web은 실행 버튼과 결과 보기만", :42 "Web에서 target.json 편집"은 비목표, :90 params 전역 적용)을 이 문서가 대체합니다. 3B 설계 문서에 §개정 절을 더합니다 | — |

바뀌지 않는 원칙: `${ENV}`에서 온 값은 녹화 파일·drift·이벤트·응답·로그 어디에도 원문으로 남지 않습니다(`***`). 기본은 GET·HEAD만 보내고, 변경 요청은 사용자가 명시적으로 켜야 보냅니다.

## 3. target.json 확장 — 기능별 값 `features`

### 3.1 형식

```json
{
  "baseUrl": "https://api.stripe.com",
  "headers": { "Authorization": "Bearer ${STRIPE_TEST_KEY}" },
  "params": { "query": "created>1000000000" },
  "features": {
    "customers.get": { "id": "cus_…" },
    "payment_intents.get": { "id": "pi_…" },
    "amount_details_line_items.list": { "id": "pi_…" }
  },
  "timeoutMs": 20000
}
```

- `features`는 선택 필드입니다. 키는 기능 id, 값은 이름 → 문자열 맵입니다. 스키마: `features?: z.record(z.string(), z.record(z.string(), z.string()))`.
- `TargetSchema`는 `strictObject`를 유지합니다. `features`를 모르는 옛 버전은 이 파일을 형식 오류로 거부합니다. README에 한 줄로 알립니다.
- `features`의 값에도 `${ENV}` 치환과 secrets 수집(`substituteCollect`)을 적용합니다. 치환된 값은 다른 값과 같은 규칙으로 `***`가 됩니다.

### 3.2 적용 규칙

`applyParams(feature, contract, params)`는 그대로 두고, 호출부(`record/index.ts:119`)가 넘기는 맵을 바꿉니다.

```ts
const merged = { ...target.params, ...(target.features[feature.id] ?? {}) };
```

기능별 값이 공통 값보다 우선합니다. 경로 변수·query 적용 방식(`fillPath`, 선언된 query 이름만 덮어쓰기)은 바뀌지 않습니다.

### 3.3 404 안내 문구

`statusHint`가 404일 때 요청 경로의 변수가 샘플 값으로 채워졌는지 구분합니다. 판정: 기능의 경로에 `{이름}` 변수가 있고, 그 이름이 `merged`에 없을 때.

| 경우 | 문구 |
|---|---|
| 샘플 값으로 채운 변수가 있음 | `경로 변수 {id}에 샘플 값이 쓰였습니다. 기능별 값(features)에 실제 id를 넣으세요` |
| 변수가 없거나 모두 지정됨 | 기존 문구(`target.json`의 `params`로 실제 값을 지정하세요)를 `기능별 값 또는 params를 확인하세요`로 |

`TARGET_EXAMPLE`에 `features` 예시 두 줄을 더합니다. 이 예시는 CLI 오류 메시지, `GET /target`, Web 화면에 같이 실립니다.

## 4. ui-server API

### 4.1 환경 변수 입력 — `POST /api/systems/:s/env`

요청 `{ "values": { "STRIPE_TEST_KEY": "sk_test_…" } }`. 서버는 시스템별 메모리 맵 `envStore: Map<system, Record<string,string>>`에 저장합니다. 응답 `{ "ok": true, "data": { "names": ["STRIPE_TEST_KEY"] } }`. 값은 응답·로그·이벤트에 싣지 않습니다.

- 빈 문자열 값은 "삭제"로 처리합니다.
- record 실행 때 `recordResponses(ws, system, { env: { ...process.env, ...envStore.get(system) } })`로 넘깁니다. 기존 `env` 인자를 그대로 씁니다(`service/record.ts:27-28`).
- `security.ts`의 `POST_ONLY` 정규식에 `/env`를 더합니다.
- 제한: 값 길이 4096자, 이름은 `[A-Za-z_][A-Za-z0-9_]*`. 어기면 400 `invalid`.

### 4.2 target 읽기 — `GET /api/systems/:s/target` 확장

응답 형식(`TargetInfo`):

```ts
{
  exists: boolean;
  example: string;             // TARGET_EXAMPLE (기존)
  error?: string;              // 파일이 있지만 형식 오류 (기존)
  target?: {
    baseUrl: string;
    timeoutMs: number;
    headers: { name: string; value: string; literal: boolean }[];
    params:  { name: string; value: string; literal: boolean }[];
    features: Record<string, { name: string; value: string; literal: boolean }[]>;
  };
  env?: { name: string; status: "process" | "session" | "missing" }[];
}
```

- 값이 `${이름}` 참조만으로 이루어졌으면 `literal: false`이고 원문을 그대로 싣습니다. 그 밖의 값(직접 적은 값, 참조와 문자가 섞인 값)은 `literal: true`이고 `value`는 `"***"`입니다. 서버는 파일의 직접 적은 값을 응답에 싣지 않습니다.
- `env`는 헤더·params·features 값에서 뽑은 `${이름}` 전체입니다. `status`는 `session`(4.1로 입력됨) > `process`(서버 env에 있음) > `missing` 순으로 정합니다. 실제 값도 화면 입력이 서버 env보다 우선하므로 표시와 일치합니다.
- 기존 테스트 `api.test.ts:347`(headers·params를 싣지 않음)은 "직접 적은 값은 `***`"로 바꿉니다.

### 4.3 target 쓰기 — `PUT /api/systems/:s/target`

요청:

```ts
{
  baseUrl: string;
  timeoutMs?: number;
  headers:  { name: string; value?: string; keep?: true }[];
  params:   { name: string; value?: string; keep?: true }[];
  features: Record<string, { name: string; value?: string; keep?: true }[]>;
}
```

- `keep: true`인 항목은 서버가 기존 파일의 같은 이름 값을 그대로 둡니다. 기존 파일에 그 이름이 없으면 400 `invalid`.
- 서버는 받은 내용을 `TargetSchema`로 검증한 뒤 `ws.write`로 `target.json`을 씁니다(기존 파일 쓰기 규칙: 임시 파일 후 교체). 빈 `features` 항목(값이 없는 기능)은 쓰지 않습니다.
- 응답은 4.2와 같은 `TargetInfo`입니다.
- 이 엔드포인트도 `POST_ONLY`에 넣습니다(PUT도 허용하도록 `methodGuard`를 GET·HEAD·POST·PUT으로 넓힙니다).

### 4.4 녹화 요청 확장 — `POST /api/systems/:s/record`

`RecordBody`에 `features?: string[]`과 `apply?: boolean`(기본 true)을 더합니다. 그대로 `recordResponses`에 넘깁니다. 모르는 기능 id는 코어가 던지는 오류를 400 `invalid`로 돌려줍니다(`toApiError` 패턴 추가: `알 수 없는 기능 id`).

### 4.5 마지막 결과 — `GET /api/systems/:s/record/last`

```ts
{
  exists: boolean;
  driftMarkdown?: string;      // drift.md 원문
  recordedAt?: string;         // drift.md 1행의 시각
  recorded: { featureId: string; status: number; at: string }[];  // recorded/*.json에서 상태·시각만
}
```

응답 본문(녹화된 바디)은 싣지 않습니다. `recorded/*.json`의 `RecordedSchema`에 상태 코드와 시각이 있으면 그것을 쓰고, 없으면 파일 mtime을 씁니다.

### 4.6 단계 플래그

`SystemSummary.steps`에 `record: boolean`을, `stale`에 `record`를 더합니다. 판정(`systems.ts:15-27` 규칙과 같은 방식): `drift.md`가 있으면 완료, `mockspec.json`의 mtime이 `drift.md`보다 새로우면 "다시 실행 필요".

## 5. Web 화면 ⑥ 녹화

### 5.1 경로와 단계

- `route.ts`: `Screen`에 `"record"`, `parseRoute`에 `/systems/:s/record`, `STEP_SCREENS`에 6번째.
- `StepBar.tsx`: `LABELS`에 "⑥ 녹화", `STALE_KEY`·`reachable`에 `record`. 녹화는 생성(④) 완료 뒤 도달할 수 있습니다(검증 완료는 조건이 아닙니다).
- `Sidebar.tsx`: 단계 점 6개. `nextScreen`은 바뀌지 않습니다(녹화는 선택 단계이므로 "다음 할 일"로 안내하지 않습니다).
- `App.tsx`: `TITLES`에 "실제 서버와 대조", 렌더 분기.
- ⑤ 검증 화면의 `RecordCard`는 "실제 서버와 대조하려면 ⑥ 녹화로" 링크 한 줄로 바꿉니다. `RecordCard.tsx`는 삭제하고 그 역할은 새 화면이 맡습니다.

### 5.2 구성

가운데 카드 하나, 위에서 아래로 세 구역입니다. 기존 토큰·클래스 체계(`app.css`)를 쓰고 새 라이브러리는 넣지 않습니다.

**구역 A — 대상 서버 설정**(`<details>`로 접힘; `exists: false`이면 펼친 채 시작)

| 항목 | 입력 | 비고 |
|---|---|---|
| 주소 | `baseUrl` 텍스트 | 비면 저장 불가 |
| 제한 시간 | 초 단위 숫자(파일에는 ms) | 기본 15 |
| 헤더 표 | 이름·값·삭제 버튼, "+ 헤더" | 값이 `${이름}`이면 옆에 "환경 변수" 표시. 그 밖의 값은 저장 전에 안내 `이 값은 파일에 그대로 남습니다. ${이름} 참조를 권합니다`(저장은 허용). `literal: true`로 읽힌 값은 `***`로 보이고 "그대로 유지"(기본) 또는 "지우기"만 가능 |
| 공통 값 표 | 이름·값·삭제, "+ 값" | query 등 모든 기능에 적용 |
| 환경 변수 표 | 이름·상태·비밀번호형 입력·"이번 세션에 사용" 버튼 | 이름은 위 값들에서 자동 추출. 상태 문구: 설정됨(서버) / 설정됨(화면 입력) / 미설정. 안내 한 줄: `입력한 값은 이 서버의 메모리에만 있고 파일·기록에 남지 않습니다. 서버를 다시 켜면 다시 입력합니다` |
| 저장 | 버튼 → `PUT /target` | 성공하면 구역 B의 표가 새 값으로 갱신 |

**구역 B — 기능 표와 실행**

| 열 | 내용 |
|---|---|
| 선택 | 체크박스. 기본: 읽기 요청(GET·HEAD) 전부 선택, 변경 요청은 해제되고 흐림. "변경 요청 포함"을 켜면 선택 가능(켤 때 기존 카드와 같은 확인 창) |
| 기능 | 기능 id와 설명 |
| 요청 | 메서드 칩 + 경로(`{id}`는 기존 `.var` 표시) |
| 필요한 값 | 경로 변수마다 입력란. 입력한 값은 `features.<id>.<이름>`으로 저장(구역 A의 저장과 같은 `PUT`). 변수가 없으면 "—" |
| 지난 결과 | 4.5와 마지막 job 결과로 채움: 일치 / 스펙과 다름 / 상태 불일치(기대 X, 실제 Y) / 건너뜀(변경 요청) / 실패 / 미녹화. 다름·실패 행은 펼치면 이유 목록(⑤ 검증 표와 같은 방식) |

하단 버튼 줄: "선택한 N개 녹화"(`POST /record` `{features, allowMutating, apply}`), "mock에 반영" 체크(기본 켬), 실행 중엔 진행 바(`done/total`)와 "취소". 버튼이 막히는 조건과 이유(`aria-describedby`): 설정 없음 → "먼저 대상 서버 설정을 저장하세요"; 미설정 환경 변수 → "환경 변수 N개가 미설정입니다"; 선택 0개; 저장하지 않은 변경 있음 → "설정을 먼저 저장하세요".

**구역 C — 결과**

- 요약 줄(`요청 N · 일치 · 스펙과 다름 · 상태 불일치 · 건너뜀 · 실패`), 반영 줄(`select n개 · generate 파일 n개`), notes.
- `drift.md` 원문은 `<details>` "자세히" 안의 `pre.drift`.
- 화면을 열 때 `GET /record/last`로 채우고, `job-done`이 오면 job 결과로 바꿉니다.

### 5.3 Stripe 흐름

화면 열기 → 환경 변수 표에 `STRIPE_TEST_KEY 미설정` → 값 입력·"이번 세션에 사용" → `customers.get` 행에 `cus_…`, `payment_intents.get`·`amount_details_line_items.list` 행에 `pi_…` → 저장 → "선택한 7개 녹화" → 표에 일치 7. 터미널·파일 편집 0회.

## 6. 바뀌지 않는 것

- CLI `record` 명령과 옵션, MCP `record_responses` 입력. 둘 다 파일의 `features`를 자동 적용합니다.
- 코어 `record()`·`recordResponses()` 시그니처. 마스킹 규칙(출처 기반 + 이름·패턴 기반).
- 기본 GET·HEAD만 전송. 404·400 응답은 fixture로 쓰지 않음.
- 서버 바인드 `127.0.0.1`, `localOnly` Host·Origin 검사.

## 7. 테스트

모두 LLM 호출과 실제 외부 요청 없이 돕니다.

| 층 | 확인 항목 |
|---|---|
| core `record/target` | `features` 파싱, 기능별 > 공통 우선, `features` 값의 `${ENV}` 치환과 secrets 수집, 모르는 키 거부, `TARGET_EXAMPLE`이 스키마를 통과 |
| core `record/drift` | 404 안내 두 경우 문구 |
| core `record/index` | 기능별 값으로 경로가 채워지는 요청 1건(가짜 fetch) |
| ui-server `api.test.ts` | `GET /target`: 참조 그대로·직접 값 `***`·env 상태 3종 / `PUT /target`: 파일 생성, `keep`이 기존 값 유지, 없는 이름 `keep` 400, 형식 오류 400 / `POST /env` 뒤 녹화 성공, 응답·drift·recorded·이벤트 전체에 값 없음 / `POST /record` `features`·`apply:false`(generate 미실행) / `GET /record/last` / `steps.record`·`stale.record` / `PUT` 허용·`/env` GET 405 |
| web | 화면 ⑥: 설정 없음이면 구역 A 펼침과 녹화 버튼 막힘 이유 / 저장 본문(헤더·공통 값·`features`·`keep`) / 환경 변수 미설정 → 막힘, "이번 세션에 사용" → `POST /env` 본문과 상태 갱신 / 기본 선택(읽기만)과 변경 요청 포함 확인 창 / 녹화 본문 `{features, allowMutating, apply}` / `job-done` 뒤 표·요약 갱신 / `GET /record/last`로 초기 채움. `route`·`App`·`StepBar` 테스트에 6단계. `Verify.test`의 RecordCard 부분은 링크 확인으로 교체 |
| e2e `ui.spec.ts` | 시나리오 1개 추가: petstore + 가짜 실제 서버(`node:http`) → ⑥에서 환경 변수 입력·id 입력·녹화 → "일치" 표시 |

## 8. 문서

- README "실제 시스템 녹화" 절: `features` 형식, 옛 버전 비호환 한 줄, Web 화면 ⑥ 설명, 환경 변수 입력의 수명(서버 메모리).
- `packages/plugin/.../SKILL.md`, MCP `record_responses` 설명: `features`는 파일에서 자동 적용.
- `docs/architecture.md`: 화면 6개, 엔드포인트 추가.
- 3B 설계 문서 끝에 `## 개정(2026-11-25)` 절: 바뀐 세 결정과 이 문서 링크.

## 9. 작업 나눔

| PR | 범위 | 끝나면 확인 |
|---|---|---|
| 1 | core(§3) + ui-server(§4) + 문서 중 README·MCP·3B 개정 | `pnpm typecheck && pnpm test` 통과. Stripe `target.json`에 `features`를 넣고 CLI `record` 1회(사용자 실행, 선택) |
| 2 | web(§5) + e2e + architecture.md | `pnpm test`와 `pnpm test:e2e` 통과. 브라우저에서 Stripe 2·3단계(§5.3) 실행 |

각 PR은 리뷰를 거쳐 머지합니다. 두 PR 뒤 Stripe 녹화 결과를 notes §3·§4에 기록합니다.

## 10. 범위 밖

- 키체인·OS 자격 증명 저장소 연동.
- 기능당 여러 응답(파라미터별 녹화), 4xx 응답의 fixture 사용(3B 비목표 유지).
- 녹화 응답 본문의 개인정보 가림(§4 30행)은 별도 설계.
- 원격 접속·인증(2B 비목표 유지).
- 경로 변수 값 `..` 정규화는 기존 동작을 유지합니다.

## 11. 구현 중 변경

구현하면서 이 문서와 달라진 점을 여기에 적습니다.

- `InvalidBodyError`는 없어 기존 `InvalidRequest`(400)를 씁니다. `Workspace`에 `readJson`·`list`가 없어 `node:fs/promises`로 읽습니다.
- `PUT /target`은 `ws.write` 앞에서 `TargetSchema.safeParse`로 검증하고 `InvalidRequest`로 던집니다(`ws.write`의 오류는 500이 되기 때문).
- 모르는 기능 id는 작업 시작 전에 `mockspec.json`과 비교해 400으로 막습니다(작업 안에서 나는 오류는 400으로 매핑되지 않기 때문). `features`가 비어 있으면 검사하지 않습니다.
- `GET /target`은 화면 호환을 위해 최상위 `baseUrl`도 함께 돌려줍니다(web PR 2에서 제거 검토).
- apply가 `mockspec.json`을 `drift.md` 뒤에 다시 쓰므로, core `recordResponses`가 select가 돈 뒤 `drift.md` 시각을 현재로 맞춥니다(CLI·MCP·ui-server 공통). `stale.record`는 밀리초 단위로 비교합니다. 그렇지 않으면 방금 녹화가 낡은 것으로 보입니다.
- 커밋은 Task 3~5를 하나로 묶었습니다(`app.ts` 변경이 서로 얽혀 있어서).
- env 상태 표시 순서를 `session > process > missing`으로 바꿨습니다(§4.2). 실제 값이 `EnvStore.env`에서 화면 입력을 우선하기 때문입니다.
- `PUT /target`은 헤더 이름을 HTTP token 문자로, 값 이름을 `^[A-Za-z_][A-Za-z0-9_-]*$`로 제한하고, `features` 키가 `mockspec.json`의 기능 id에 없으면 400으로 막습니다(`mockspec.json`이 없으면 대조하지 않음).
- 화면 컴포넌트 이름은 `RecordScreen`입니다. `Record`로 두면 TypeScript의 `Record<K, V>`를 가립니다.
- 서버가 `features` id를 mockspec(선택한 기능) 기준으로 대조하므로, 화면은 저장 본문에서 현재 기능 표에 없는 id를 뺍니다. 뺀 항목이 있으면 폼 아래에 "선택하지 않은 기능의 값 N개는 저장에서 제외됩니다"를 보입니다.
- 기능 표는 `GET /features` 행을 `selection.resolved`로 걸러 만듭니다. 기본 선택은 GET·HEAD입니다.
- `Bearer ${TOKEN}`처럼 참조가 섞인 값은 서버가 `literal:true`(`***`)로 돌려줍니다. 폼은 값에 참조가 있으면 "환경 변수" 표시를 붙이고, 기본은 "그대로 유지"입니다.
- 결과는 job 결과가 없으면 `GET /record/last`의 `drift.md`와 `recorded/`로 복원합니다. 복원한 결과에서는 기록이 있는 기능만 일치 등으로 보이고, 나머지는 미녹화입니다.
- ⑤ 검증의 `RecordCard`는 ⑥으로 가는 링크 한 줄로 바꾸고 파일을 지웠습니다. `GET /target`의 최상위 `baseUrl`은 호환용으로 남겨 둡니다(쓰는 곳은 없습니다).
- "변경 요청 포함"을 켜도 변경 요청 행이 자동으로 선택되지는 않습니다. 사용자가 행마다 직접 고릅니다.
