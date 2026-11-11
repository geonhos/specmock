# LLM 사용량 기록(`llm-usage.jsonl`) 설계

작성일: 2026-11-11
상태: 승인됨(사용자 결정 "토큰 기록 먼저 넣고 시작"). 구현 중 바뀐 결정은 §8에.
배경: Stripe 실사용 점검(`docs/superpowers/notes/real-use-check-stripe.md`)에서 LLM 호출의 토큰 · 비용 · 시간을 근거 자료로 남기려 한다. 지금 `ClaudeCodeAdapter`는 `claude --print --output-format json` 응답 봉투에서 `structured_output`만 읽고 `usage` · `total_cost_usd` · `duration_ms`를 버린다(`packages/core/src/llm/claudeCode.ts:17, 69-77`). `--no-session-persistence`라 사후 복구도 불가하다. 사전 조사 상세: `.harness/stripe-survey.md` §2.

## 0. 한 문장 요약

specmock이 `claude`를 부를 때마다 토큰 · API 환산 비용 · 소요 시간을 `.specmock/<system>/llm-usage.jsonl`에 한 줄씩 남기고, `analyze` · `generate`가 끝날 때 합계 한 줄을 보여준다.

## 1. 범위

| 포함 | 제외(후속) |
|---|---|
| `ClaudeCodeAdapter` 경로 전부: CLI `analyze`(청크 추출), CLI `generate`(Java 등 LLM 생성 시도), CLI `run`(둘을 합친 실행), Web UI 서버가 같은 어댑터로 부르는 호출 | 세션 모드(`--llm session`, MCP `analyze_spec` · `finalize_generation`): LLM을 사용자 세션이 쓰므로 specmock이 볼 수 없다. 기록 없음, 문서에 "미측정" 명시 |
| 성공 · 실패 · 시간 초과 모두 기록(`ok: false`에 `error`) | Web UI 화면 표시, `specmock usage <system>` 조회 명령, `ServiceEvent`에 usage 싣기 → 데이터가 쌓인 뒤 필요하면 2안 |
| CLI 끝 합계 한 줄(stderr) | `--json` 결과에 usage 합계 포함은 **포함**(아래 §4) — 비용이 거의 없고 스크립트 기록에 바로 쓸 수 있다 |

## 2. 기록 형식

파일: `.specmock/<system>/llm-usage.jsonl`. 한 호출 = 한 줄, append 전용(`fs.appendFile`, 잠금 없음 — 호출은 순차).

```json
{"at":"2026-11-11T06:12:03.412Z","stage":"extract","detail":"chunk 012 · Create a customer","model":"claude-sonnet-4-5","inputTokens":1842,"outputTokens":611,"cacheReadTokens":0,"cacheCreationTokens":3977,"costUsd":0.0219,"costBasis":"list","billing":"subscription","durationMs":9420,"apiDurationMs":8870,"ok":true}
```

| 필드 | 출처 | 비고 |
|---|---|---|
| `at` | 호출 시작 시각 ISO | |
| `stage` | 호출자 | `"extract"`(analyze 청크) · `"generate"`(LLM 생성) |
| `detail` | 호출자 | extract: `chunk NNN · <heading>`; generate: `<language> attempt n/m` |
| `model` | 봉투 `modelUsage`의 키(여럿이면 토큰 합이 가장 큰 것), 없으면 요청 `--model` 또는 `null` | |
| `inputTokens` · `outputTokens` · `cacheReadTokens` · `cacheCreationTokens` | 봉투 `usage.input_tokens` · `output_tokens` · `cache_read_input_tokens` · `cache_creation_input_tokens` | 없으면 `null` |
| `costUsd` · `costBasis` | 봉투 `total_cost_usd`, `modelUsage.*.costBasis`(보통 `"list"`) | 없으면 `null` |
| `billing` | 어댑터 프로세스 env에 `ANTHROPIC_API_KEY` · `ANTHROPIC_AUTH_TOKEN` · `CLAUDE_CODE_USE_BEDROCK` · `CLAUDE_CODE_USE_VERTEX` 중 하나라도 비어 있지 않게 있으면 `"api-key"`, 없으면 `"subscription"` | **환경 기반 추정**이다. settings의 `apiKeyHelper` 등은 볼 수 없어 구독으로 보여도 실제로는 API 청구일 수 있다. `costUsd`는 **API 정가 환산**이며 구독이면 실제 청구가 아니다 |
| `durationMs` | 어댑터가 잰 벽시계(spawn → 종료) | 항상 있음 |
| `apiDurationMs` | 봉투 `duration_api_ms` | 없으면 `null` |
| `ok` · `error` | 성공 여부, 실패면 오류 종류 + 첫 줄 200자 이내 요약(마스킹 거침, 응답 본문 발췌 없음) | 시간 초과 · 비정상 종료 · JSON 파싱 실패도 한 줄 |

봉투에 `usage`가 없어도(테스트 스텁, 옛 CLI) 토큰 필드는 `null`로 기록하고 실패로 취급하지 않는다.

## 3. 구조

```
LlmAdapter.complete(request)                    ← request.onUsage?(u: LlmUsage) 선택 콜백 추가
  ClaudeCodeAdapter                               ← 봉투 파싱(usage·cost·duration), 벽시계, 성공·실패 모두 onUsage 호출
    ↑ 호출자가 stage·detail을 붙여 appendUsage(dir, record)
analyze/extract.ts:58  (stage extract)            generate/llm.ts:99  (stage generate)
    → core/src/llm/usageLog.ts: appendUsage(), readUsage(), summarizeUsage()
CLI analyze / generate 끝: summarizeUsage(이번 실행분) → stderr 한 줄, --json이면 result.usage
```

- `LlmUsage` 타입(`llm/adapter.ts`): 위 레코드에서 `stage` · `detail`을 뺀 부분. 어댑터는 단계를 모른다.
- `usageLog.ts`: `appendUsage(systemDir, record)`, `readUsage(systemDir)`(줄 단위 파싱, 깨진 줄은 건너뜀), `summarizeUsage(records)` → `{calls, ok, failed, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, costBasis, billing, durationMs}`(null은 0으로 더하되 `costUsd`는 전부 null이면 null).
- "이번 실행분" 구분: 호출자가 실행 시작 시각을 들고 `at >= startedAt`인 줄만 합산한다(파일에 run id를 넣지 않는다 — 단순함 우선).
- `SessionAdapter` · 테스트용 fake 어댑터는 `onUsage`를 부르지 않아도 된다(선택 콜백). 기존 fake `claude` 스텁 11개는 usage가 없으므로 토큰 `null`.

## 4. 사용자에게 보이는 것

- `specmock analyze <system>`(claude-code 모드) 끝에 stderr:
  `LLM 호출 12회(실패 0) · 입력 22,104 · 출력 7,310 · 캐시 읽기 41,200 · API 환산 $0.26 (구독: 실제 청구 아님) · 1분 52초`
  괄호는 `billing`에 따라 `(API 키 미감지 → 구독으로 간주, 실제 청구 아님)` 또는 `(API 키 감지 → 실제 청구)`. 환경만 보고 추정하므로 단정하지 않는다.
- `specmock generate <system> --lang java` 끝에 같은 형식(시도 수 포함: `LLM 호출 2회(시도 2/3)`).
- `specmock run` 끝에도 같은 합계 줄(analyze + generate 합산, 실패 횟수 표기). `--json` 결과에 `usage` 추가.
- `--json` 결과에 `usage: { calls, failed, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, costBasis, billing, durationMs }` 추가. 호출이 0회(세션 모드, TS 생성)면 `usage: null`.
- README "커버리지 리포트" 근처에 "LLM 사용량" 절 1개: 파일 위치, 필드 뜻, API 환산 비용의 의미, 세션 모드 미측정.
- Web UI · MCP 변경 없음(Web 경로는 기록만 된다).

## 5. 오류 처리

- 기록 실패(디스크 · 권한)는 **경고 한 줄만** 내고 본 작업을 멈추지 않는다.
- 봉투 파싱 실패 · 시간 초과 · 비정상 종료는 `ok: false`, `error`는 오류 종류 + 첫 줄 200자 이내를 `maskSecrets`로 거친 것(stdout 발췌는 넣지 않는다. 사용자에게 던지는 예외 메시지는 그대로). 토큰 필드는 봉투가 있으면 채우고 없으면 `null`.
- `onUsage` 콜백이 던지면 어댑터가 잡아 경고로 바꾼다(호출자 버그가 LLM 결과를 잃게 하지 않는다).
- `llm-usage.jsonl`은 `.specmock/` 아래라 사용자 저장소의 `.gitignore` 안내(README 기존)에 포함된다. 레코드에 프롬프트 · 응답 본문은 넣지 않는다(비밀 노출 경로를 만들지 않는다).

## 6. 테스트

| 대상 | 방식 |
|---|---|
| `ClaudeCodeAdapter` 봉투 파싱 | 새 fake `packages/core/test/bin/claude-usage`(usage · total_cost_usd · duration_api_ms · modelUsage를 담은 봉투 출력)로 `onUsage` 레코드 단언. usage 없는 기존 스텁으로 `null` 단언. 실패 스텁으로 `ok: false` + `durationMs` 존재 |
| `usageLog.ts` | append → read 왕복, 깨진 줄 건너뜀, `summarizeUsage`의 null 합산 규칙 |
| extract · generate 호출자 | fake 어댑터가 `onUsage`를 부르면 `llm-usage.jsonl`에 `stage` · `detail`이 맞게 적히는지 |
| CLI | `analyze` · `generate --json`의 `usage` 필드, stderr 합계 줄(부분 일치), 세션 모드 `usage: null` |
| 기존 | 805 tests 그대로. TS 생성물 스냅샷 · golden 무변경(generate TS는 LLM을 부르지 않으므로 파일도 생기지 않는다) |

## 7. 구현 순서

1. `adapter.ts`에 `LlmUsage` · `onUsage` → `claudeCode.ts` 파싱 · 벽시계 · 콜백(+fake `claude-usage`, 테스트)
2. `usageLog.ts`(+테스트)
3. `extract.ts` · `generate/llm.ts` 연결(+테스트)
4. CLI 합계 줄 · `--json usage`(+테스트), README 절, 상위 설계 §5.6 종료 메시지 · architecture.md 한 줄
5. 실사용 점검 문서 §2 측정 방법을 최종 형식으로 갱신

## 8. 구현 중 변경

(구현자 · 리뷰어가 기록)

| 설계 | 구현에서 바꾼 것 | 이유 |
|---|---|---|
| 성공 호출 중심 | 시간 초과 · spawn 실패 · 중단도 `onUsage`로 `ok: false` 기록 | 실패한 시도도 시간과 토큰을 쓴다. 점검 근거에서 빠지면 안 됨 |
| 어댑터가 직접 append | 호출자가 `createUsageSink(systemDir)`(`record`/`flush`)로 기록 | 콜백은 동기, append는 비동기. 순서를 지키며 종료 전에 `flush`로 기다리려고 |
| generate 합계 줄 | `(시도 <호출 수>/<max ?? 3>)`로 표기 | 실패 횟수보다 시도 횟수가 generate의 재시도 맥락에 맞음 |
| `--json` `usage`는 합계 전체 | `ok` 필드 제외(`calls` · `failed`가 대신함) | 중복 |
| 호출 0회면 `usage: null` | prepare 모드 JSON도 `usage: null` | 필드 유무가 모드마다 달라지지 않게 |
| `appendUsage` 오류 처리는 호출자 | `appendUsage`가 스스로 경고하고 던지지 않음 | 기록 실패가 본 작업을 막으면 안 됨 |
| 비밀값 마스킹 | `maskSecrets` 패턴에 `sk-ant-…`가 없어 테스트는 `Bearer` 토큰으로 확인 | 기존 패턴을 넓히는 것은 이 작업 범위 밖 |
| `run` 명령은 범위 밖 | `run`에도 합계 줄 · `--json` `usage` 추가(2026-11-11 리뷰 후속) | `run`이 가장 흔한 진입점인데 기록만 되고 합계가 안 보이면 빠진 느낌 |
| `billing`은 `ANTHROPIC_API_KEY`만 | `ANTHROPIC_AUTH_TOKEN` · Bedrock · Vertex 플래그도 api-key로, 합계 줄 문구는 "감지/미감지"로 단정 회피 | 같은 API 청구 경로이고, `apiKeyHelper`는 볼 수 없어 "구독"이라 단정하면 틀릴 수 있음 |
| `error`에 기존 예외 메시지 전체 | 오류 종류 + 첫 줄 200자 이내만, stdout 발췌 제외(stderr 첫 줄은 허용) | §5 "프롬프트 · 응답 본문은 넣지 않는다"를 지키려고. 비정상 종료 시 stdout 300자가 응답 본문일 수 있었음 |
| `is_error` 봉투의 `error`는 `result` 첫 줄 | `subtype`(없으면 "is_error")만 기록. `result`는 모델이 쓴 텍스트일 수 있어 사용자에게 던지는 예외에만 남김(2026-11-11 재리뷰 후속) | §5 "응답 본문은 넣지 않는다"를 원천 차단 |
| 비밀값 마스킹은 `Bearer` 테스트로 확인 | `maskSecrets`에 `sk-ant-…` 패턴 추가 | 사용량 기록에 키가 새지 않게. 1B 문서의 "완전하지 않음" 문구는 유지 |
| append는 그대로 덧붙임 | 파일 끝이 개행이 아니면 `\n`부터 씀 | 이전 쓰기가 줄 중간에서 끊겨도 새 레코드를 읽을 수 있게 |
| (미정) Web UI | 코어를 거쳐 기록되지만 화면 표시 없음 | 범위 밖 |
