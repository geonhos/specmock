# 실사용 점검 기록: Stripe

시작일: 2026-11-11
상태: 1차(Customers) 실행 완료
목적: Petstore(교과서 스펙)가 아닌 **실제 문서 사이트 하나**를 실제 사용자처럼 처음부터 끝까지 써 보며 걸리는 지점을 개선 과제로 쌓고, 그 과정의 **비용(토큰 · 시간)** 을 근거 자료로 남긴다. 이 repo는 작성자의 AI 활용 이력이기도 하다(설계 §1.4).

## 0. 대상과 범위

- 사이트: Stripe API 문서 `https://docs.stripe.com/api`. 공식 OpenAPI `github.com/stripe/openapi`(`spec3.json`)는 2차 정답지.
- 1차 범위: **Customers + PaymentIntents** 두 리소스(URL 23개: Customers 8, PaymentIntents 15, 각 리소스 색인 페이지 포함). 전 단계(ingest → analyze → select → generate TS·Java → verify → record)를 끝까지 통과시킨 뒤 범위를 넓힌다.
- 입력 순서: A. 웹 문서 URL(LLM 추출) 먼저 → B. OpenAPI로 대조.
- record는 Stripe **테스트 모드 키**(`sk_test_…`)로, 기본 GET만. 키는 `target.json`의 `${STRIPE_TEST_KEY}`로만 넣는다.

## 1. 사전 조사 요약 (2026-11-11, 상세 `.harness/stripe-survey.md`)

- Stripe는 specmock의 Accept 헤더(`text/markdown`이 `text/html`보다 앞)를 보고 **Markdown 본문**을 준다. 따라서 Readability · 수확(ego-browser)은 돌지 않고 `--harvest`는 효과가 없다. robots.txt는 수집 허용.
- 실측: 23개 URL ingest **10초**, `source.json` 213KB, `analyze --prepare` 1초 → **54청크**(Customers 12 / PaymentIntents 42).
- 엔드포인트 페이지에는 `POST /v1/...`가 없고 curl 예시만 있다. 메서드 · 경로 명시는 리소스 색인 페이지(`/api/customers`, `/api/payment_intents`)에만 있으므로 색인 페이지를 반드시 함께 넣는다.
- `ingest`는 넘긴 origin만으로 `source.json`을 덮어쓴다. 2차 실행은 23개 전부를 **Customers 8개를 같은 순서로 앞에 두고** 다시 넣어야 이미 추출한 청크가 재사용된다(순서가 바뀌면 재추출되어 토큰이 이중 계상).
- LLM 사용량 측정: `ClaudeCodeAdapter`가 `claude --print` 응답 봉투의 `usage` · `total_cost_usd` · `duration_ms`를 버리고 `--no-session-persistence`라 사후 복구도 불가 → **점검 시작 전에 기록 기능을 먼저 넣는다**(결정 2026-11-11, 설계 `docs/superpowers/specs/2026-11-11-llm-usage-log-design.md`).

예상 걸림돌(순위): ① 메서드 · 경로 추론과 색인 · 본문 중복 merge ② Stripe POST는 form-encoded인데 생성 mock은 JSON만 파싱 ③ PaymentIntents 부피(42청크) ④ 하위 속성이 `?query=` 링크 뒤에만 있어 중첩 스키마가 얕음 ⑤ `:id` vs `{{CUSTOMER_ID}}` 표기, `Stripe-Version` 헤더, 링크 추종 규칙이 `docs.` 호스트 + `/api/` 경로를 따라가지 않는 잠재 결함.

## 2. 측정 방법

두 층을 따로 적는다.

| 층 | 무엇 | 어디서 얻나 |
|---|---|---|
| 제품(specmock) | specmock이 `claude`를 부른 호출마다 입력 · 출력 · 캐시 토큰, API 환산 비용, 소요 시간, 단계(analyze 청크 / generate Java 시도 n) | `.specmock/<system>/llm-usage.jsonl` + `analyze` · `generate`가 끝에 stderr로 내는 합계 한 줄(`--json`은 `usage` 필드). 구현 완료 |
| 개발(harness) | 이 점검으로 생긴 개선 작업에 쓴 analyst · implementer · reviewer 비용 · 시간 | `harness metrics --json --since 2026-11-11`(비용 · 시간), `.harness/log/*.jsonl` result 줄(토큰) |

벽시계 시간은 각 명령의 시작 · 종료를 기록한다. 세션 모드 · MCP 경로의 토큰은 사용자 세션이 쓰므로 "미측정"으로 적는다. 비용은 `costBasis: list`의 **API 정가 환산**이며 구독 사용 시 실제 청구액이 아니다.

## 3. 실행 기록

| # | 일시 | 단계 · 명령 | 소요 | 토큰(입력/출력/캐시) | API 환산 비용 | 결과 | 비고 |
|---|---|---|---|---|---|---|---|
| 0 | 2026-11-11 | 사전 조사(analyst 1회) | 444s | 개발 층 | $2.57 | 완료 | ingest 23 URL 10s · prepare 54청크. LLM 호출 없음 |
| 1 | 2026-11-11 14:16 | `ingest stripe` Customers 8 URL | 2s | LLM 없음 | - | 종료 0 | 8개 모두 markdown 수신(1,121~7,770자). stderr는 URL별 크기 줄뿐 |
| 2 | 2026-11-11 14:16~14:19 | `analyze stripe --llm claude-code --json` | 162s(합계 줄 2분 41초) | 입력 24 / 출력 15,714 / 캐시 읽기 153,186 / 캐시 생성 121,475 | $2.60 (API 환산, 구독 간주) | 종료 0 | 12청크 12호출, 실패 0, 기능 7개, rejected 0. 합계 줄 원문: `LLM 호출 12회(실패 0) · 입력 24 · 출력 15,714 · 캐시 읽기 153,186 · API 환산 $2.60 (API 키 미감지 → 구독으로 간주, 실제 청구 아님) · 2분 41초`. `llm-usage.jsonl` 12줄, 합계는 `usage`와 일치(durationMs 161,353, apiDurationMs 139,912) |
| 3 | 2026-11-11 14:19 | `list stripe` · `show stripe customers.create` | 1s 미만 | LLM 없음 | - | 종료 0 | 기능 7개(Customers 6개 기대 대비 아래 §4 4~7행). create의 요청 body 22개 속성·인증·샘플 모두 정확 |
| 4 | 2026-11-11 14:19 | `select stripe` 6개 id(create·get·create3·delete·list·search.list) | 0s | LLM 없음 | - | 종료 0 | update는 id가 `customers.create3`로 나와 이것을 골랐고 중복인 `create2`는 제외 |
| 5 | 2026-11-11 14:19 | `generate stripe --lang ts` | 1s | LLM 없음 | - | 종료 0 | 21개 파일. `src/routes/`에 `Customers.ts` 하나만 생성됨(§4 4행) |
| 6 | 2026-11-11 14:19 | `verify stripe` (npm install 포함) | 2s(설치 별도) | LLM 없음 | - | 종료 2 | contract 통과 2 / 실패 4 / 전체 6. get·list·search.list는 404, create3은 501. 원인은 §4 4행 |
| 7 | 2026-11-11 14:19 | 생성 mock 기동 후 `curl` | 수 초 | LLM 없음 | - | 확인 | `GET /v1/customers` → 404 `unknown_path`(§4 4행). `POST /v1/customers -d "name=x"` → 400 `validation_failed`(body 필수). 같은 요청을 `-H content-type: application/json -d '{"name":"x"}'`로 보내면 200과 샘플 고객 객체(§4 8행) |
| 8 | 2026-11-11 15:00 | 수정 후 재실행(`fix/catalog-merge-naming`): `analyze stripe --llm claude-code --json`(extracted 그대로) → `list` → `select stripe all` → `generate --lang ts --force` → `verify` → `curl` | analyze 15s(병합만) | LLM 호출 0회(청크 12개 모두 skipped, `usage: null`, `llm-usage.jsonl` 12줄 그대로) | $0 | 종료 0 | 기능 7→6개(create · get · update · delete · list · search.list, group `Customers` 하나). generate 20개 파일(21→20: `Customers.ts`·`customers.ts` 충돌 해소), verify 통과 6/6 종료 0. `GET /v1/customers` 200, `GET /v1/customers/cus_123` 200, `POST /v1/customers/cus_123` JSON body 200. 프롬프트 변경은 manifest가 청크 내용 해시만 쓰므로 재추출 없음 |

## 4. 걸린 지점 (증상 → 원인 → 개선안 → 크기)

| # | 단계 | 증상 | 원인 | 개선안 | 크기 | 상태 |
|---|---|---|---|---|---|---|
| 1 | 전체 | LLM 호출의 토큰 · 비용 · 시간이 어디에도 남지 않음 | `ClaudeCodeAdapter`가 응답 봉투의 `usage` 등을 버림 | `llm-usage.jsonl` 기록 + CLI 합계(설계 2026-11-11) | 소(6~7파일) | 완료(PR #10) |
| 2 | ingest | Markdown으로 응답하는 사이트에서 `--harvest always`를 줘도 조용히 수확하지 않음 | 수확 조건이 `kind === "html"` | 안내 메시지("Markdown 응답이라 수확 생략") 또는 문서화 | 소 | 기록 |
| 3 | ingest(수확) | 링크 추종이 `docs.stripe.com/api/...`를 따라가지 않음 | `referenceLinks`가 경로만 검사, bare `/api/` 제외 | `docs.`/`developer.` 호스트 또는 시작 URL과 같은 경로 접두사면 허용 | 소 | 기록(현재 피해 없음) |
| 4 | generate | 같은 리소스가 group 철자만 달라(`Customers` / `customers`) 두 그룹이 되고, macOS(대소문자 비구분 파일시스템)에서 `src/routes/Customers.ts`와 `customers.ts`가 같은 파일이 되어 나중에 쓴 쪽이 앞쪽을 덮어씀. 결과: 6개 중 list · search · get · update 라우트가 사라지고 verify 4건 실패, `server.ts`는 같은 파일을 두 번 import | 원인 두 겹. (a) 청크마다 LLM이 group을 `Customers` 또는 `customers`로 다르게 적음(`analyze/prompt.ts:15`는 "리소스 이름"만 지시), 병합이 group을 정규화하지 않음. (b) `generate/tsHono.ts:10` `safeName`과 `NameRegistry.claim`(`tsHono.ts:22`)이 대소문자를 구분해 `Customers`와 `customers`를 서로 다른 이름으로 배정, 파일 쓰기 때 충돌 미검사(추정: Linux에서는 두 파일이 따로 생겨 증상이 없음) | (a) 병합 단계에서 group을 대소문자 무시로 묶어 대표 철자 하나로 통일. (b) `NameRegistry`가 소문자 기준으로 중복 판정. (b)만 고쳐도 파일 덮어쓰기는 막힌다 | 소 | 수정(PR 대기) |
| 5 | analyze(merge) | 같은 `Update a customer`가 두 기능으로 나뉨: `customers.create2`(경로 `{CUSTOMER_ID}`, body 3개 속성)와 `customers.create3`(경로 `{id}`, body 19개). 카탈로그 7개 중 1개가 중복 | 청크 7은 문서 curl 예시의 `{{CUSTOMER_ID}}`를 그대로 경로 변수로 썼고 청크 0 · 8은 `{id}`. 병합이 `method + 경로`로 묶을 때 변수 이름이 다르면 다른 경로로 봄(추정, `merge.ts` bucket 키 확인 필요) | 병합 키에서 경로 변수 이름을 지우고(`/v1/customers/{}`) 묶기, 또는 프롬프트에 "경로 변수는 `{id}` 꼴 소문자" 규칙 | 중 | 수정(PR 대기) |
| 6 | analyze(featureId) | POST update의 기능 id가 `customers.create2` · `customers.create3`: 이름만 봐서는 수정인지 알 수 없고 번호는 충돌 회피용 접미사 | `analyze/featureId.ts:49` `case "POST": return "create"`가 경로 끝이 변수인 POST도 create로 만듦. 문서에는 operationId가 없음 | 경로 끝이 변수인 POST는 `update`로 파생(Stripe식 관례), 또는 LLM이 준 title에서 동사 파생 | 소 | 수정(PR 대기) |
| 7 | analyze | 메서드 · 경로 오추론은 없었으나 `customers.list` · `customers.get` · 중복 update는 신뢰도 0.5 · `method 추론됨` 표시. 색인 페이지(청크 0)만 메서드를 명시해 본문 청크 3개는 추론에 의존 | 설계대로(엔드포인트 페이지에 `POST /v1/...` 없음, curl 예시만 있음). 본문 청크의 `curl -G`는 GET으로 정확히 추론됨 | 청크 병합 시 색인 청크가 같은 경로를 명시하면 신뢰도를 올리는 규칙 검토 | 중 | 기록 |
| 8 | generate(런타임) | Stripe POST는 form-encoded인데 생성 mock이 JSON만 파싱: `curl -d "name=x"`는 400 `must have required property 'body'`, JSON으로 보내야 200 | `mock/stripe/src/routes/Customers.ts:13` `c.req.json().catch(() => undefined)`; 스키마에 `required:["body"]` | `content-type`이 `application/x-www-form-urlencoded`면 `c.req.parseBody()`로 읽어 같은 검증에 통과시킴. 카탈로그에 요청 content-type 기록 필요 | 중 | 기록 |
| 9 | analyze | 중첩 객체가 얕음: `address`·`shipping`·`invoice_settings` 등이 `{"type":"object"}`뿐이고 `customers.get` 응답의 `address: {}`. update(create3) 응답 스키마는 `{"type":"object"}`에 예시 없음(출처 schema-generated) | 하위 속성이 `?query=` 링크 뒤에만 있음(사전 조사 ④), 청크 8은 응답 본문이 없는 청크로 추정 | 하위 속성 링크 추종 또는 OpenAPI(`spec3.json`) 대조(2차) | 대 | 기록 |
| 10 | verify | verify는 실패 원인을 "404"로만 보임: 라우트가 통째로 사라진 것인지 경로 불일치인지 구분 안 됨. 종료 코드 2 | `verify`가 계약 실패를 상태 코드만 기록 | 404의 응답 본문(`unknown_path`)과 생성된 라우트 목록 대조를 coverage.md에 추가 | 소 | 기록 |

## 5. 개선 과제 (우선순위)

(§4에서 묶음)

## 6. 비용 합계

| 구분 | 토큰 합계 | API 환산 비용 | 시간 합계 |
|---|---|---|---|
| 제품(specmock LLM 호출) | 1차 analyze 12호출: 입력 24 / 출력 15,714 / 캐시 읽기 153,186 / 캐시 생성 121,475 | $2.60 (API 환산, 구독 간주) | 2분 41초 |
| 개발(harness 워커) | | $2.95 (조사 $2.57 + 정리 $0.38) | |
