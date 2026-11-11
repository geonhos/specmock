# 실사용 점검 기록: Stripe

시작일: 2026-11-11
상태: 진행 중(사전 조사 완료, LLM 사용량 기록 기능 선행 구현 중)
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

## 4. 걸린 지점 (증상 → 원인 → 개선안 → 크기)

| # | 단계 | 증상 | 원인 | 개선안 | 크기 | 상태 |
|---|---|---|---|---|---|---|
| 1 | 전체 | LLM 호출의 토큰 · 비용 · 시간이 어디에도 남지 않음 | `ClaudeCodeAdapter`가 응답 봉투의 `usage` 등을 버림 | `llm-usage.jsonl` 기록 + CLI 합계(설계 2026-11-11) | 소(6~7파일) | 진행 중 |
| 2 | ingest | Markdown으로 응답하는 사이트에서 `--harvest always`를 줘도 조용히 수확하지 않음 | 수확 조건이 `kind === "html"` | 안내 메시지("Markdown 응답이라 수확 생략") 또는 문서화 | 소 | 기록 |
| 3 | ingest(수확) | 링크 추종이 `docs.stripe.com/api/...`를 따라가지 않음 | `referenceLinks`가 경로만 검사, bare `/api/` 제외 | `docs.`/`developer.` 호스트 또는 시작 URL과 같은 경로 접두사면 허용 | 소 | 기록(현재 피해 없음) |

## 5. 개선 과제 (우선순위)

(§4에서 묶음)

## 6. 비용 합계

| 구분 | 토큰 합계 | API 환산 비용 | 시간 합계 |
|---|---|---|---|
| 제품(specmock LLM 호출) | | | |
| 개발(harness 워커) | | $2.95 (조사 $2.57 + 정리 $0.38) | |
