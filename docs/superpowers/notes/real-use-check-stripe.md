# 실사용 점검 기록: Stripe

시작일: 2026-11-11
상태: 2차(PaymentIntents 포함) 실행 완료
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
| 9 | 2026-11-11 15:20 | 2차 `ingest stripe` Customers 8 + PaymentIntents 15 = 23 URL(Customers 앞, 1차 순서) | 7s | LLM 없음 | - | 종료 0 | Customers 8개 `(캐시)`, PaymentIntents 15개 markdown 수신(2,181~35,622자). 시작 전 상태: `llm-usage.jsonl` 12줄, `extracted/` 12청크 + manifest |
| 10 | 2026-11-11 15:20 | `analyze stripe --llm claude-code --json --prepare` | 1s | LLM 없음 | - | 종료 0 | 청크 54개(기대 일치). `extracted/` 13개 파일 그대로 |
| 11 | 2026-11-11 15:20~15:28 | `analyze stripe --llm claude-code --json` | 457s(합계 줄 7분 34초) | 입력 84 / 출력 34,302 / 캐시 읽기 557,040 / 캐시 생성 423,072 | $8.25 (API 환산, 구독 간주) | 종료 0 | 추출 written 42 / skipped 12 / 실패 0, 기능 7→18(추가 12, 삭제 0, 변경 0), rejected 0. **Customers 12청크 재사용, 호출 42회(기대 일치)**. 합계 줄 원문: `LLM 호출 42회(실패 0) · 입력 84 · 출력 34,302 · 캐시 읽기 557,040 · API 환산 $8.25 (API 키 미감지 → 구독으로 간주, 실제 청구 아님) · 7분 34초`. `llm-usage.jsonl` 12 → 54줄, 신규 42줄 합계가 `usage`와 일치(durationMs 454,111). 청크당 평균: 1차 12청크 $0.217 · 13.4초 · 출력 1,310 토큰, 2차 42청크 $0.196 · 10.8초 · 출력 817 토큰(PaymentIntents 본문이 길어도 출력은 적음: 청크 대부분이 엔드포인트 하나의 파라미터 표) |
| 12 | 2026-11-11 15:28 | `list stripe` · `show stripe payment_intents.create` | 1s 미만 | LLM 없음 | - | 종료 0 | 기능 18개(Customers 6 + PaymentIntents 12). 기대 PaymentIntents 12개 중 12개 모두 존재, 메서드 · 경로 정확 12/12, 중복 · 누락 0, 오추론 0. 문제는 이름 · group · 경로 변수 표기(§4 12~15행). `payment_intents.create` 요청 body 속성 4개(amount · currency · automatic_payment_methods · confirm), 중첩 깊이 2(`automatic_payment_methods.enabled`), required 없음. 응답 스키마 속성 38개 · 깊이 3 · doc-sample 있음 |
| 13 | 2026-11-11 15:28 | `select stripe all` → `generate stripe --lang ts --force` → `verify stripe` | 각 1s 이내 | LLM 없음 | - | 모두 종료 0 | 선택 18개, 47개 파일(`src/routes/`: `Customers.ts` · `PaymentIntent.ts` · `PaymentIntent_LineItems.ts` · `PaymentIntents.ts`), verify 통과 18 / 실패 0. coverage.md: 출처 doc-sample 18, confidence 1.0이 8개 · 0.5가 10개, assumptions 없음 |
| 14 | 2026-11-11 15:29 | 생성 mock 기동 후 `curl` | 수 초 | LLM 없음 | - | 확인 | `GET /v1/payment_intents` 200 · `GET /v1/payment_intents/pi_123` 200 · `POST /v1/payment_intents`(JSON `{"amount":1000,"currency":"usd"}`) 200 · `POST …/pi_123/confirm` JSON `{}` 200 · **body 없는 `POST …/pi_123/confirm` 400 `must have required property 'body'`**(`…/cancel`도 동일) · form-encoded `POST /v1/payment_intents -d amount=1000&currency=usd` 400(§4 8행, 2차에서도 확인) |
| 15 | 2026-11-11 16:40 | 수정 후 재확인(`fix/catalog-quality`): `analyze stripe --merge`(병합만) → `list stripe` | 수 초 | LLM 호출 0회(`llm-usage.jsonl` 54줄 그대로) | $0 | 종료 0 | 기능 18개 그대로, group 4종(`Customers` · `PaymentIntent` · `PaymentIntents` · `PaymentIntent LineItems`) → 3종(`Customers` 6 · `Payment Intents` 11 · `PaymentIntent LineItems` 1, 하위 리소스는 별도 유지). id: 하위 동작 8개가 `payment_intents.cancel` · `capture` · `confirm` · `increment_authorization` · `apply_customer_balance` · `verify_microdeposits`, `customers.search` · `payment_intents.search`로 바뀌고 `search.list2` 소멸. 경로 변수는 `/v1/payment_intents/{id}…`로 전부 통일. 이전 카탈로그 대비 추가 8 · 삭제 8 · 변경 6 |
| 16 | 2026-11-11 16:41 | body 속성 수 확인(`show` 또는 catalog.json) | 1s 미만 | LLM 없음 | - | 확인 | body 속성(before → after): `payment_intents.create` 4 → 15, `confirm` 2 → 8, `customers.update` 3 → 19, `capture` 10, `increment_authorization` 9(required `amount`), `payment_intents.update` 1. create의 required는 원문이 optional이라 비어 있음 |
| 17 | 2026-11-11 16:42 | `select stripe all` → `generate stripe --lang ts --force` → `verify stripe` | 각 1s 이내 | LLM 없음 | - | 모두 종료 0 | 선택 18개(옛 id 8개 사라짐 경고, 예상대로), 46개 파일(`src/routes/`: `Customers.ts` · `Payment_Intents.ts` · `PaymentIntent_LineItems.ts` 3개, 이전 4개), verify 통과 18 / 실패 0 |
| 18 | 2026-11-11 16:43 | 생성 mock 기동 후 `curl` | 수 초 | LLM 없음 | - | 확인 | body 없는 `POST /v1/payment_intents/pi_123/confirm` 200 · `…/cancel` 200 · `GET /v1/payment_intents` 200 · form-encoded `POST /v1/payment_intents -d amount=1` 200(body가 선택이라 통과, §4 8행의 content-type 지원은 아직 아님) |

## 4. 걸린 지점 (증상 → 원인 → 개선안 → 크기)

| # | 단계 | 증상 | 원인 | 개선안 | 크기 | 상태 |
|---|---|---|---|---|---|---|
| 1 | 전체 | LLM 호출의 토큰 · 비용 · 시간이 어디에도 남지 않음 | `ClaudeCodeAdapter`가 응답 봉투의 `usage` 등을 버림 | `llm-usage.jsonl` 기록 + CLI 합계(설계 2026-11-11) | 소(6~7파일) | 완료(PR #10) |
| 2 | ingest | Markdown으로 응답하는 사이트에서 `--harvest always`를 줘도 조용히 수확하지 않음 | 수확 조건이 `kind === "html"` | 안내 메시지("Markdown 응답이라 수확 생략") 또는 문서화 | 소 | 기록 |
| 3 | ingest(수확) | 링크 추종이 `docs.stripe.com/api/...`를 따라가지 않음 | `referenceLinks`가 경로만 검사, bare `/api/` 제외 | `docs.`/`developer.` 호스트 또는 시작 URL과 같은 경로 접두사면 허용 | 소 | 기록(현재 피해 없음) |
| 4 | generate | 같은 리소스가 group 철자만 달라(`Customers` / `customers`) 두 그룹이 되고, macOS(대소문자 비구분 파일시스템)에서 `src/routes/Customers.ts`와 `customers.ts`가 같은 파일이 되어 나중에 쓴 쪽이 앞쪽을 덮어씀. 결과: 6개 중 list · search · get · update 라우트가 사라지고 verify 4건 실패, `server.ts`는 같은 파일을 두 번 import | 원인 두 겹. (a) 청크마다 LLM이 group을 `Customers` 또는 `customers`로 다르게 적음(`analyze/prompt.ts:15`는 "리소스 이름"만 지시), 병합이 group을 정규화하지 않음. (b) `generate/tsHono.ts:10` `safeName`과 `NameRegistry.claim`(`tsHono.ts:22`)이 대소문자를 구분해 `Customers`와 `customers`를 서로 다른 이름으로 배정, 파일 쓰기 때 충돌 미검사(추정: Linux에서는 두 파일이 따로 생겨 증상이 없음) | (a) 병합 단계에서 group을 대소문자 무시로 묶어 대표 철자 하나로 통일. (b) `NameRegistry`가 소문자 기준으로 중복 판정. (b)만 고쳐도 파일 덮어쓰기는 막힌다 | 소 | 완료(PR #12) |
| 5 | analyze(merge) | 같은 `Update a customer`가 두 기능으로 나뉨: `customers.create2`(경로 `{CUSTOMER_ID}`, body 3개 속성)와 `customers.create3`(경로 `{id}`, body 19개). 카탈로그 7개 중 1개가 중복 | 청크 7은 문서 curl 예시의 `{{CUSTOMER_ID}}`를 그대로 경로 변수로 썼고 청크 0 · 8은 `{id}`. 병합이 `method + 경로`로 묶을 때 변수 이름이 다르면 다른 경로로 봄(추정, `merge.ts` bucket 키 확인 필요) | 병합 키에서 경로 변수 이름을 지우고(`/v1/customers/{}`) 묶기, 또는 프롬프트에 "경로 변수는 `{id}` 꼴 소문자" 규칙 | 중 | 완료(PR #12) |
| 6 | analyze(featureId) | POST update의 기능 id가 `customers.create2` · `customers.create3`: 이름만 봐서는 수정인지 알 수 없고 번호는 충돌 회피용 접미사 | `analyze/featureId.ts:49` `case "POST": return "create"`가 경로 끝이 변수인 POST도 create로 만듦. 문서에는 operationId가 없음 | 경로 끝이 변수인 POST는 `update`로 파생(Stripe식 관례), 또는 LLM이 준 title에서 동사 파생 | 소 | 완료(PR #12) |
| 7 | analyze | 메서드 · 경로 오추론은 없었으나 `customers.list` · `customers.get` · 중복 update는 신뢰도 0.5 · `method 추론됨` 표시. 색인 페이지(청크 0)만 메서드를 명시해 본문 청크 3개는 추론에 의존 | 설계대로(엔드포인트 페이지에 `POST /v1/...` 없음, curl 예시만 있음). 본문 청크의 `curl -G`는 GET으로 정확히 추론됨 | 청크 병합 시 색인 청크가 같은 경로를 명시하면 신뢰도를 올리는 규칙 검토 | 중 | 기록(2차에서도 10/18 기능이 0.5 — 색인 청크가 메서드를 명시해도 본문 청크 쪽 신뢰도가 그대로) |
| 8 | generate(런타임) | Stripe POST는 form-encoded인데 생성 mock이 JSON만 파싱: `curl -d "name=x"`는 400 `must have required property 'body'`, JSON으로 보내야 200 | `mock/stripe/src/routes/Customers.ts:13` `c.req.json().catch(() => undefined)`; 스키마에 `required:["body"]` | `content-type`이 `application/x-www-form-urlencoded`면 `c.req.parseBody()`로 읽어 같은 검증에 통과시킴. 카탈로그에 요청 content-type 기록 필요 | 중 | 기록(2차에서도 2건: form-encoded `POST /v1/payment_intents` 400, body 없는 `POST …/confirm` · `…/cancel` 400 — 후자는 §4 16행) |
| 9 | analyze | 중첩 객체가 얕음: `address`·`shipping`·`invoice_settings` 등이 `{"type":"object"}`뿐이고 `customers.get` 응답의 `address: {}`. update(create3) 응답 스키마는 `{"type":"object"}`에 예시 없음(출처 schema-generated) | 하위 속성이 `?query=` 링크 뒤에만 있음(사전 조사 ④), 청크 8은 응답 본문이 없는 청크로 추정 | 하위 속성 링크 추종 또는 OpenAPI(`spec3.json`) 대조(2차) | 대 | 기록 |
| 10 | verify | verify는 실패 원인을 "404"로만 보임: 라우트가 통째로 사라진 것인지 경로 불일치인지 구분 안 됨. 종료 코드 2 | `verify`가 계약 실패를 상태 코드만 기록 | 404의 응답 본문(`unknown_path`)과 생성된 라우트 목록 대조를 coverage.md에 추가 | 소 | 기록 |
| 11 | analyze(merge) | pathParam 이름이 자기 경로의 변수와 맞지 않으면 이름 바꾸기에서 빠져, 경로에 없는 필수 param이 남을 수 있음 | `merge.ts` `toFeature`의 `own.findIndex`가 일치하지 않으면 원래 이름을 그대로 둠(main부터 있던 동작) | 일치하는 변수가 없으면 해당 param을 버리거나 위치 기준으로 매핑 | 소 | 수정(PR 대기) |
| 12 | analyze(merge) | 같은 리소스가 group 3개로 갈림: `PaymentIntent`(6) · `PaymentIntents`(5) · `PaymentIntent LineItems`(1). 결과로 `src/routes/`에 `PaymentIntent.ts` · `PaymentIntents.ts` · `PaymentIntent_LineItems.ts` 세 파일 | PR #12의 group 통일은 대소문자만 무시하므로 단수 · 복수 · 접미 구분은 못 묶음(추정, 청크마다 LLM이 `PaymentIntent` 또는 `PaymentIntents`로 다르게 적음). OpenAPI tag 우선 규칙은 이번 입력에 OpenAPI 없음 | 병합 시 group 단수 · 복수 정규화, 또는 프롬프트에 "색인 페이지 제목과 같은 철자 사용". 하위 리소스(`LineItems`)를 부모 group에 묶을지 정책 결정 | 중 | 수정(PR 대기) |
| 13 | analyze(featureId) | 하위 동작 id에 리소스 접두가 없고 `create`로 끝남: `cancel.create` · `capture.create` · `confirm.create` · `increment_authorization.create` · `apply_customer_balance.create` · `verify_microdeposits.create`. 검색은 `search.list`(Customers)와 충돌해 `search.list2` | `featureId.ts`가 경로 마지막 정적 세그먼트로 이름을 짓고 POST는 `create`(1차 §4 6행 규칙은 경로 끝이 변수인 POST만 `update`로 바꿈, 하위 동작 POST는 `create` 유지). 충돌은 번호 접미사로 해소 | 하위 동작은 `payment_intents.cancel` 꼴(부모 세그먼트 + 동작)로 파생. 검색은 `payment_intents.search` | 소 | 수정(PR 대기) |
| 14 | analyze(merge) | 경로 변수 이름이 기능마다 다름: `/v1/payment_intents/{id}`(get · update · confirm · increment_authorization · verify_microdeposits)와 `/v1/payment_intents/{payment_intent_id}/…`(cancel · capture · apply_customer_balance · amount_details_line_items) | 문서 각 페이지의 표기를 그대로 씀(색인 청크는 `{id}` 쪽). 병합은 경로가 같은지만 보고 변수 이름은 통일하지 않음(추정) | 같은 리소스 접두 아래 변수 이름을 `{id}`로 통일하거나 프롬프트 규칙 | 소 | 수정(PR 대기) |
| 15 | analyze | 본문 청크가 큰 페이지의 body 속성이 적게 추출됨: `payment_intents.create` 4개(create 페이지 35,126자, Stripe 실제 파라미터는 수십 개: 추정), `confirm.create` 2개, `customers.update` 3개(1차 중복 `create3`는 19개였고 PR #12 병합 후 3개 쪽이 남음). create의 required 없음(문서상 `amount` · `currency` 필수) | 추정: 청크 분할로 파라미터 표 일부만 해당 청크에 들어감, 병합이 속성 수가 더 많은 쪽을 우선하지 않음. 미확인(청크 경계 · 병합 선택 규칙 확인 필요) | 청크 분할 지점 확인, 병합 시 같은 기능의 body 속성은 합집합 | 중 | 수정(PR 대기) |
| 16 | generate(런타임) | POST 엔드포인트에 body를 안 보내면 400: `POST /v1/payment_intents/pi_123/confirm` · `…/cancel`을 body 없이 호출하면 `must have required property 'body'`. Stripe는 body 없이 호출 가능 | 생성 스키마가 POST body 객체가 있으면 최상위 `required:["body"]`로 둠(`mock/stripe/src/routes/PaymentIntents.ts` `schema_confirm_create`, `…_capture_create`, `…_increment_authorization_create`). body 속성이 모두 선택이어도 동일 | body의 `required`가 비어 있고 속성이 모두 선택이면 최상위 `required`에서 `body` 제외 | 소 | 수정(PR 대기) |
| 17 | generate(런타임) | `GET /v1/payment_intents/pi_123`이 요청 id와 다른 고정 샘플 id(`pi_3MtwBwLkdIwHu7ix…`)를 돌려줌, 같은 이유로 confirm은 다른 샘플 id | 고정 fixture 응답(설계대로). 경로 id 반영 없음 | 경로 변수와 같은 이름 속성이 응답에 있으면 치환하는 옵션 검토 | 소 | 기록 |

## 5. 개선 과제 (우선순위)

(§4에서 묶음)

## 6. 비용 합계

| 구분 | 토큰 합계 | API 환산 비용 | 시간 합계 |
|---|---|---|---|
| 제품(specmock LLM 호출) | 1차 12호출 + 2차 42호출 = 54호출: 입력 108 / 출력 50,016 / 캐시 읽기 710,226 / 캐시 생성 544,547 (2차분: 입력 84 / 출력 34,302 / 캐시 읽기 557,040 / 캐시 생성 423,072) | $10.86 (1차 $2.60 + 2차 $8.25, 반올림 차이, API 환산 · 구독 간주) | 10분 15초(1차 2분 41초 + 2차 7분 34초, `llm-usage.jsonl` durationMs 합 615,464) |
| 개발 층(harness 워커) ask 18회(분석 1 · 구현 13 · 리뷰 4) | metrics에 토큰 필드 없음(`.harness/log` result 줄 합산은 후속) | $10.37 (API 환산) — analyst $2.57 + implementer $4.95 + reviewer $2.85 | 중앙값 225s · p95 592s |

개발 층 비고: 3단계 머지 정리(#8) $0.38 포함. 이 점검으로 생긴 작업: 사전 조사 · 사용량 기록(#10) · 결함 수정(#12) · 기록.
