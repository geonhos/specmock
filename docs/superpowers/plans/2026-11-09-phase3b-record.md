# 3B 실제 시스템 녹화(record) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `specmock record <system>`이 mockspec의 "정상 요청" contract를 `.specmock/<system>/target.json`의 실제 시스템에 순서대로 보내 응답을 `recorded/<id>.json`에 저장하고, 스펙과의 차이를 `drift.md`에 적고, select → generate를 다시 돌려 mock fixture를 실제 응답으로 바꾼다(`source: "recorded"`). CLI·MCP(`record_responses`)·Web(Verify 화면 카드)이 같은 서비스 함수를 쓴다.

**Architecture:**
- core `verify/contracts.ts`: `verify/index.ts`의 contract 실행기를 `runContract(baseUrl, contract, opts)`로 꺼낸다. verify와 record가 같은 판정을 쓴다. URL은 새 `joinUrl`로 만든다(baseUrl 경로 `/v2`를 지우지 않음).
- core `record/`: `target.ts`(target.json 읽기·`${ENV}` 치환·params 덮어쓰기), `recorded.ts`(녹화 파일 이름·읽기·쓰기), `drift.ts`(drift.md 렌더), `index.ts`(`record()`: 대상 선택 → 순차 실행 → 분류 → 녹화 파일 → drift.md).
- select는 `recorded/<id>.json`을 읽어 기본 응답 fixture를 바꾼다. generate는 lock의 새 `inputHash`(fixture 본문을 뺀 mockspec 해시)가 같으면 LLM을 다시 부르지 않고 fixture만 다시 쓴다.
- 서비스 `recordResponses()`: record → (apply) `select(이전 선택)` → `generate(같은 outDir·언어)`. CLI·MCP·ui-server는 얇은 래퍼다.

**Tech Stack:** 기존 스택(Node ≥22.19, pnpm 12.9.1, TypeScript ^5.9.3, zod ^4.6.7, vitest ^5.1.0, ajv ^8.20.0, commander, hono, MCP SDK v2, React). 새 의존성은 없다. HTTP는 전역 `fetch`, 가짜 실제 서버는 `node:http`.

**Spec:** docs/superpowers/specs/2026-11-09-phase3b-record-design.md
**Branch:** feat/phase3b-record (HEAD 0694437 = 3A d10311e + 설계 문서)

---

**사전 확인된 사실 (2026-11-09, macOS / Darwin 25.6, HEAD 0694437):**

빌드·테스트:
- 루트 `package.json` 스크립트: `test: pnpm build && vitest run`, `typecheck: pnpm --filter "@specmock/ui-server..." build && pnpm -r typecheck && tsc -p tsconfig.scripts.json`, `llm:check: pnpm -s build:core && tsx scripts/live-llm-check.ts`. `tsconfig.scripts.json`은 `scripts/`를 포함하므로 새 스크립트도 typecheck된다.
- 파일 하나는 루트에서 `pnpm vitest run <경로>`. core 테스트는 `src`를 직접 import해서 빌드가 필요 없다. CLI·MCP·ui-server·web 테스트는 빌드된 core(`dist`)를 쓰므로 **먼저 `pnpm build`**.
- `core/test/snapshot.test.ts`가 생성 TS mock의 모든 파일 해시를 `packages/core/test/__snapshots__/snapshot.test.ts.snap`에 고정한다. `specmock.lock.json`은 스냅샷에서 빠져 있어 lock에 필드를 더해도 스냅샷은 그대로다.

바뀌는 기존 코드:
- `verify/index.ts:47-83` `runContract(base, ajv, c)`: `new URL(c.request.path, base)` → query `searchParams.set` → `fetch` → status 비교 → (스키마가 있고 status가 같을 때만) 바디 JSON 파싱·ajv 검증. 오류 문구 4종: `schema: …`, `status: expected X, got Y`, `body is not JSON: <200자>`, `request failed: <message>`, ajv `${instancePath || "/"} ${message}`. `verify()`(:94-115)가 `makeAjv()` 하나를 만들어 contract마다 부른다.
- `select/contracts.ts`: `fillPath(feature)`가 `{name}`을 `encodeURIComponent(sampleScalar(...))`로 채운다. 정상 contract 이름은 `"정상 요청"`(기본 2xx·스키마 있음), 오류 contract는 `"필수 값 누락"`(400, 스키마 null). contract는 fixture의 **status만** 본다.
- `select/fixtures.ts:32-62` `buildFixtures(feature)` → `{ fixtures, assumptions }`. `select/index.ts:78-84`가 기능마다 부르고, `:97`이 `mockspec.json`을 쓴다(`baseUrl: "/"`). `select(ws, system, exprs, opts)`는 `withSystemLock`을 잡는다. `selection.json`의 `selected`는 표현식 목록이라 `select(ws, system, prev.selected)`가 같은 선택을 재현한다.
- `types.ts:96-100` `FixtureSchema.source` = `spec-example | doc-sample | schema-generated | empty`. 이 목록을 따로 가진 곳은 `verify/coverage.ts:4`(SOURCES)와 `:29-32`(표 행)뿐이다.
- `generate/index.ts:148` `mockspecHash = hashJson(spec)` — **fixture 본문까지 포함한다.** `:154-162`가 "LLM 언어·같은 언어·generator llm·같은 mockspecHash·force 아님"이면 LLM을 부르지 않고 `skipped: true`를 돌려준다. 그래서 녹화로 fixture만 바뀌어도 지금은 LLM이 다시 불린다. LLM 지시서는 fixture 본문을 싣지 않는다(`generate/request.ts:49` "fixture 바디 없이 기능 요약", 생성 서버는 `fixtures/<id>/<status>.json`을 요청마다 읽음).
- `generate/session.ts:168-186` `finalizeGeneration`도 lock을 쓴다. `generate/lock.ts:16-36` `LockSchema`.
- `ingest/mask.ts` 세 번째 패턴의 값 부분 `[^"'\s,}]{8,}`이 `&`에서 멈추지 않는다(`?api_key=abcdefgh123&x=1` → `&x=1`까지 지움).
- `service/events.ts:1` `ServiceStage` 유니언. `service/index.ts`는 서비스별 export 줄, `core/src/index.ts:7`이 `maskSecrets`를 export한다.
- `Workspace.write(system, name, schema, data)`는 `path.dirname`을 mkdir하므로 `name = "recorded/<id>.json"`이 된다. `ws.read`의 형식 오류 메시지에는 `z.prettifyError`가 들어간다.
- MCP: `names.ts` `TOOL_NAMES` 12개. `tools.test.ts:21,24,207,213`이 12를 고정. `mcp/test/plugin.test.ts`가 SKILL.md의 백틱 토큰을 `/`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock|ui|generation))`/g`로 뽑는다. `connect()`는 서버를 SDK 기본 env(제한된 환경변수)로 띄우므로 MCP 테스트의 target.json은 `${ENV}` 없이 쓴다. MCP의 비-ts generate는 세션 모드라 MCP 프로세스는 claude를 띄우면 안 된다.
- CLI: `cli.ts`의 `register*` 호출, `commands/verify.ts`의 `workspaceFrom(cmd)`·`fail()`·`printJsonOr()` 패턴, `context.ts` `formatGenerate(report)`. `cli/test/plugin.test.ts:47`이 SKILL.md의 `specmock (ingest|analyze|list|select|generate|verify|run)` 줄의 옵션을 `--help`와 대조한다.
- ui-server: `security.ts` `POST_ONLY` 정규식, `jobs.ts:20` `CANCELLABLE`, `api-types.ts:32` `JobKind`, `app.ts`의 verify 라우트(:131-137) 뒤가 새 라우트 자리. web: `format.ts:3` `JOB_KIND_LABEL`, `api.ts`, `screens/Verify.tsx`(145줄), `src/coverage.ts`(행 수 고정 아님).

---

**설계 문서 대비 결정 사항:**

| # | 항목 | 결정 | 이유 |
|---|---|---|---|
| D1 | contract 실행기 모양 | `runContract(baseUrl, c, { headers?, timeoutMs?, signal?, ajv?, maxBytes? }) → ContractRun`. `ContractRun`은 `{ url, status, headers(content-type·content-length만), kind("json"\|"raw"\|"empty"\|"truncated"\|null), body, bytes, schemaErrors, errors, failure }`. `errors`는 지금 verify 문구와 글자까지 같다. verify는 `ContractResult`로 옮겨 담기만 한다 | 설계의 `{ status, headers, body, schemaErrors }`에 record 분류(timeout·연결 실패·비JSON·1MB)에 필요한 값을 더했다. verify 결과는 바이트 단위로 같다 |
| D2 | 경로 결합 | `joinUrl(baseUrl, path, query)`: baseUrl 경로 끝 `/`를 지우고 path를 붙인다. verify의 base(`http://127.0.0.1:port`)는 경로가 없어 지금과 같은 URL이 나온다. target의 baseUrl은 query·hash·계정 정보(`user:pass@`)를 거부 | 설계 §3.1. 계정 정보를 거부해야 drift.md에 baseUrl을 그대로 적어도 안전하다 |
| D3 | params 덮어쓰기 | 경로: `fillPath(feature, params)`로 `feature.path`에서 다시 만든다(덮어쓴 값도 encodeURIComponent). 쿼리: contract query에 있거나 `feature.request.query`에 선언된 이름만 덮어쓴다 | 선언되지 않은 쿼리를 모든 기능에 붙이면 실제 시스템이 400을 낼 수 있다 |
| D4 | "같은 mockspec" 판정과 fixture | `specInputHash(spec)` = fixture를 status 목록으로 줄이고 assumptions를 뺀 mockspec의 hashJson. lock에 `inputHash`(선택 필드)로 기록(generate·finalize 둘 다). generate는 기존 `skipped` 경로 다음에 "LLM·같은 언어·`previous.inputHash === inputHash`·force 아님"이면 LLM 없이 `writeScaffold`와 lock·generate.json만 다시 쓴다(`skipped: false`, `attempts: 0`, 메모 "fixture만 바뀌어 LLM을 다시 부르지 않았습니다") | 설계 §4.2 "포함하면 소스 결정 입력에서 fixture를 제외". 지시서에 fixture 본문이 없으므로 안전하다. assumptions는 녹화 메모로 바뀌므로 뺀다. 기존 `skipped` 경로·테스트는 그대로 |
| D5 | apply와 LLM | 서비스 apply는 LLM을 절대 부르지 않는다. lock이 없거나, generator가 llm인데 `lock.inputHash !== specInputHash(새 mockspec)`(옛 lock 포함)이면 generate를 건너뛰고 메모 "generate를 실행하면 반영됩니다(LLM 재생성 필요)". 그래서 `RecordResult.applied`는 `{ selected: number; generate: GenerateReport \| null } \| null`(설계는 generate 필수) | MCP는 세션 모드라 claude를 띄우면 안 되고, CLI에서도 녹화가 수 분짜리 LLM 호출로 번지면 안 된다 |
| D6 | 녹화 파일 `mockspecHash` | 값은 `featureInputHash(spec, id)` = 그 기능(fixture는 status만)과 그 기능의 contract의 hashJson(접두사 `sha256:` 없음). select는 새 mockspec에서 같은 값을 계산해 다르면 "낡은 녹화" assumption(사용은 함) | 전체 mockspec 해시를 쓰면 apply가 fixture를 바꾸거나 기능 하나를 더 선택하는 순간 모든 녹화가 "낡음"이 된다 |
| D7 | 녹화 파일 응답 모양 | `response.kind: "json" \| "raw" \| "empty" \| "truncated"`를 더한다. raw는 `body: { raw, contentType }`, truncated는 `body` 없이 `truncated: true, bytes`. select는 `kind === "json"`이고 status가 기본 2xx와 같을 때만 쓴다. 쓰지 않는 사유별 문구: status 다름(설계 문구 그대로) · "1MB를 넘어" · "바디가 JSON이 아니라" | 실제 JSON 바디가 우연히 `{ raw, contentType }` 모양이어도 구별된다. HEAD·204의 빈 바디를 비JSON 실패로 세지 않는다 |
| D8 | 분류 순서 | 응답 없음(timeout → 실패 "시간 초과(nms)", 연결 실패 → 첫 요청이면 중단·코드 1, 이후면 실패 "연결 실패: …") → status 다름(상태 불일치) → truncated(실패) → raw(실패) → 스키마 오류(스펙과 다름, 빈 바디+스키마는 `body is not JSON: `) → 일치. "첫 요청"은 실제로 보낸 첫 contract(건너뜀 제외). 1MB 검사는 바디를 다 읽은 뒤 바이트 수로 한다 | 설계 §3.4·§4.5 |
| D9 | 대상 contract | 기능마다 `name === "정상 요청"` contract 하나. 기본은 method GET·HEAD만, 나머지는 `skipped`. `allowMutating`이면 전부. `features`에 없는 id(현재 mockspec 기준)는 즉시 `알 수 없는 기능 id: a, b` | 설계 §4.1. "필수 값 누락"은 의도적으로 400을 노리므로 실제 시스템에 보내지 않는다 |
| D10 | 비밀 처리 | target.json JSON 파싱 오류는 원문 조각 없이 "JSON 파싱 실패"만(Node의 파싱 오류 메시지는 원문을 인용한다). 스키마 오류는 필드 경로만. 보낸 헤더 = contract 헤더 + target 헤더(target 우선). 녹화 파일의 `request.headers`·`request.query`는 `maskHeaders`, drift.md 전체·진행 이벤트·실패 사유는 `maskSecrets` | 설계 §4.5 |
| D11 | 마스킹 | `maskSecrets` 세 번째 패턴의 값 부분을 `[^"'\s,}&]{8,}`로(한 글자 수정). `maskHeaders(record)`: 소문자 키가 `authorization`·`cookie`·`set-cookie`이거나 `key`·`token`·`secret`·`password`를 포함하면 값 `***`. 원본 키 대소문자는 유지 | 설계 §2 |
| D12 | 녹화 파일 이름 | `recorded/<featureId>.json`. id가 `/^[\p{L}\p{N}_.-]+$/u`에 맞고 `.`·`..`이 아니어야 한다(아니면 record는 오류, select는 무시) | 설계 §3.2 "구현 때 한 번 더 검사" |
| D13 | coverage 행 | `recorded` 행을 표 맨 위에 둔다. web 파서는 행 수를 고정하지 않으므로 테스트로만 확인 | 가장 믿을 만한 출처가 위에 온다 |
| D14 | 서비스 결과 | `recordResponses()` → `RecordResponsesResult = { result: RecordResult; driftPath; driftMarkdown; notes: string[] }`(`VerifyMockResult`와 같은 모양). CLI `--json`은 `result`만 출력 | MCP·Web이 drift.md 본문을 다시 읽지 않고 보여 준다 |
| D15 | drift 문구 | 스키마 오류 줄에 설계 예시의 `(실제 "p-123")` 값 인용은 넣지 않는다. 오류 문구는 verify와 같은 ajv 문구 | 실제 데이터 값을 리포트에 퍼뜨리지 않고, verify 문구와 하나로 맞춘다 |
| D16 | `pnpm record:check` | 대상 `https://petstore3.swagger.io/api/v3`(OpenAPI `/openapi.json`). 임시 디렉터리에 ingest → analyze → `select all` → record(apply 없음). 성공 기준은 "끝까지 돌고 drift.md가 생김"(종료 코드 0·2 모두 OK). 네트워크가 필요하고 CI에 넣지 않는다 | 설계 §8 열린 질문 1 |
| D17 | `generate.json`이 없을 때 apply | select는 다시 실행하고(mockspec에 녹화 반영) generate만 건너뛴다. `applied = { selected, generate: null }` + 메모 "generate를 실행하면 반영됩니다" | 설계는 "녹화와 drift만"이지만, select를 건너뛰면 나중에 사용자가 generate만 돌렸을 때 녹화가 빠진다. select는 결정적이고 빠르다 |
| D18 | ui-server `GET target` 응답 | 설계의 `{ exists, baseUrl? }`에 `example`(TARGET_EXAMPLE)과 `error?`(형식 오류, 필드 이름만)를 더한다. env 치환 없이 존재·형식만 본다 | 복사 버튼용 예시를 웹에 중복해 두지 않고, 형식 오류를 녹화 전에 보인다. headers·params는 여전히 싣지 않는다 |

---

**파일 구조:**

| 파일 | 할 일 |
|---|---|
| `packages/core/src/verify/contracts.ts` | 새 파일. `joinUrl`, `runContract`, `ContractRun` |
| `packages/core/src/verify/index.ts` | `runContract` 제거하고 새 모듈 사용 |
| `packages/core/src/ingest/mask.ts` | `&` 수정, `maskHeaders` |
| `packages/core/src/select/contracts.ts` | `fillPath(feature, overrides?)` |
| `packages/core/src/record/target.ts` | 새 파일. `TargetSchema`, `readTarget`, `substituteEnv`, `applyParams`, `TARGET_EXAMPLE` |
| `packages/core/src/record/recorded.ts` | 새 파일. `RECORDED_DIR`, `isSafeFeatureId`, `recordedName`, `readRecorded` |
| `packages/core/src/record/drift.ts` | 새 파일. `DriftEntry`, `renderDrift`, `statusHint` |
| `packages/core/src/record/index.ts` | 새 파일. `record()`, `RecordResult`, `RecordOptions`, `RecordRun` |
| `packages/core/src/util/specHash.ts` | 새 파일. `specInputHash`, `featureInputHash` |
| `packages/core/src/types.ts` | Fixture.source에 `recorded`, `RecordedSchema` |
| `packages/core/src/select/fixtures.ts`, `select/index.ts` | 녹화 반영, 낡은 녹화 경고 |
| `packages/core/src/verify/coverage.ts` | `recorded` 행 |
| `packages/core/src/generate/lock.ts`, `generate/index.ts`, `generate/session.ts` | `inputHash`, fixture만 바뀐 경로 |
| `packages/core/src/service/record.ts`, `service/events.ts`, `service/index.ts`, `src/index.ts` | 서비스·stage·export |
| `packages/cli/src/commands/record.ts`, `cli/src/cli.ts` | `specmock record` |
| `packages/mcp/src/tools/record.ts`, `mcp/src/names.ts`, `mcp/src/createServer.ts` | `record_responses` |
| `plugin/skills/specmock/SKILL.md` | 도구·명령·env 규칙 |
| `packages/ui-server/src/app.ts`, `security.ts`, `jobs.ts`, `api-types.ts` | target·record 라우트, job kind |
| `packages/web/src/api.ts`, `format.ts`, `screens/Verify.tsx`, `components/RecordCard.tsx` | 실제 시스템 카드 |
| `scripts/record-check.ts`, `package.json` | `pnpm record:check` |
| `README.md`, `docs/architecture.md`, 상위 설계 §10·§11, 3B 설계 §7 | 문서 |
| 테스트 | core `contract-run.test.ts`·`mask.test.ts`·`target.test.ts`·`drift.test.ts`·`record.test.ts`·`fixtures.test.ts`·`select.test.ts`·`coverage.test.ts`·`generateLlm.test.ts`·`recordService.test.ts`, 보조 `fakeTarget.ts`, cli `cli.test.ts`·`plugin.test.ts`, mcp `tools.test.ts`·`plugin.test.ts`, ui-server `api.test.ts`, web `Verify.test.tsx`·`coverage.test.ts` |

---

## Task 0: 기준선 확인

**Files:** 없음(읽기만).

- [ ] **Step 1: 브랜치와 작업 트리 확인**

Run: `git -C /Users/geonho.yeom/workspace/specmock status --short && git -C /Users/geonho.yeom/workspace/specmock log --oneline -1`
Expected: 변경 없음, `0694437 …`(설계 문서 커밋) 또는 이 계획 문서 커밋.

- [ ] **Step 2: 타입 검사와 전체 테스트**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -8`
Expected: typecheck 오류 0, vitest 마지막 줄 `Tests  N passed`. **N을 적어 둔다**(이후 Task마다 N 이상이어야 한다). Java·JDK가 필요한 테스트가 skip으로 나오면 skip 수도 적는다.

- [ ] **Step 3: TS 스냅샷 위치와 해시 기록**

Run: `shasum packages/core/test/__snapshots__/snapshot.test.ts.snap`
Expected: 해시 한 줄. 적어 둔다. 이 파일은 마지막 Task까지 **바뀌면 안 된다**(`git diff --stat packages/core/test/__snapshots__`가 비어 있어야 함). 바뀌었다면 `-u`로 갱신하지 말고 원인을 찾는다.

커밋 없음.

---
## Task 1: contract 실행기 추출(`verify/contracts.ts`)

**Files:**
- Create: `packages/core/src/verify/contracts.ts`
- Modify: `packages/core/src/verify/index.ts:1-8`(import), `:47-83`(runContract 삭제), `:94-115`(호출부)
- Create: `packages/core/test/fakeTarget.ts`(가짜 실제 서버, 이후 Task도 씀)
- Test: `packages/core/test/contract-run.test.ts`

- [ ] **Step 1: 가짜 실제 서버 도우미 작성**

`packages/core/test/fakeTarget.ts`:
```ts
// packages/core/test/fakeTarget.ts
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface FakeReq { method: string; path: string; query: Record<string, string>; headers: IncomingHttpHeaders }
/** body가 있으면 JSON으로, raw가 있으면 그대로 보낸다. delayMs만큼 늦게 응답한다. */
export interface FakeRes { status: number; body?: unknown; raw?: string; contentType?: string; delayMs?: number; headers?: Record<string, string> }
export interface FakeTarget {
  url: string;
  requests: FakeReq[];
  /** 동시에 처리 중이던 요청 수의 최댓값. 순차 실행이면 1. */
  maxConcurrent: () => number;
  close: () => Promise<void>;
}

/** `listen(0, "127.0.0.1")` 가짜 실제 시스템. handler가 요청마다 응답을 정한다. */
export async function startFakeTarget(handler: (req: FakeReq) => FakeRes): Promise<FakeTarget> {
  const requests: FakeReq[] = [];
  let active = 0; let max = 0;
  const server: Server = createServer((req, res) => {
    active++; max = Math.max(max, active);
    const u = new URL(req.url ?? "/", "http://x");
    const fr: FakeReq = { method: req.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers };
    requests.push(fr);
    req.resume();
    req.on("end", () => {
      const out = handler(fr);
      setTimeout(() => {
        const text = out.raw ?? (out.body === undefined ? "" : JSON.stringify(out.body));
        res.writeHead(out.status, { "content-type": out.contentType ?? "application/json", "content-length": String(Buffer.byteLength(text)), ...out.headers });
        res.end(text, () => { active--; });
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    maxConcurrent: () => max,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** 열었다 닫은 포트. 연결 거부(ECONNREFUSED)를 재현한다. */
export async function closedPortUrl(): Promise<string> {
  const t = await startFakeTarget(() => ({ status: 200 }));
  await t.close();
  return t.url;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/core/test/contract-run.test.ts`:
```ts
// packages/core/test/contract-run.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { joinUrl, runContract } from "../src/verify/contracts.js";
import type { Contract } from "../src/types.js";
import { closedPortUrl, startFakeTarget, type FakeTarget } from "./fakeTarget.js";

let t: FakeTarget | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const PET = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
function contract(over: Partial<Contract["request"]> = {}, schema: Record<string, unknown> | null = PET, status = 200): Contract {
  return { featureId: "getPet", name: "정상 요청", request: { method: "GET", path: "/pets/1", headers: {}, query: {}, body: null, ...over }, expect: { status, schema } };
}

describe("joinUrl", () => {
  it("baseUrl 경로를 지우지 않고 끝 /를 하나로 맞춘다", () => {
    expect(joinUrl("https://h.example/v2", "/pets").toString()).toBe("https://h.example/v2/pets");
    expect(joinUrl("https://h.example/v2/", "/pets").toString()).toBe("https://h.example/v2/pets");
    expect(joinUrl("https://h.example/v2//", "/pets").toString()).toBe("https://h.example/v2/pets");
    expect(joinUrl("http://127.0.0.1:3000", "/pets/1").toString()).toBe("http://127.0.0.1:3000/pets/1");
  });

  it("query를 붙인다", () => {
    expect(joinUrl("https://h.example/v2", "/pets", { status: "available", limit: "2" }).toString()).toBe("https://h.example/v2/pets?status=available&limit=2");
  });
});

describe("runContract", () => {
  it("일치: status·스키마가 맞으면 errors가 비고 content-type·content-length만 남긴다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 }, headers: { "x-secret": "s" } }));
    const r = await runContract(t.url, contract());
    expect(r).toMatchObject({ status: 200, kind: "json", body: { id: 1 }, errors: [], schemaErrors: [], failure: null });
    expect(Object.keys(r.headers).sort()).toEqual(["content-length", "content-type"]);
  });

  it("스키마 오류는 verify와 같은 문구로 errors·schemaErrors에 들어간다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: "p-1" } }));
    const r = await runContract(t.url, contract());
    expect(r.schemaErrors).toEqual(["/id must be integer"]);
    expect(r.errors).toEqual(["/id must be integer"]);
  });

  it("status가 다르면 status 문구만 남기고 바디는 검증하지 않는다", async () => {
    t = await startFakeTarget(() => ({ status: 404, body: { message: "nope" } }));
    const r = await runContract(t.url, contract());
    expect(r.errors).toEqual(["status: expected 200, got 404"]);
    expect(r.schemaErrors).toEqual([]);
    expect(r.kind).toBe("json");
  });

  it("JSON이 아니면 raw, 비어 있으면 empty", async () => {
    t = await startFakeTarget((q) => (q.path === "/html" ? { status: 200, raw: "<html>x</html>", contentType: "text/html" } : { status: 200, raw: "" }));
    const raw = await runContract(t.url, contract({ path: "/html" }));
    expect(raw.kind).toBe("raw");
    expect(raw.body).toEqual({ raw: "<html>x</html>", contentType: "text/html" });
    expect(raw.errors).toEqual(["body is not JSON: <html>x</html>"]);
    const empty = await runContract(t.url, contract({ path: "/e" }, null));
    expect(empty).toMatchObject({ kind: "empty", body: null, errors: [] });
  });

  it("maxBytes를 넘으면 truncated이고 바디를 버린다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1, pad: "x".repeat(100) } }));
    const r = await runContract(t.url, contract(), { maxBytes: 50 });
    expect(r.kind).toBe("truncated");
    expect(r.body).toBeUndefined();
    expect(r.bytes).toBeGreaterThan(50);
    expect(r.schemaErrors).toEqual([]);
  });

  it("timeout과 연결 실패를 failure로 구별한다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 }, delayMs: 500 }));
    const slow = await runContract(t.url, contract(), { timeoutMs: 50 });
    expect(slow.status).toBeNull();
    expect(slow.failure?.kind).toBe("timeout");
    const refused = await runContract(await closedPortUrl(), contract());
    expect(refused.failure?.kind).toBe("network");
    expect(refused.errors[0]).toMatch(/^request failed: /);
  });

  it("opts.headers가 contract 헤더보다 우선하고 opts.path·query가 contract 값을 대신한다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 } }));
    await runContract(t.url, contract({ headers: { "x-a": "contract", "x-b": "b" } }), { headers: { "X-A": "target" }, path: "/pets/123", query: { q: "1" } });
    expect(t.requests[0]).toMatchObject({ path: "/pets/123", query: { q: "1" } });
    expect(t.requests[0].headers["x-a"]).toBe("target");
    expect(t.requests[0].headers["x-b"]).toBe("b");
  });

  it("사용자 취소(signal)는 failure가 아니라 예외로 올린다", async () => {
    t = await startFakeTarget(() => ({ status: 200, body: { id: 1 }, delayMs: 500 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(runContract(t.url, contract(), { signal: ac.signal })).rejects.toThrow();
  });
});
```

`"X-A"`와 `"x-a"`가 둘 다 들어가면 fetch가 한 헤더로 합친다(`"contract, target"`). 그래서 구현은 헤더 키를 소문자로 맞춘 뒤 합친다(아래 `mergeHeaders`).

- [ ] **Step 3: 실패 확인**

Run: `pnpm vitest run packages/core/test/contract-run.test.ts`
Expected: FAIL — `Failed to load url ../src/verify/contracts.js`(또는 `Cannot find module`).

- [ ] **Step 4: `verify/contracts.ts` 작성**

```ts
// packages/core/src/verify/contracts.ts
import type { Ajv } from "ajv";
import type { Contract } from "../types.js";
import { makeAjv } from "../util/ajv.js";

export interface ContractRunOptions {
  /** 모든 요청에 붙일 헤더. 같은 이름(대소문자 무시)의 contract 헤더보다 우선한다. */
  headers?: Record<string, string>;
  /** 요청당 제한(ms). 없으면 제한 없음(verify). */
  timeoutMs?: number;
  /** 사용자 취소. abort되면 failure가 아니라 예외로 거부한다. */
  signal?: AbortSignal;
  /** 여러 contract에 하나를 재사용한다. 없으면 새로 만든다. */
  ajv?: Ajv;
  /** 이 바이트 수를 넘는 바디는 kind "truncated"(본문 버림). 없으면 제한 없음. */
  maxBytes?: number;
  /** contract의 경로·쿼리 대신 쓸 값(record의 params 적용 결과). */
  path?: string;
  query?: Record<string, string>;
}

export type BodyKind = "json" | "raw" | "empty" | "truncated";

export interface ContractRun {
  url: string;
  /** 응답을 못 받았으면 null. */
  status: number | null;
  /** 응답 헤더 중 content-type·content-length만. */
  headers: Record<string, string>;
  kind: BodyKind | null;
  /** json: 파싱 값 · raw: { raw, contentType } · empty: null · truncated: undefined. */
  body: unknown;
  bytes: number;
  /** status가 기대와 같고 스키마가 있을 때의 바디 오류(비JSON 포함). */
  schemaErrors: string[];
  /** verify의 ContractResult.errors와 같은 문구·순서. */
  errors: string[];
  failure: { kind: "timeout" | "network"; message: string } | null;
}

const KEEP_HEADERS = ["content-type", "content-length"];

/** baseUrl 경로 뒤에 path를 붙인다. `new URL(path, base)`는 base의 `/v2`를 지우므로 쓰지 않는다. */
export function joinUrl(baseUrl: string, p: string, query: Record<string, string> = {}): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") + (p.startsWith("/") ? p : `/${p}`);
  url.search = "";
  url.hash = "";
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** 키를 소문자로 맞춰 합친다. 뒤의 것이 이긴다. */
function mergeHeaders(...parts: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k.toLowerCase()] = v;
  return out;
}

export async function runContract(baseUrl: string, c: Contract, opts: ContractRunOptions = {}): Promise<ContractRun> {
  const url = joinUrl(baseUrl, opts.path ?? c.request.path, opts.query ?? c.request.query);
  const errors: string[] = [];
  const schemaErrors: string[] = [];
  const run: ContractRun = { url: url.toString(), status: null, headers: {}, kind: null, body: undefined, bytes: 0, schemaErrors, errors, failure: null };
  let validate: ReturnType<Ajv["compile"]> | null = null;
  if (c.expect.schema) { try { validate = (opts.ajv ?? makeAjv()).compile(c.expect.schema); } catch (e) { errors.push(`schema: ${(e as Error).message}`); } }
  const signals = [opts.signal, opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter((s): s is AbortSignal => s !== undefined);
  try {
    const res = await fetch(url, {
      method: c.request.method,
      headers: mergeHeaders(c.request.body !== null ? { "content-type": "application/json" } : {}, c.request.headers, opts.headers ?? {}),
      body: c.request.body !== null ? JSON.stringify(c.request.body) : undefined,
      ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
    });
    run.status = res.status;
    for (const h of KEEP_HEADERS) { const v = res.headers.get(h); if (v !== null) run.headers[h] = v; }
    if (res.status !== c.expect.status) errors.push(`status: expected ${c.expect.status}, got ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    run.bytes = buf.byteLength;
    // TextDecoder는 res.text()처럼 UTF-8 BOM을 지운다.
    const text = opts.maxBytes !== undefined && run.bytes > opts.maxBytes ? null : new TextDecoder().decode(buf);
    if (text === null) run.kind = "truncated";
    else if (text === "") { run.kind = "empty"; run.body = null; }
    else {
      try { run.body = JSON.parse(text); run.kind = "json"; }
      catch { run.kind = "raw"; run.body = { raw: text, contentType: run.headers["content-type"] ?? "" }; }
    }
    if (validate && res.status === c.expect.status && text !== null) {
      if (run.kind === "json") {
        if (!validate(run.body)) schemaErrors.push(...(validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()));
      } else schemaErrors.push(`body is not JSON: ${text.slice(0, 200)}`);
      errors.push(...schemaErrors);
    }
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const err = e as Error & { cause?: { code?: string; message?: string } };
    errors.push(`request failed: ${err.message}`);
    run.failure = err.name === "TimeoutError"
      ? { kind: "timeout", message: err.message }
      : { kind: "network", message: err.cause?.code ?? err.cause?.message ?? err.message };
  }
  return run;
}
```

verify와의 동등성: 예전에는 "스키마 있음·status 같음"일 때만 바디를 읽었고, 지금은 항상 읽는다(mock 응답에는 영향 없음). `errors`의 문구와 순서(`schema:` → `status:` → 바디 → `request failed:`)는 그대로다. 헤더 키 소문자화는 HTTP상 같은 요청이다.

- [ ] **Step 5: verify가 새 모듈을 쓰게 수정**

`packages/core/src/verify/index.ts` 수정 전(:1-8):
```ts
import type { Ajv } from "ajv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readLock } from "../generate/lock.js";
import { ContractSchema, type Contract } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { runRuntimeChecks, type RuntimeCheck, type RuntimeSpec } from "./runtime.js";
import { startMock } from "./server.js";
```

수정 후:
```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readLock } from "../generate/lock.js";
import { ContractSchema, type Contract } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { runContract, type ContractRun } from "./contracts.js";
import { runRuntimeChecks, type RuntimeCheck, type RuntimeSpec } from "./runtime.js";
import { startMock } from "./server.js";
```

`:47-83`의 `async function runContract(base: string, ajv: Ajv, c: Contract): Promise<ContractResult> { … }` 전체를 지우고 그 자리에:
```ts
function toResult(c: Contract, r: ContractRun): ContractResult {
  return { featureId: c.featureId, name: c.name, passed: r.errors.length === 0, expectedStatus: c.expect.status, actualStatus: r.status, errors: r.errors };
}
```

`verify()` 루프 수정 전:
```ts
      results.push(await runContract(base, ajv, c));
```

수정 후:
```ts
      results.push(toResult(c, await runContract(base, c, { ajv })));
```

- [ ] **Step 6: 새 테스트와 회귀 테스트 통과 확인**

Run: `pnpm vitest run packages/core/test/contract-run.test.ts packages/core/test/e2e.test.ts packages/core/test/snapshot.test.ts packages/core/test/runtime.test.ts`
Expected: PASS 전부. 이어서 `pnpm -F @specmock/core typecheck` 오류 0.

- [ ] **Step 7: 전체 테스트**

Run: `pnpm test 2>&1 | tail -5`
Expected: 통과 수 = Task 0의 N + 10(새 테스트). 스냅샷 파일 변화 없음(`git diff --stat packages/core/test/__snapshots__` 비어 있음).

- [ ] **Step 8: 커밋**

```bash
git add packages/core/src/verify/contracts.ts packages/core/src/verify/index.ts packages/core/test/fakeTarget.ts packages/core/test/contract-run.test.ts
git commit -m "refactor(core): extract contract runner into verify/contracts.ts

record와 verify가 같은 판정을 쓰도록 runContract를 꺼내고 baseUrl 경로를
유지하는 joinUrl을 더한다. verify 결과 문구는 그대로다.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: 마스킹 보강(`maskHeaders`, query `&` 수정)

**Files:**
- Modify: `packages/core/src/ingest/mask.ts:9`(세 번째 패턴), 파일 끝(`maskHeaders` 추가)
- Modify: `packages/core/src/index.ts:7`(export)
- Test: `packages/core/test/mask.test.ts`(기존 4건 유지, 아래 describe 2개 추가)

- [ ] **Step 1: 실패하는 테스트 추가**

`packages/core/test/mask.test.ts` 맨 위 import 수정 전:
```ts
import { maskSecrets } from "../src/ingest/mask.js";
```

수정 후:
```ts
import { maskHeaders, maskSecrets } from "../src/ingest/mask.js";
```

파일 끝에 추가:
```ts
describe("maskSecrets query", () => {
  it("api_key 값만 가리고 뒤의 &x=1은 남긴다", () => {
    expect(maskSecrets("GET /pets?api_key=abcdefgh123&x=1")).toBe("GET /pets?api_key=***&x=1");
    expect(maskSecrets("/a?access_token=0123456789ab&limit=2&secret=zzzzzzzzzz")).toBe("/a?access_token=***&limit=2&secret=***");
  });
});

describe("maskHeaders", () => {
  it("키 이름만 보고 값 전체를 가리며 원래 키 대소문자를 지킨다", () => {
    expect(maskHeaders({
      Authorization: "Basic dXNlcjpwYXNz",
      cookie: "sid=1",
      "Set-Cookie": "a=b",
      "x-api-key": "k",
      token: "t",
      "X-Client-Secret": "s",
      "x-password-hint": "p",
      "X-Tenant": "dev",
      accept: "application/json",
    })).toEqual({
      Authorization: "***",
      cookie: "***",
      "Set-Cookie": "***",
      "x-api-key": "***",
      token: "***",
      "X-Client-Secret": "***",
      "x-password-hint": "***",
      "X-Tenant": "dev",
      accept: "application/json",
    });
  });

  it("빈 객체는 빈 객체", () => {
    expect(maskHeaders({})).toEqual({});
  });
});
```

`token`처럼 짧은 값(`"t"`)도 가린다 — `maskSecrets`의 8자 제한은 헤더에 적용하지 않는다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run packages/core/test/mask.test.ts`
Expected: FAIL — `maskHeaders is not a function`(또는 import 오류), query 테스트는 `"GET /pets?api_key=***"`를 받았다는 diff.

- [ ] **Step 3: 구현**

`packages/core/src/ingest/mask.ts` 수정 전(:9):
```ts
  [/(["']?(?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]{8,}/gi, "$1***"],
```

수정 후(문자 클래스에 `&` 하나 추가):
```ts
  [/(["']?(?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}&]{8,}/gi, "$1***"],
```

파일 끝에 추가:
```ts
const SECRET_HEADER_EXACT = new Set(["authorization", "cookie", "set-cookie"]);
const SECRET_HEADER_PART = ["key", "token", "secret", "password"];

/** 헤더 이름만 보고 값 전체를 가린다(값 길이·모양은 보지 않는다). 키 대소문자는 그대로 둔다. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => {
    const lower = k.toLowerCase();
    const secret = SECRET_HEADER_EXACT.has(lower) || SECRET_HEADER_PART.some((p) => lower.includes(p));
    return [k, secret ? "***" : v];
  }));
}
```

`packages/core/src/index.ts:7` 수정 전:
```ts
export { maskSecrets } from "./ingest/mask.js";
```

수정 후:
```ts
export { maskHeaders, maskSecrets } from "./ingest/mask.js";
```


- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run packages/core/test/mask.test.ts packages/core/test/ingest-mask-origin.test.ts packages/core/test/ingest.test.ts`
Expected: PASS(mask 4+3건, ingest 회귀 없음).

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/ingest/mask.ts packages/core/src/index.ts packages/core/test/mask.test.ts
git commit -m "feat(core): add maskHeaders and stop query masking at &

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 3: target.json 읽기(`record/target.ts`)와 params 적용

**Files:**
- Create: `packages/core/src/record/target.ts`
- Modify: `packages/core/src/select/contracts.ts:23-27`(`fillPath`에 덮어쓰기 인자)
- Test: `packages/core/test/target.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/core/test/target.test.ts`:
```ts
// packages/core/test/target.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyParams, readTarget, substituteEnv, TARGET_EXAMPLE, TARGET_FILE } from "../src/record/target.js";
import { fillPath } from "../src/select/contracts.js";
import type { Contract, Feature } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string;
let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-target-")); ws = new Workspace(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function put(text: string): Promise<void> {
  const file = ws.file("pets", TARGET_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("substituteEnv", () => {
  it("있음·여러 개·한 값에 둘을 치환하고 ${가 없으면 그대로", () => {
    const env = { A: "1", B: "two" };
    expect(substituteEnv("Bearer ${A}", env)).toBe("Bearer 1");
    expect(substituteEnv("${A}:${B}", env)).toBe("1:two");
    expect(substituteEnv("plain", env)).toBe("plain");
  });

  it("없는 변수는 이름만 담아 던진다", () => {
    expect(() => substituteEnv("Bearer ${PETS_TOKEN}", {})).toThrow("환경변수 PETS_TOKEN이 없습니다");
  });
});

describe("readTarget", () => {
  it("baseUrl 끝 /를 지우고 헤더 env를 치환하며 기본 timeout 15000", async () => {
    await put(JSON.stringify({ baseUrl: "https://api.example.com/v2/", headers: { Authorization: "Bearer ${T}" }, params: { petId: "123" } }));
    const t = await readTarget(ws, "pets", { T: "tok" });
    expect(t).toEqual({ file: ws.file("pets", TARGET_FILE), baseUrl: "https://api.example.com/v2", headers: { Authorization: "Bearer tok" }, params: { petId: "123" }, timeoutMs: 15000 });
  });

  it("파일이 없으면 예시 JSON을 담은 오류", async () => {
    await expect(readTarget(ws, "pets", {})).rejects.toThrow(TARGET_EXAMPLE);
  });

  it("JSON 파싱 실패는 원문을 싣지 않는다", async () => {
    await put('{"baseUrl": "https://x", "headers": {"Authorization": "Bearer SECRET_VALUE_123"');
    const err = await readTarget(ws, "pets", {}).catch((e: Error) => e);
    expect((err as Error).message).toContain("JSON 파싱 실패");
    expect((err as Error).message).not.toContain("SECRET_VALUE_123");
  });

  it("모르는 키·잘못된 값은 필드 이름만 출력", async () => {
    await put(JSON.stringify({ baseUrl: "ftp://x", header: { Authorization: "Bearer SECRET_VALUE_123" }, timeoutMs: -1 }));
    const err = (await readTarget(ws, "pets", {}).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("형식 오류");
    expect(err.message).toContain("baseUrl");
    expect(err.message).toContain("header");
    expect(err.message).toContain("timeoutMs");
    expect(err.message).not.toContain("SECRET_VALUE_123");
  });

  it("baseUrl의 query·hash·계정 정보를 거부한다", async () => {
    for (const baseUrl of ["https://x.example/v2?k=1", "https://x.example/#a", "https://u:p@x.example"]) {
      await put(JSON.stringify({ baseUrl }));
      await expect(readTarget(ws, "pets", {})).rejects.toThrow("baseUrl");
    }
  });

  it("환경변수가 없으면 이름만", async () => {
    await put(JSON.stringify({ baseUrl: "https://x.example", headers: { Authorization: "Bearer ${PETS_TOKEN}" } }));
    await expect(readTarget(ws, "pets", {})).rejects.toThrow("환경변수 PETS_TOKEN이 없습니다");
  });
});

const FEATURE: Feature = {
  id: "getPet", group: "pets", title: "", summary: "", method: "GET", path: "/pets/{petId}",
  request: {
    params: { petId: { required: true, schema: { type: "integer" } } },
    query: { status: { required: false, schema: { type: "string" } } },
    headers: {}, body: null,
  },
  responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
} as Feature;
const CONTRACT: Contract = { featureId: "getPet", name: "정상 요청", request: { method: "GET", path: "/pets/1", headers: {}, query: { limit: "1" }, body: null }, expect: { status: 200, schema: null } };

describe("fillPath 덮어쓰기와 applyParams", () => {
  it("fillPath는 덮어쓴 값도 인코딩한다", () => {
    expect(fillPath(FEATURE)).toBe("/pets/1");
    expect(fillPath(FEATURE, { petId: "a b" })).toBe("/pets/a%20b");
  });

  it("경로·쿼리 파라미터를 같은 이름만 덮어쓴다", () => {
    expect(applyParams(FEATURE, CONTRACT, { petId: "123", status: "available", limit: "5", other: "x" }))
      .toEqual({ path: "/pets/123", query: { limit: "5", status: "available" } });
  });

  it("params가 없거나 feature를 못 찾으면 contract 값 그대로", () => {
    expect(applyParams(FEATURE, CONTRACT, {})).toEqual({ path: "/pets/1", query: { limit: "1" } });
    expect(applyParams(undefined, CONTRACT, { petId: "9" })).toEqual({ path: "/pets/1", query: { limit: "1" } });
  });
});
```

`ParamSchema`는 `{ schema, required }`(`types.ts:19-22`), `sampleScalar({ type: "integer" })`는 `"1"`(`select/contracts.ts:12`)이라 `fillPath(FEATURE)`는 `/pets/1`이다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run packages/core/test/target.test.ts`
Expected: FAIL — `Failed to load url ../src/record/target.js`.

- [ ] **Step 3: `fillPath` 덮어쓰기 인자**

`packages/core/src/select/contracts.ts:23-27` 수정 전:
```ts
export function fillPath(feature: Feature): string {
  return feature.path.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    encodeURIComponent(sampleScalar(feature.request.params[name]?.schema ?? null)),
  );
}
```

수정 후:
```ts
/** `{name}`을 overrides 값(있으면) 또는 스키마 샘플로 채운다. 기존 호출(인자 하나)은 결과가 같다. */
export function fillPath(feature: Feature, overrides: Record<string, string> = {}): string {
  return feature.path.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    encodeURIComponent(Object.hasOwn(overrides, name) ? overrides[name] : sampleScalar(feature.request.params[name]?.schema ?? null)),
  );
}
```

- [ ] **Step 4: `record/target.ts` 작성**

```ts
// packages/core/src/record/target.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { fillPath } from "../select/contracts.js";
import type { Contract, Feature } from "../types.js";
import type { Workspace } from "../workspace.js";

export const TARGET_FILE = "target.json";
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 오류 메시지·Web 안내에 그대로 싣는 예시. `${PETS_TOKEN}`은 문자 그대로다(템플릿 리터럴 아님). */
export const TARGET_EXAMPLE = JSON.stringify({
  baseUrl: "https://api.example.com/v2",
  headers: { Authorization: "Bearer ${PETS_TOKEN}" },
  params: { petId: "123" },
  timeoutMs: 15000,
}, null, 2);

function checkBaseUrl(v: string): boolean {
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  return (u.protocol === "http:" || u.protocol === "https:") && u.search === "" && u.hash === "" && u.username === "" && u.password === "";
}

export const TargetSchema = z.strictObject({
  baseUrl: z.string().refine(checkBaseUrl, "http(s) URL이어야 하고 query·#·계정 정보를 넣을 수 없습니다"),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export interface Target {
  file: string;
  /** 끝 `/`를 지운 값. */
  baseUrl: string;
  /** `${ENV}` 치환을 마친 값. 화면·로그에 싣지 않는다. */
  headers: Record<string, string>;
  params: Record<string, string>;
  timeoutMs: number;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `${NAME}`을 env[NAME]으로 바꾼다. 없으면 이름만 담아 던진다. */
export function substituteEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_REF, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`환경변수 ${name}이 없습니다`);
    return v;
  });
}

/** target.json을 읽는다. 어떤 오류 메시지에도 파일 원문·헤더 값을 싣지 않는다. */
export async function readTarget(ws: Workspace, system: string, env: Record<string, string | undefined> = process.env): Promise<Target> {
  const file = ws.file(system, TARGET_FILE);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${file}이(가) 없습니다. 실제 시스템 주소를 적어 만드세요(비밀 값은 \${환경변수}로만):\n${TARGET_EXAMPLE}`);
    }
    throw e;
  }
  let raw: unknown;
  // Node의 JSON 파싱 오류 문구는 원문 조각을 인용하므로 그대로 싣지 않는다.
  try { raw = JSON.parse(text); } catch { throw new Error(`${file}: JSON 파싱 실패. 문법을 확인하세요.`); }
  const parsed = TargetSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = new Set<string>();
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") for (const k of issue.keys) fields.add([...issue.path, k].join("."));
      else fields.add(issue.path.join(".") || "(최상위)");
    }
    throw new Error(`${file}: 형식 오류. 확인할 필드: ${[...fields].join(", ")} (모르는 키는 거부합니다)`);
  }
  const t = parsed.data;
  const headers = Object.fromEntries(Object.entries(t.headers ?? {}).map(([k, v]) => [k, substituteEnv(v, env)]));
  return { file, baseUrl: t.baseUrl.replace(/\/+$/, ""), headers, params: t.params ?? {}, timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

/** params를 contract에 적용한 경로·쿼리. 쿼리는 contract에 있거나 feature에 선언된 이름만 덮어쓴다. */
export function applyParams(feature: Feature | undefined, c: Contract, params: Record<string, string>): { path: string; query: Record<string, string> } {
  if (!feature || Object.keys(params).length === 0) return { path: c.request.path, query: { ...c.request.query } };
  const query = { ...c.request.query };
  for (const [k, v] of Object.entries(params)) {
    if (Object.hasOwn(query, k) || Object.hasOwn(feature.request.query, k)) query[k] = v;
  }
  return { path: fillPath(feature, params), query };
}
```

`fillPath` 재계산은 contract의 `path`가 `fillPath(feature)`로 만들어졌다는 사실(`select/contracts.ts:44`)에 기댄다. params에 경로 이름이 없으면 결과가 contract의 경로와 같다.

- [ ] **Step 5: 통과 확인**

Run: `pnpm vitest run packages/core/test/target.test.ts packages/core/test/contracts.test.ts packages/core/test/select.test.ts`
Expected: PASS(target 11건, 기존 contracts·select 회귀 없음). `pnpm -F @specmock/core typecheck` 오류 0(`issue.keys`는 zod v4의 `unrecognized_keys` 이슈 필드다).

- [ ] **Step 6: 커밋**

```bash
git add packages/core/src/record/target.ts packages/core/src/select/contracts.ts packages/core/test/target.test.ts
git commit -m "feat(core): read target.json with env substitution and param overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 4: 녹화 파일 형식·`specInputHash`·drift.md 렌더

**Files:**
- Modify: `packages/core/src/types.ts:96-100`(뒤에 `RecordedSchema` 추가. `FixtureSchema.source`는 Task 6에서 바꾼다)
- Create: `packages/core/src/util/specHash.ts`
- Create: `packages/core/src/record/recorded.ts`
- Create: `packages/core/src/record/drift.ts`
- Test: `packages/core/test/drift.test.ts`(drift·recorded·specInputHash 단위)

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/core/test/drift.test.ts`:
```ts
// packages/core/test/drift.test.ts
import { describe, expect, it } from "vitest";
import { renderDrift, statusHint, type DriftEntry } from "../src/record/drift.js";
import { isSafeFeatureId, recordedName } from "../src/record/recorded.js";
import type { MockSpec } from "../src/types.js";
import { featureInputHash, specInputHash } from "../src/util/specHash.js";

const AT = new Date(2026, 10, 9, 10, 0); // 로컬 2026-11-09 10:00

describe("renderDrift", () => {
  it("집계 줄과 절 구조", () => {
    const entries: DriftEntry[] = [
      { kind: "matched", featureId: "listPets", method: "GET", path: "/pets" },
      { kind: "matched", featureId: "inventory.list", method: "GET", path: "/store/inventory" },
      { kind: "drifted", featureId: "getPet", method: "GET", path: "/pets/123", status: 200, errors: ["/id must be integer"] },
      { kind: "statusMismatch", featureId: "getOrder", method: "GET", path: "/orders/1", expected: 200, actual: 401, hint: "인증 헤더를 확인하세요" },
      { kind: "skipped", featureId: "createPet", method: "POST", path: "/pets" },
    ];
    expect(renderDrift("pets", "https://api.example.com/v2", AT, entries)).toBe([
      "# pets 실제 시스템 대조 (2026-11-09 10:00, https://api.example.com/v2)",
      "요청 5 · 일치 2 · 스펙과 다름 1 · 상태 불일치 1 · 건너뜀(변경 요청) 1 · 실패 0",
      "",
      "## 스펙과 다름",
      "- getPet GET /pets/123 → 200. /id must be integer",
      "",
      "## 상태 불일치",
      "- getOrder GET /orders/1 → 기대 200, 실제 401. 인증 헤더를 확인하세요",
      "",
      "## 건너뜀",
      "- createPet POST /pets — 변경 요청. `--allow-mutating`으로 포함",
      "",
      "## 실패",
      "(없음)",
      "",
    ].join("\n"));
  });

  it("오류 문구와 경로의 비밀을 가린다", () => {
    const md = renderDrift("pets", "https://x.example", AT, [
      { kind: "failed", featureId: "a", method: "GET", path: "/a?api_key=abcdefgh123&x=1", reason: "연결 실패: Bearer abcdefghijklmnopqrstuvwxyz" },
    ]);
    expect(md).toContain("- a GET /a?api_key=***&x=1 — 연결 실패: Bearer ***");
    expect(md).not.toContain("abcdefgh123");
    expect(md).toContain("## 스펙과 다름\n(없음)");
  });

  it("statusHint", () => {
    expect(statusHint(401)).toBe("인증 헤더를 확인하세요");
    expect(statusHint(403)).toBe("인증 헤더를 확인하세요");
    expect(statusHint(404)).toBe("`target.json`의 `params`로 실제 값을 지정하세요");
    expect(statusHint(500)).toBeUndefined();
  });
});

describe("recordedName", () => {
  it("안전한 id만 파일 이름이 된다", () => {
    expect(recordedName("inventory.list")).toBe("recorded/inventory.list.json");
    expect(recordedName("주문_조회-2")).toBe("recorded/주문_조회-2.json");
    for (const bad of ["..", ".", "a/b", "a\\b", "", "a b"]) expect(isSafeFeatureId(bad)).toBe(false);
    expect(() => recordedName("../x")).toThrow("녹화 파일 이름으로 쓸 수 없는 기능 id");
  });
});

describe("specInputHash", () => {
  const base: MockSpec = {
    system: "pets", baseUrl: "/", notMocked: [], contracts: [], assumptions: ["a"],
    features: [{
      id: "getPet", group: "pets", title: "", summary: "", method: "GET", path: "/pets/{petId}",
      request: { params: {}, query: {}, headers: {}, body: null }, responses: {}, auth: "none", provenance: "openapi",
      confidence: 1, hasExample: false, evidence: [], notes: [],
      fixtures: [{ status: 200, body: { id: 1 }, source: "schema-generated" }],
    }],
  };

  it("fixture 본문·출처·assumptions가 바뀌어도 같고, status나 기능이 바뀌면 다르다", () => {
    const h = specInputHash(base);
    const recorded = { ...base, assumptions: [], features: [{ ...base.features[0], fixtures: [{ status: 200, body: { id: "p-1" }, source: "spec-example" as const }] }] };
    expect(specInputHash(recorded)).toBe(h);
    const otherStatus = { ...base, features: [{ ...base.features[0], fixtures: [{ status: 201, body: {}, source: "empty" as const }] }] };
    expect(specInputHash(otherStatus)).not.toBe(h);
    expect(specInputHash({ ...base, features: [{ ...base.features[0], path: "/pets/{id}" }] })).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("featureInputHash는 그 기능만 본다", () => {
    const h = featureInputHash(base, "getPet");
    expect(featureInputHash({ ...base, notMocked: [{ id: "x", method: "GET", path: "/x" }] }, "getPet")).toBe(h);
    expect(featureInputHash({ ...base, features: [{ ...base.features[0], fixtures: [{ status: 200, body: "other", source: "empty" as const }] }] }, "getPet")).toBe(h);
    expect(featureInputHash({ ...base, features: [{ ...base.features[0], method: "HEAD" }] }, "getPet")).not.toBe(h);
  });
});
```

`source: "spec-example"`을 쓰는 이유: `"recorded"`는 Task 6에서 enum에 들어간다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run packages/core/test/drift.test.ts`
Expected: FAIL — `Failed to load url ../src/record/drift.js`.

- [ ] **Step 3: `RecordedSchema` 추가**

`packages/core/src/types.ts`의 `export type Fixture = z.infer<typeof FixtureSchema>;`(:101) 바로 뒤에 추가:
```ts
/** `.specmock/<system>/recorded/<featureId>.json` — record가 쓴다(설계 3B §3.2). */
export const RecordedSchema = z.object({
  featureId: z.string().min(1),
  recordedAt: z.string(),
  /** 녹화 시점 mockspec의 featureInputHash(그 기능만, fixture 본문 제외). */
  mockspecHash: z.string(),
  request: z.object({
    method: HttpMethod,
    path: z.string(),
    query: z.record(z.string(), z.string()),
    /** maskHeaders를 거친 값. 재전송용이 아니다. */
    headers: z.record(z.string(), z.string()),
  }),
  response: z.object({
    status: z.number().int(),
    /** json: body가 파싱 값 · raw: body가 { raw, contentType } · empty: body null · truncated: body 없음. */
    kind: z.enum(["json", "raw", "empty", "truncated"]),
    /** content-type·content-length만. */
    headers: z.record(z.string(), z.string()),
    body: z.unknown().optional(),
    truncated: z.literal(true).optional(),
    bytes: z.number().int().nonnegative(),
  }),
  contract: z.object({
    expectedStatus: z.number().int(),
    statusMatch: z.boolean(),
    schemaErrors: z.array(z.string()),
  }),
});
export type Recorded = z.infer<typeof RecordedSchema>;
```

`types.ts`는 `export * from "./types.js"`로 이미 공개되므로 index 수정은 없다.

- [ ] **Step 4: `util/specHash.ts`**

```ts
// packages/core/src/util/specHash.ts
import type { MockSpec } from "../types.js";
import { hashJson } from "./hash.js";

/**
 * 생성기 입력으로서의 mockspec 해시. fixture는 status 목록만 남기고(본문·출처 제외) assumptions는 뺀다.
 * LLM 지시서는 fixture 본문을 싣지 않으므로(generate/request.ts) 이 값이 같으면 생성 소스도 같다.
 */
export function specInputHash(spec: MockSpec): string {
  return hashJson({
    system: spec.system,
    baseUrl: spec.baseUrl,
    features: spec.features.map(({ fixtures, ...f }) => ({ ...f, fixtures: fixtures.map((x) => x.status) })),
    notMocked: spec.notMocked,
    contracts: spec.contracts,
  });
}

/** 녹화 파일의 mockspecHash. 한 기능(fixture는 status만)과 그 기능의 contract만 본다. 다른 기능 선택이 바뀌어도 그대로다. */
export function featureInputHash(spec: MockSpec, featureId: string): string {
  const f = spec.features.find((x) => x.id === featureId);
  return hashJson({
    system: spec.system,
    feature: f ? { ...f, fixtures: f.fixtures.map((x) => x.status) } : null,
    contracts: spec.contracts.filter((c) => c.featureId === featureId),
  });
}
```

- [ ] **Step 5: `record/recorded.ts`**

```ts
// packages/core/src/record/recorded.ts
import { rm } from "node:fs/promises";
import { RecordedSchema, type Recorded } from "../types.js";
import type { Workspace } from "../workspace.js";

export const RECORDED_DIR = "recorded";
const SAFE_ID = /^[\p{L}\p{N}_.-]+$/u;

/** 경로 구분자·공백 없이 글자·숫자·`_.-`만, `.`·`..`은 안 된다. */
export function isSafeFeatureId(id: string): boolean {
  return SAFE_ID.test(id) && id !== "." && id !== "..";
}

export function recordedName(featureId: string): string {
  if (!isSafeFeatureId(featureId)) throw new Error(`녹화 파일 이름으로 쓸 수 없는 기능 id: ${featureId}`);
  return `${RECORDED_DIR}/${featureId}.json`;
}

/** 없으면 null. 형식이 깨졌으면 ws.read의 오류를 그대로 던진다. 안전하지 않은 id는 null. */
export async function readRecorded(ws: Workspace, system: string, featureId: string): Promise<Recorded | null> {
  if (!isSafeFeatureId(featureId)) return null;
  const name = recordedName(featureId);
  if (!(await ws.exists(system, name))) return null;
  return ws.read(system, name, RecordedSchema);
}

export async function clearRecorded(ws: Workspace, system: string): Promise<void> {
  await rm(ws.file(system, RECORDED_DIR), { recursive: true, force: true });
}
```

- [ ] **Step 6: `record/drift.ts`**

```ts
// packages/core/src/record/drift.ts
import { maskSecrets } from "../ingest/mask.js";
import type { HttpMethod } from "../types.js";

interface Base { featureId: string; method: HttpMethod; path: string }
export type DriftEntry =
  | (Base & { kind: "matched" })
  | (Base & { kind: "drifted"; status: number; errors: string[] })
  | (Base & { kind: "statusMismatch"; expected: number; actual: number; hint?: string })
  | (Base & { kind: "skipped" })
  | (Base & { kind: "failed"; reason: string });

export const DRIFT_FILE = "drift.md";

export function statusHint(status: number): string | undefined {
  if (status === 401 || status === 403) return "인증 헤더를 확인하세요";
  if (status === 404) return "`target.json`의 `params`로 실제 값을 지정하세요";
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** drift.md 본문. 문자열 전체를 maskSecrets에 통과시킨다. baseUrl은 계정 정보·query가 없음을 target.ts가 보장한다. */
export function renderDrift(system: string, baseUrl: string, at: Date, entries: DriftEntry[]): string {
  const of = <K extends DriftEntry["kind"]>(k: K) => entries.filter((e): e is Extract<DriftEntry, { kind: K }> => e.kind === k);
  const drifted = of("drifted"), mismatch = of("statusMismatch"), skipped = of("skipped"), failed = of("failed");
  const head = (e: Base) => `- ${e.featureId} ${e.method} ${e.path}`;
  const section = (title: string, lines: string[]) => [`## ${title}`, ...(lines.length ? lines : ["(없음)"]), ""];
  const lines = [
    `# ${system} 실제 시스템 대조 (${localStamp(at)}, ${baseUrl})`,
    `요청 ${entries.length} · 일치 ${of("matched").length} · 스펙과 다름 ${drifted.length} · 상태 불일치 ${mismatch.length} · 건너뜀(변경 요청) ${skipped.length} · 실패 ${failed.length}`,
    "",
    ...section("스펙과 다름", drifted.map((e) => `${head(e)} → ${e.status}. ${e.errors.join("; ")}`)),
    ...section("상태 불일치", mismatch.map((e) => `${head(e)} → 기대 ${e.expected}, 실제 ${e.actual}.${e.hint ? ` ${e.hint}` : ""}`)),
    ...section("건너뜀", skipped.map((e) => `${head(e)} — 변경 요청. \`--allow-mutating\`으로 포함`)),
    ...section("실패", failed.map((e) => `${head(e)} — ${e.reason}`)),
  ];
  return maskSecrets(lines.join("\n"));
}
```

- [ ] **Step 7: 통과 확인**

Run: `pnpm vitest run packages/core/test/drift.test.ts packages/core/test/types.test.ts`
Expected: PASS(drift 6건). `pnpm -F @specmock/core typecheck` 오류 0.

- [ ] **Step 8: 커밋**

```bash
git add packages/core/src/types.ts packages/core/src/util/specHash.ts packages/core/src/record/recorded.ts packages/core/src/record/drift.ts packages/core/test/drift.test.ts
git commit -m "feat(core): add recorded file schema, specInputHash and drift renderer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 5: `record()` — 대상 선택·순차 실행·분류·녹화 파일·drift.md

**Files:**
- Create: `packages/core/src/record/index.ts`
- Modify: `packages/core/src/service/events.ts:1`(`"record"` stage. 서비스 Task 8보다 먼저 필요해서 여기서 바꾼다)
- Modify: `packages/core/test/fakeTarget.ts`(`FakeRes.destroy` — 연결 끊김 재현)
- Test: `packages/core/test/record.test.ts`

- [ ] **Step 1: 가짜 서버에 연결 끊기 옵션 추가**

`packages/core/test/fakeTarget.ts` 수정 전:
```ts
export interface FakeRes { status: number; body?: unknown; raw?: string; contentType?: string; delayMs?: number; headers?: Record<string, string> }
```

수정 후:
```ts
export interface FakeRes { status: number; body?: unknown; raw?: string; contentType?: string; delayMs?: number; headers?: Record<string, string>; /** true면 응답 없이 소켓을 끊는다(연결 실패 재현). */ destroy?: boolean }
```

`setTimeout` 콜백 첫 줄에 추가(수정 전 첫 줄은 `const text = out.raw ?? …`):
```ts
        if (out.destroy) { active--; res.socket?.destroy(); return; }
```

- [ ] **Step 2: stage 추가**

`packages/core/src/service/events.ts:1` 수정 전:
```ts
export type ServiceStage = "ingest" | "analyze" | "extract" | "merge" | "select" | "generate" | "verify" | "generating" | "building" | "verifying";
```

수정 후:
```ts
export type ServiceStage = "ingest" | "analyze" | "extract" | "merge" | "select" | "generate" | "verify" | "generating" | "building" | "verifying" | "record";
```

- [ ] **Step 3: 실패하는 테스트 작성**

`packages/core/test/record.test.ts`(petstore 기능 id: `listPets` GET /pets, `getPet` GET /pets/{petId}, `createPet` POST /pets(201), `deletePet` DELETE /pets/{petId}(204), `inventory.list` GET /store/inventory):
```ts
// packages/core/test/record.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { record } from "../src/record/index.js";
import type { Target } from "../src/record/target.js";
import { select } from "../src/select/index.js";
import type { ServiceEvent } from "../src/service/events.js";
import { MockSpecSchema, RecordedSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { closedPortUrl, startFakeTarget, type FakeReq, type FakeRes, type FakeTarget } from "./fakeTarget.js";
import { PETSTORE } from "./helpers.js";

const SYS = "petstore";
let dir: string;
let ws: Workspace;
let spec: MockSpec;
let t: FakeTarget | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-record-"));
  ws = new Workspace(dir);
  await ingest(ws, SYS, [PETSTORE]);
  await analyze(ws, SYS);
  await select(ws, SYS, ["all"]);
  spec = await ws.read(SYS, "mockspec.json", MockSpecSchema);
});
afterEach(async () => { await t?.close(); t = undefined; await rm(dir, { recursive: true, force: true }); });

const PET = { id: 1, name: "Rex" };
/** 스펙대로 응답하는 실제 시스템. */
function ok(q: FakeReq): FakeRes {
  if (q.method === "POST") return { status: 201, body: PET };
  if (q.method === "DELETE") return { status: 204 };
  if (q.path === "/pets") return { status: 200, body: [PET] };
  if (q.path.startsWith("/pets/")) return { status: 200, body: PET };
  if (q.path === "/store/inventory") return { status: 200, body: { available: 3 } };
  return { status: 404 };
}
const target = (url: string, over: Partial<Target> = {}): Target => ({ file: "target.json", baseUrl: `${url}/v2`, headers: { Authorization: "Bearer secret-token-123456", "X-Tenant": "dev" }, params: {}, timeoutMs: 2000, ...over });
const strip = (handler: (q: FakeReq) => FakeRes) => (q: FakeReq) => handler({ ...q, path: q.path.replace(/^\/v2/, "") });

describe("record", () => {
  it("기본: GET만 순차로 보내고 변경 요청은 건너뛰며 녹화 파일·drift.md를 쓴다", async () => {
    t = await startFakeTarget(strip(ok));
    const events: ServiceEvent[] = [];
    const { result, driftMarkdown } = await record(ws, SYS, spec, target(t.url), { onEvent: (e) => events.push(e) });
    expect(result.matched.sort()).toEqual(["getPet", "inventory.list", "listPets"]);
    expect(result.skipped.map((s) => s.featureId).sort()).toEqual(["createPet", "deletePet"]);
    expect(result.skipped[0].reason).toBe("mutating");
    expect(result.recorded.sort()).toEqual(["getPet", "inventory.list", "listPets"]);
    expect(result.applied).toBeNull();
    expect(t.requests.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
    expect(t.requests.every((r) => r.path.startsWith("/v2/"))).toBe(true);
    expect(t.requests[0].headers.authorization).toBe("Bearer secret-token-123456");
    expect(t.maxConcurrent()).toBe(1);
    expect(events.filter((e) => e.stage === "record")).toHaveLength(5);
    expect(events[events.length - 1]).toMatchObject({ done: 5, total: 5 });
    const rec = await ws.read(SYS, "recorded/getPet.json", RecordedSchema);
    expect(rec.request.headers).toEqual({ authorization: "***", "x-tenant": "dev" });
    expect(rec.response).toMatchObject({ status: 200, kind: "json", body: PET });
    expect(rec.contract).toEqual({ expectedStatus: 200, statusMatch: true, schemaErrors: [] });
    expect(result.driftPath).toBe(ws.file(SYS, "drift.md"));
    expect(await readFile(result.driftPath, "utf8")).toBe(driftMarkdown);
    expect(driftMarkdown).toContain("요청 5 · 일치 3 · 스펙과 다름 0 · 상태 불일치 0 · 건너뜀(변경 요청) 2 · 실패 0");
    expect(driftMarkdown).not.toContain("secret-token");
  });

  it("스키마 다름·401·비JSON을 나누고 params로 경로를 바꾼다", async () => {
    t = await startFakeTarget(strip((q) => {
      if (q.path === "/pets") return { status: 401, body: { message: "no" } };
      if (q.path === "/pets/123") return { status: 200, body: { id: "p-123", name: "Nabi" } };
      return { status: 200, raw: "<html>hi</html>", contentType: "text/html" };
    }));
    const { result, driftMarkdown } = await record(ws, SYS, spec, target(t.url, { params: { petId: "123" } }));
    expect(result.drifted).toEqual([{ featureId: "getPet", errors: ["/id must be integer"] }]);
    expect(result.statusMismatch).toEqual([{ featureId: "listPets", expected: 200, actual: 401, hint: "인증 헤더를 확인하세요" }]);
    expect(result.failed).toEqual([{ featureId: "inventory.list", reason: "바디가 JSON이 아닙니다(content-type: text/html)" }]);
    expect(result.recorded.sort()).toEqual(["getPet", "inventory.list", "listPets"]);
    const raw = await ws.read(SYS, "recorded/inventory.list.json", RecordedSchema);
    expect(raw.response).toMatchObject({ kind: "raw", body: { raw: "<html>hi</html>", contentType: "text/html" } });
    expect(driftMarkdown).toContain("- getPet GET /pets/123 → 200. /id must be integer");
  });

  it("404 힌트와 1MB 초과(truncated)", async () => {
    t = await startFakeTarget(strip((q) => (q.path === "/pets" ? { status: 404 } : q.path.startsWith("/pets/") ? { status: 200, body: { id: 1, name: "x".repeat(1_100_000) } } : ok(q))));
    const { result } = await record(ws, SYS, spec, target(t.url));
    expect(result.statusMismatch[0]).toMatchObject({ featureId: "listPets", actual: 404, hint: "`target.json`의 `params`로 실제 값을 지정하세요" });
    expect(result.failed[0].featureId).toBe("getPet");
    expect(result.failed[0].reason).toMatch(/^응답이 1MB를 넘어 저장하지 않았습니다\(\d+바이트\)$/);
    const rec = await ws.read(SYS, "recorded/getPet.json", RecordedSchema);
    expect(rec.response).toMatchObject({ kind: "truncated", truncated: true });
    expect(rec.response.body).toBeUndefined();
  });

  it("timeout과 두 번째 이후 연결 끊김은 실패로 적고 계속한다", async () => {
    let n = 0;
    t = await startFakeTarget(strip((q) => { n++; return n === 2 ? { status: 200, destroy: true } : n === 3 ? { ...ok(q), delayMs: 500 } : ok(q); }));
    const { result } = await record(ws, SYS, spec, target(t.url, { timeoutMs: 100 }));
    expect(result.failed).toHaveLength(2);
    expect(result.failed.map((f) => f.reason).sort()).toEqual([expect.stringMatching(/^연결 실패: /), "시간 초과(100ms)"].sort());
    expect(result.matched).toHaveLength(1);
    expect(result.recorded).toHaveLength(1);
  });

  it("첫 요청 연결 실패는 중단하고 drift.md를 쓰지 않는다", async () => {
    await expect(record(ws, SYS, spec, target(await closedPortUrl()))).rejects.toThrow("baseUrl을 확인하세요");
    expect(await ws.exists(SYS, "drift.md")).toBe(false);
  });

  it("allowMutating이면 POST·DELETE도 보낸다", async () => {
    t = await startFakeTarget(strip(ok));
    const { result } = await record(ws, SYS, spec, target(t.url), { allowMutating: true });
    expect(result.skipped).toEqual([]);
    expect(result.matched.sort()).toEqual(["createPet", "deletePet", "getPet", "inventory.list", "listPets"]);
    expect(t.requests.map((r) => r.method).sort()).toEqual(["DELETE", "GET", "GET", "GET", "POST"]);
  });

  it("features로 고르고 모르는 id는 요청 전에 거부한다", async () => {
    t = await startFakeTarget(strip(ok));
    await expect(record(ws, SYS, spec, target(t.url), { features: ["getPet", "nope"] })).rejects.toThrow("알 수 없는 기능 id: nope");
    expect(t.requests).toHaveLength(0);
    const { result } = await record(ws, SYS, spec, target(t.url), { features: ["getPet"] });
    expect(result.matched).toEqual(["getPet"]);
    expect(t.requests).toHaveLength(1);
  });

  it("refresh는 기존 녹화를 지우고, 없으면 대상만 덮어쓴다", async () => {
    t = await startFakeTarget(strip(ok));
    await ws.writeText(SYS, "recorded/old.json", "{}");
    await record(ws, SYS, spec, target(t.url), { features: ["getPet"] });
    expect(await ws.exists(SYS, "recorded/old.json")).toBe(true);
    await record(ws, SYS, spec, target(t.url), { features: ["getPet"], refresh: true });
    expect(await ws.exists(SYS, "recorded/old.json")).toBe(false);
    expect(await ws.exists(SYS, "recorded/getPet.json")).toBe(true);
  });
});
```

헤더 키가 소문자(`authorization`)로 저장되는 이유: `runContract`와 같은 `mergeHeaders` 규칙으로 보낸 헤더를 그대로 적기 때문이다.

- [ ] **Step 4: 실패 확인**

Run: `pnpm vitest run packages/core/test/record.test.ts`
Expected: FAIL — `Failed to load url ../src/record/index.js`.

- [ ] **Step 5: `record/index.ts` 작성**

`verify/contracts.ts`의 `mergeHeaders`를 export로 바꾼다(수정 전 `function mergeHeaders(`, 수정 후 `export function mergeHeaders(`). 그 뒤:
```ts
// packages/core/src/record/index.ts
import type { GenerateReport } from "../generate/generator.js";
import { maskHeaders, maskSecrets } from "../ingest/mask.js";
import type { OnEvent } from "../service/events.js";
import { RecordedSchema, type HttpMethod, type MockSpec } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { featureInputHash } from "../util/specHash.js";
import { mergeHeaders, runContract } from "../verify/contracts.js";
import type { Workspace } from "../workspace.js";
import { DRIFT_FILE, renderDrift, statusHint, type DriftEntry } from "./drift.js";
import { clearRecorded, recordedName } from "./recorded.js";
import { applyParams, type Target } from "./target.js";

export const MAX_RECORD_BYTES = 1_048_576;
const NORMAL_CONTRACT = "정상 요청";
const SAFE_METHODS = new Set<HttpMethod>(["GET", "HEAD"]);

export interface RecordOptions {
  /** POST·PUT·PATCH·DELETE 등도 보낸다. */
  allowMutating?: boolean;
  /** 이 기능만. 현재 mockspec에 없는 id는 오류. */
  features?: string[];
  /** 기존 recorded/ 전부 삭제 후 녹화. */
  refresh?: boolean;
  onEvent?: OnEvent;
  signal?: AbortSignal;
  /** 테스트용 시계. */
  now?: () => Date;
}

/** 설계 §4.1. applied는 서비스가 채운다(설계 대비 결정 D5: generate는 null일 수 있다). */
export interface RecordResult {
  system: string;
  baseUrl: string;
  recorded: string[];
  matched: string[];
  drifted: { featureId: string; errors: string[] }[];
  statusMismatch: { featureId: string; expected: number; actual: number; hint?: string }[];
  skipped: { featureId: string; reason: "mutating" }[];
  failed: { featureId: string; reason: string }[];
  driftPath: string;
  applied: { selected: number; generate: GenerateReport | null } | null;
}

export interface RecordRun { result: RecordResult; driftMarkdown: string }

function display(p: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return qs ? `${p}?${qs}` : p;
}

/** mockspec의 정상 요청 contract를 target에 순서대로 보내 녹화하고 drift.md를 쓴다. 잠금은 잡지 않는다. */
export async function record(ws: Workspace, system: string, spec: MockSpec, target: Target, opts: RecordOptions = {}): Promise<RecordRun> {
  const known = new Set(spec.features.map((f) => f.id));
  const want = opts.features && opts.features.length > 0 ? new Set(opts.features) : null;
  if (want) {
    const unknown = [...want].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`알 수 없는 기능 id: ${unknown.join(", ")}`);
  }
  const byId = new Map(spec.features.map((f) => [f.id, f]));
  const targets = spec.contracts.filter((c) => c.name === NORMAL_CONTRACT && (!want || want.has(c.featureId)));
  for (const c of targets) recordedName(c.featureId);   // 안전하지 않은 id는 요청 전에 거부
  if (opts.refresh) await clearRecorded(ws, system);

  const now = opts.now ?? (() => new Date());
  const ajv = makeAjv();
  const entries: DriftEntry[] = [];
  const result: RecordResult = {
    system, baseUrl: target.baseUrl, recorded: [], matched: [], drifted: [], statusMismatch: [], skipped: [], failed: [],
    driftPath: ws.file(system, DRIFT_FILE), applied: null,
  };
  let sent = 0;
  for (const [i, c] of targets.entries()) {
    opts.signal?.throwIfAborted();
    const featureId = c.featureId;
    const method = c.request.method;
    const { path: p, query } = applyParams(byId.get(featureId), c, target.params);
    const shown = maskSecrets(display(p, query));
    opts.onEvent?.({ stage: "record", message: `${featureId} ${method} ${shown}`, done: i + 1, total: targets.length });
    const base = { featureId, method, path: shown };
    if (!opts.allowMutating && !SAFE_METHODS.has(method)) {
      result.skipped.push({ featureId, reason: "mutating" });
      entries.push({ ...base, kind: "skipped" });
      continue;
    }
    const first = sent === 0;
    sent++;
    const r = await runContract(target.baseUrl, c, { headers: target.headers, timeoutMs: target.timeoutMs, signal: opts.signal, ajv, maxBytes: MAX_RECORD_BYTES, path: p, query });
    if (r.status === null || r.kind === null) {
      const f = r.failure ?? { kind: "network" as const, message: "unknown" };
      if (f.kind === "network" && first) {
        throw new Error(maskSecrets(`실제 시스템에 연결하지 못했습니다(${f.message}): ${target.baseUrl}. baseUrl을 확인하세요`));
      }
      const reason = maskSecrets(f.kind === "timeout" ? `시간 초과(${target.timeoutMs}ms)` : `연결 실패: ${f.message}`);
      result.failed.push({ featureId, reason });
      entries.push({ ...base, kind: "failed", reason });
      continue;
    }
    const statusMatch = r.status === c.expect.status;
    await ws.write(system, recordedName(featureId), RecordedSchema, {
      featureId,
      recordedAt: now().toISOString(),
      mockspecHash: featureInputHash(spec, featureId),
      request: { method, path: p, query: maskHeaders(query), headers: maskHeaders(mergeHeaders(c.request.headers, target.headers)) },
      response: {
        status: r.status, kind: r.kind, headers: r.headers, bytes: r.bytes,
        ...(r.kind === "truncated" ? { truncated: true as const } : { body: r.body }),
      },
      contract: { expectedStatus: c.expect.status, statusMatch, schemaErrors: r.schemaErrors.map(maskSecrets) },
    });
    result.recorded.push(featureId);

    if (!statusMatch) {
      const hint = statusHint(r.status);
      result.statusMismatch.push({ featureId, expected: c.expect.status, actual: r.status, ...(hint ? { hint } : {}) });
      entries.push({ ...base, kind: "statusMismatch", expected: c.expect.status, actual: r.status, ...(hint ? { hint } : {}) });
    } else if (r.kind === "truncated" || r.kind === "raw") {
      const reason = r.kind === "truncated"
        ? `응답이 1MB를 넘어 저장하지 않았습니다(${r.bytes}바이트)`
        : `바디가 JSON이 아닙니다(content-type: ${r.headers["content-type"] ?? "없음"})`;
      result.failed.push({ featureId, reason });
      entries.push({ ...base, kind: "failed", reason });
    } else if (r.schemaErrors.length > 0) {
      const errors = r.schemaErrors.map(maskSecrets);
      result.drifted.push({ featureId, errors });
      entries.push({ ...base, kind: "drifted", status: r.status, errors });
    } else {
      result.matched.push(featureId);
      entries.push({ ...base, kind: "matched" });
    }
  }
  const driftMarkdown = renderDrift(system, target.baseUrl, now(), entries);
  await ws.writeText(system, DRIFT_FILE, driftMarkdown);
  return { result, driftMarkdown };
}

export { DRIFT_FILE } from "./drift.js";
export { readTarget, TARGET_EXAMPLE, TARGET_FILE, type Target } from "./target.js";
export { RECORDED_DIR, readRecorded, isSafeFeatureId } from "./recorded.js";
```

`GenerateReport`는 `generate/generator.ts`에 있다(`generate/index.ts:9`가 거기서 import). 순환 import는 생기지 않는다(record → generator.ts는 타입만).

- [ ] **Step 6: 통과 확인**

Run: `pnpm vitest run packages/core/test/record.test.ts packages/core/test/contract-run.test.ts`
Expected: PASS(record 8건). 테스트 하나가 2초 넘게 걸리면 timeout 테스트의 `delayMs`(500)·`timeoutMs`(100)만 확인한다. 이어서 `pnpm -F @specmock/core typecheck` 오류 0.

- [ ] **Step 7: 커밋**

```bash
git add packages/core/src/record/index.ts packages/core/src/verify/contracts.ts packages/core/src/service/events.ts packages/core/test/fakeTarget.ts packages/core/test/record.test.ts
git commit -m "feat(core): record real-system responses and write drift.md

정상 요청 contract를 target.json의 baseUrl에 순차로 보내 recorded/<id>.json에
마스킹해 저장하고 일치·스펙과 다름·상태 불일치·건너뜀·실패로 나눈다.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 6: select가 녹화를 fixture로 쓴다(`source: "recorded"`)·coverage 행

**Files:**
- Modify: `packages/core/src/types.ts:99`(`FixtureSchema.source`)
- Modify: `packages/core/src/select/fixtures.ts:32-62`(`buildFixtures(feature, recorded?)`)
- Modify: `packages/core/src/select/index.ts:1-8`(import), `:78-84`(루프), `:93-97`(낡은 녹화 경고)
- Modify: `packages/core/src/verify/coverage.ts:4`, `:29`(표 행)
- Test: `packages/core/test/fixtures.test.ts`, `packages/core/test/select.test.ts`, `packages/core/test/coverage.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가**

`packages/core/test/fixtures.test.ts` import 수정 전:
```ts
import type { Feature } from "../src/types.js";
```

수정 후:
```ts
import type { Feature, Recorded } from "../src/types.js";
```

파일 끝에 추가:
```ts
function rec(status: number, over: Partial<Recorded["response"]> = {}): Recorded {
  return {
    featureId: "x.get", recordedAt: "2026-11-09T00:00:00.000Z", mockspecHash: "h",
    request: { method: "GET", path: "/x", query: {}, headers: {} },
    response: { status, kind: "json", headers: {}, body: { real: true }, bytes: 13, ...over },
    contract: { expectedStatus: 200, statusMatch: status === 200, schemaErrors: [] },
  };
}
const R = { "200": { schema: { type: "object" }, examples: [] }, "404": { schema: { type: "object" }, examples: [] } };

describe("buildFixtures with recording", () => {
  it("기본 2xx와 status가 같은 JSON 녹화는 recorded fixture가 된다", () => {
    const { fixtures, assumptions } = buildFixtures(f(R), rec(200));
    expect(fixtures[0]).toEqual({ status: 200, body: { real: true }, source: "recorded" });
    expect(fixtures[1].source).toBe("schema-generated");
    expect(assumptions).toEqual([]);
  });

  it("status 다름·truncated·비JSON은 무시하고 사유를 남긴다", () => {
    expect(buildFixtures(f(R), rec(404)).assumptions).toEqual(["x.get: 녹화 응답이 404라 사용하지 않음(추측 fixture 사용)"]);
    expect(buildFixtures(f(R), rec(200, { kind: "truncated", body: undefined, truncated: true })).assumptions)
      .toEqual(["x.get: 녹화 응답이 1MB를 넘어 사용하지 않음(추측 fixture 사용)"]);
    const raw = buildFixtures(f(R), rec(200, { kind: "raw", body: { raw: "<html>", contentType: "text/html" } }));
    expect(raw.assumptions).toEqual(["x.get: 녹화 응답 바디가 JSON이 아니라 사용하지 않음(추측 fixture 사용)"]);
    expect(raw.fixtures[0].source).toBe("schema-generated");
  });

  it("204 빈 녹화는 바꿀 것이 없어 조용히 넘어간다", () => {
    const { fixtures, assumptions } = buildFixtures(f({ "204": { schema: null, examples: [] } }), rec(204, { kind: "empty", body: null }));
    expect(fixtures).toEqual([{ status: 204, body: null, source: "empty" }]);
    expect(assumptions).toEqual([]);
  });
});
```

`packages/core/test/select.test.ts` import에 추가: `import { featureInputHash } from "../src/util/specHash.js";`, `RecordedSchema`(기존 `../src/types.js` import 줄에 더함), `import { readFile } from "node:fs/promises";`는 필요 없다. 파일 끝에 추가:
```ts
describe("select with recordings", () => {
  async function writeRec(id: string, body: unknown, mockspecHash: string, status = 200): Promise<void> {
    await ws.write("petstore", `recorded/${id}.json`, RecordedSchema, {
      featureId: id, recordedAt: "2026-11-09T00:00:00.000Z", mockspecHash,
      request: { method: "GET", path: "/pets", query: {}, headers: {} },
      response: { status, kind: "json", headers: {}, body, bytes: 10 },
      contract: { expectedStatus: 200, statusMatch: status === 200, schemaErrors: [] },
    });
  }

  it("녹화가 있으면 기본 fixture를 바꾸고, 해시가 같으면 경고가 없다", async () => {
    await select(ws, "petstore", ["all"]);
    const before = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    await writeRec("listPets", [{ id: 7, name: "Real" }], featureInputHash(before, "listPets"));
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const f = spec.features.find((x) => x.id === "listPets")!;
    expect(f.fixtures[0]).toEqual({ status: 200, body: [{ id: 7, name: "Real" }], source: "recorded" });
    expect(spec.assumptions.some((a) => a.includes("낡은 녹화"))).toBe(false);
    expect(spec.contracts).toEqual(before.contracts);
  });

  it("해시가 다르면 낡은 녹화 경고를 남기되 사용한다", async () => {
    await writeRec("listPets", [{ id: 7, name: "Real" }], "old-hash");
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.features.find((x) => x.id === "listPets")!.fixtures[0].source).toBe("recorded");
    expect(spec.assumptions).toContain("listPets: 녹화가 지금 mockspec과 다른 시점에 만들어졌습니다(낡은 녹화). 다시 녹화하려면 record --refresh");
  });

  it("깨진 녹화 파일은 무시하고 사유를 남긴다", async () => {
    await ws.writeText("petstore", "recorded/listPets.json", "{ broken");
    await select(ws, "petstore", ["all"]);
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    expect(spec.features.find((x) => x.id === "listPets")!.fixtures[0].source).not.toBe("recorded");
    expect(spec.assumptions).toContain("listPets: 녹화 파일을 읽지 못해 사용하지 않음");
  });
});
```

`packages/core/test/coverage.test.ts` 끝(마지막 `});` 앞, 기존 `spec` 상수를 쓴다)에 추가:
```ts
  it("fixture 출처 표의 첫 행은 recorded", () => {
    const recorded: MockSpec = { ...spec, features: spec.features.map((f) => ({ ...f, fixtures: f.fixtures.map((x) => ({ ...x, source: "recorded" as const })) })) };
    const md = renderCoverage(recorded, null);
    const rows = md.split("\n").filter((l) => /^\| (recorded|spec-example|doc-sample|schema-generated|empty) \|/.test(l));
    expect(rows[0]).toBe(`| recorded | ${spec.features.length} | 실제 시스템 응답을 녹화 |`);
    expect(rows).toHaveLength(5);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run packages/core/test/fixtures.test.ts packages/core/test/select.test.ts packages/core/test/coverage.test.ts`
Expected: FAIL — 새 테스트들(`source` enum에 `recorded` 없음 → zod 오류, recorded 행 없음, buildFixtures가 두 번째 인자를 무시).

- [ ] **Step 3: enum과 coverage 행**

`packages/core/src/types.ts:99` 수정 전:
```ts
  source: z.enum(["spec-example", "doc-sample", "schema-generated", "empty"]),
```

수정 후:
```ts
  source: z.enum(["recorded", "spec-example", "doc-sample", "schema-generated", "empty"]),
```

`packages/core/src/verify/coverage.ts:4` 수정 전:
```ts
const SOURCES: Fixture["source"][] = ["spec-example", "doc-sample", "schema-generated", "empty"];
```

수정 후:
```ts
const SOURCES: Fixture["source"][] = ["recorded", "spec-example", "doc-sample", "schema-generated", "empty"];
```

`:29`(`| spec-example |` 줄) 바로 앞에 추가:
```ts
  lines.push(`| recorded | ${bySource["recorded"]} | 실제 시스템 응답을 녹화 |`);
```

`generate/tsHono.ts:86`과 `README.md.eta`는 source 값을 그대로 출력하므로 바꾸지 않는다(스냅샷 fixture에 `recorded`가 없어 TS 스냅샷도 그대로).

- [ ] **Step 4: `buildFixtures`가 녹화를 받는다**

`packages/core/src/select/fixtures.ts` import 수정 전:
```ts
import type { Feature, Fixture, JsonSchema } from "../types.js";
```

수정 후:
```ts
import type { Feature, Fixture, JsonSchema, Recorded } from "../types.js";
```

`:32` 시그니처 수정 전:
```ts
export function buildFixtures(feature: Feature): { fixtures: Fixture[]; assumptions: string[] } {
```

수정 후:
```ts
export function buildFixtures(feature: Feature, recorded: Recorded | null = null): { fixtures: Fixture[]; assumptions: string[] } {
```

함수 끝 `return { fixtures, assumptions };` 바로 앞에 추가:
```ts
  if (recorded) {
    const served = fixtures.filter((x) => x.status >= 200 && x.status < 300).sort((a, b) => a.status - b.status)[0];
    const r = recorded.response;
    const skip = (why: string) => assumptions.push(`${feature.id}: ${why} 사용하지 않음(추측 fixture 사용)`);
    if (r.status !== served.status) skip(`녹화 응답이 ${r.status}라`);
    else if (r.kind === "json") fixtures[fixtures.indexOf(served)] = { status: served.status, body: r.body, source: "recorded" };
    else if (r.kind === "truncated") skip("녹화 응답이 1MB를 넘어");
    else if (r.kind === "raw" || served.status !== 204) skip("녹화 응답 바디가 JSON이 아니라");
    // 204 + 빈 바디: 기존 empty fixture와 같으므로 그대로 둔다.
  }
```

(`served`는 바로 위의 "2xx 보장" 블록 덕분에 항상 있다.)

- [ ] **Step 5: select가 녹화를 읽고 낡은 녹화를 경고**

`packages/core/src/select/index.ts` import 수정 전(:1-8 중):
```ts
import { CatalogSchema, MockSpecSchema, SelectionSchema, SourceSchema, type Contract, type MockFeature, type MockSpec } from "../types.js";
import { hashJson } from "../util/hash.js";
```

수정 후:
```ts
import { readRecorded } from "../record/recorded.js";
import { CatalogSchema, MockSpecSchema, SelectionSchema, SourceSchema, type Contract, type MockFeature, type MockSpec, type Recorded } from "../types.js";
import { hashJson } from "../util/hash.js";
import { featureInputHash } from "../util/specHash.js";
```

`:78-84` 루프 수정 전:
```ts
  for (const id of resolved) {
    const feature = byId.get(id)!;
    const built = buildFixtures(feature);
    assumptions.push(...built.assumptions);
    features.push({ ...feature, fixtures: built.fixtures });
    contracts.push(...buildContracts(feature, built.fixtures));
  }
```

수정 후:
```ts
  const recordings: Recorded[] = [];
  for (const id of resolved) {
    const feature = byId.get(id)!;
    let rec: Recorded | null = null;
    try { rec = await readRecorded(ws, system, id); } catch { assumptions.push(`${id}: 녹화 파일을 읽지 못해 사용하지 않음`); }
    if (rec) recordings.push(rec);
    const built = buildFixtures(feature, rec);
    assumptions.push(...built.assumptions);
    features.push({ ...feature, fixtures: built.fixtures });
    contracts.push(...buildContracts(feature, built.fixtures));
  }
```

`const notMocked = …` 줄(:93) 바로 뒤에 추가:
```ts
  const fresh: MockSpec = { system, baseUrl: "/", features, notMocked, contracts, assumptions: [] };
  for (const r of recordings) {
    if (r.mockspecHash !== featureInputHash(fresh, r.featureId)) {
      assumptions.push(`${r.featureId}: 녹화가 지금 mockspec과 다른 시점에 만들어졌습니다(낡은 녹화). 다시 녹화하려면 record --refresh`);
    }
  }
```

`readRecorded`는 안전하지 않은 id에 null을 돌려주므로 이상한 id가 경로가 되지 않는다. 녹화는 잠금 안(`withSystemLock`)에서 읽힌다.

- [ ] **Step 6: 통과 확인**

Run: `pnpm vitest run packages/core/test/fixtures.test.ts packages/core/test/select.test.ts packages/core/test/coverage.test.ts packages/core/test/snapshot.test.ts packages/core/test/e2e.test.ts`
Expected: PASS(새 테스트 7건 포함). 스냅샷 무변경. `pnpm -F @specmock/core typecheck` 오류 0 — `Fixture["source"]`를 `switch`로 다루는 다른 곳이 있으면 typecheck가 알려 준다(조사 시점에는 coverage.ts뿐).

- [ ] **Step 7: 커밋**

```bash
git add packages/core/src/types.ts packages/core/src/select/fixtures.ts packages/core/src/select/index.ts packages/core/src/verify/coverage.ts packages/core/test/fixtures.test.ts packages/core/test/select.test.ts packages/core/test/coverage.test.ts
git commit -m "feat(core): use recorded responses as fixtures in select

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 7: lock `inputHash`와 "fixture만 바뀐" LLM 생성 경로

**Files:**
- Modify: `packages/core/src/generate/lock.ts:20`(`inputHash` 선택 필드)
- Modify: `packages/core/src/generate/index.ts:1-15`(import), `:148-162`(새 경로), `:177-192`(lock에 기록)
- Modify: `packages/core/src/generate/session.ts:4-6`(import), `:171-186`(finalize lock에 기록)
- Test: `packages/core/test/generateLlm.test.ts`

배경(D4): `mockspecHash = hashJson(spec)`(`generate/index.ts:148`)에는 fixture 본문이 들어간다. 녹화를 반영하면 fixture만 바뀌어도 해시가 달라져 `skipped` 경로(`:154`)를 지나 LLM을 다시 부른다. LLM 지시서(`generate/request.ts`)는 fixture 본문을 넣지 않으므로 fixture만 바뀌었으면 LLM이 할 일이 없다. 그래서 fixture 본문과 assumptions를 뺀 `specInputHash`를 lock에 따로 적고, 그것이 같으면 scaffold(fixtures·contracts·README)만 다시 쓴다. 기존 lock에는 `inputHash`가 없으므로 첫 번째 생성 뒤부터 이 경로를 탄다(옛 lock = 지금과 같은 동작).

- [ ] **Step 1: 실패하는 테스트**

`packages/core/test/generateLlm.test.ts` import에 추가:
```ts
import { specInputHash } from "../src/util/specHash.js";
```

기존 `import { hashText } from "../src/util/hash.js";`는 `import { hashJson, hashText } from "../src/util/hash.js";`로 바꾼다.

`"--force면 같은 mockspec이어도 다시 생성한다"` 테스트 바로 뒤에 추가:
```ts
  it("fixture만 바뀌면 LLM 없이 scaffold만 다시 쓴다", async () => {
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    expect((await readLock(out))!.inputHash).toBe(specInputHash(await specNow()));
    const spec = await specNow();
    const changed: MockSpec = {
      ...spec,
      features: spec.features.map((f) => f.id !== "getPet" ? f : { ...f, fixtures: f.fixtures.map((x) => x.status === 200 ? { status: 200, body: { id: 9, name: "Real" }, source: "recorded" as const } : x) }),
    };
    await ws.write("petstore", "mockspec.json", MockSpecSchema, changed);
    const r = await generate(ws, "petstore", opts());
    expect(r).toMatchObject({ skipped: false, attempts: 0, notes: ["fixture만 바뀌어 LLM을 다시 부르지 않았습니다"], userModified: [] });
    expect(r.written).toContain("fixtures/getPet/200.json");
    expect(await calls()).toBe(1);
    expect(JSON.parse(await readFile(path.join(out, "fixtures/getPet/200.json"), "utf8"))).toEqual({ id: 9, name: "Real" });
    const lock = (await readLock(out))!;
    expect(lock.mockspecHash).toBe(hashJson(changed));
    expect(lock.sourceFiles).toEqual({ "server.mjs": hashText(await readFile(path.join(out, "server.mjs"), "utf8")) });
    expect((await ws.read("petstore", "generate.json", GenerateInfoSchema)).notes).toEqual(["가정: 인증 없음"]);
    // 같은 내용으로 한 번 더: 이제는 mockspecHash가 같아 skipped
    expect((await generate(ws, "petstore", opts())).skipped).toBe(true);
  }, 60_000);

  it("기능 정의가 바뀌면(inputHash 다름) LLM을 다시 부른다", async () => {
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    await select(ws, "petstore", ["getPet"]);
    await respond(2, answer(await specNow()));
    const r = await generate(ws, "petstore", opts());
    expect(r.attempts).toBe(1);
    expect(await calls()).toBe(2);
  }, 60_000);
```

fixture 파일은 `fixtures/<id>/<status>.json`에 본문만 담긴다(`scaffold.ts:61`).

`packages/core/test/session.test.ts:98`(`const lock = (await readLock(out))!;`) 바로 뒤에 한 줄 추가:
```ts
    expect((await readLock(out))!.inputHash).toBe(specInputHash(await ws.read("petstore", "mockspec.json", MockSpecSchema)));
```

같은 파일 import에 `import { specInputHash } from "../src/util/specHash.js";`를 더한다(`MockSpecSchema`가 import에 없으면 `../src/types.js`에서 함께).

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run packages/core/test/generateLlm.test.ts packages/core/test/session.test.ts`
Expected: FAIL — `inputHash`가 undefined, 두 번째 generate가 LLM을 불러 `calls()`가 2(응답 파일 `2.json`이 없어 생성 실패 오류일 수도 있다).

- [ ] **Step 3: lock 필드**

`packages/core/src/generate/lock.ts:20` `mockspecHash: z.string(),` 바로 뒤에 추가:
```ts
  /** fixture 본문·assumptions를 뺀 mockspec 해시(util/specHash.ts). 같으면 LLM 소스는 그대로 두고 scaffold만 다시 쓴다. 옛 lock = 없음. */
  inputHash: z.string().optional(),
```

- [ ] **Step 4: generate 새 경로**

`packages/core/src/generate/index.ts` import에 추가:
```ts
import { specInputHash } from "../util/specHash.js";
```

`:148` 수정 전:
```ts
  const mockspecHash = hashJson(spec);
```

수정 후:
```ts
  const mockspecHash = hashJson(spec);
  const inputHash = specInputHash(spec);
```

`skipped` 경로 블록(`:154-162`의 `}`) 바로 뒤에 추가:
```ts
  // fixture 본문만 바뀌었으면(녹화 반영 등) LLM 소스는 그대로 두고 scaffold·lock만 새로 쓴다.
  if (profile && previous && sameLanguage && previous.generator === "llm" && previous.inputHash === inputHash && !opts.force) {
    const written: string[] = [];
    const s = await writeScaffold(spec, outDir, previous, {}, written);
    await writeLock(outDir, { ...previous, mockspecHash, inputHash, generatedAt: new Date().toISOString(), fixtureHashes: s.fixtureHashes });
    const prior = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
    const keepNotes = prior && path.resolve(prior.outDir) === outDir ? (prior.notes ?? []) : [];
    await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language, notes: keepNotes, attempts: prior?.attempts ?? 0 });
    return {
      outDir, language, written, preserved: s.preserved, orphaned: s.orphaned,
      launch: launchHint(outDir, previous), attempts: 0, notes: ["fixture만 바뀌어 LLM을 다시 부르지 않았습니다"], userModified: [], skipped: false,
    };
  }
```

`writeScaffold`의 `force` 없음 = 사용자가 고친 fixture는 보존(`preserved`)된다. 녹화가 반영되지 않은 파일은 서비스·CLI가 `preserved`로 알린다(Task 8·9).

`writeLock(outDir, {` 블록(`:177-192`)의 `mockspecHash,` 줄 수정 전:
```ts
    mockspecHash,
    generatedAt: new Date().toISOString(),
```

수정 후:
```ts
    mockspecHash,
    inputHash,
    generatedAt: new Date().toISOString(),
```

TS 템플릿 생성기도 이 lock을 쓴다. `inputHash`는 lock 파일에만 들어가고 스냅샷 테스트는 lock을 제외하므로 스냅샷은 그대로다.

- [ ] **Step 5: session finalize도 기록**

`packages/core/src/generate/session.ts` import에 추가:
```ts
import { specInputHash } from "../util/specHash.js";
```

`:171-186` `writeLock(outDir, {` 블록 수정 전:
```ts
      generator: "llm",
      mockspecHash,
      generatedAt: new Date().toISOString(),
```

수정 후:
```ts
      generator: "llm",
      mockspecHash,
      inputHash: specInputHash(spec),
      generatedAt: new Date().toISOString(),
```

세션 모드(MCP)의 `generate_mock`은 이 경로를 쓰지 않는다(서비스 apply가 core `generate`를 직접 부른다, Task 8). finalize에 기록하는 이유는 MCP로 만든 Java 목에도 apply가 LLM 없이 적용되게 하기 위해서다.

- [ ] **Step 6: 통과 확인**

Run: `pnpm vitest run packages/core/test/generateLlm.test.ts packages/core/test/session.test.ts packages/core/test/generate.test.ts packages/core/test/lock.test.ts packages/core/test/snapshot.test.ts`
Expected: PASS. `pnpm -F @specmock/core typecheck` 오류 0.

- [ ] **Step 7: 커밋**

```bash
git add packages/core/src/generate/lock.ts packages/core/src/generate/index.ts packages/core/src/generate/session.ts packages/core/test/generateLlm.test.ts packages/core/test/session.test.ts
git commit -m "feat(core): regenerate only scaffold when just fixtures changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 8: 서비스 `recordResponses`(녹화 → select → generate 반영)

**Files:**
- Create: `packages/core/src/service/record.ts`
- Modify: `packages/core/src/service/index.ts`(export 줄 추가)
- Modify: `packages/core/src/index.ts`(record 모듈 export)
- Test: `packages/core/test/recordService.test.ts`

`ServiceStage`의 `"record"`는 Task 5에서 이미 넣었다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/core/test/recordService.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { LockSchema, readLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { recordResponses } from "../src/service/record.js";
import { MockSpecSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { startFakeTarget, type FakeTarget } from "./fakeTarget.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const SYS = "petstore";
const REAL = { id: 1, name: "Real" };

let dir: string;
let genDir: string;
let out: string;
let ws: Workspace;
let t: FakeTarget;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-recsvc-"));
  genDir = path.join(dir, "gen");
  out = path.join(dir, "mock");
  await mkdir(genDir);
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, SYS, [PETSTORE]);
  await analyze(ws, SYS);
  await select(ws, SYS, ["getPet", "createPet"]);
  t = await startFakeTarget((q) => (q.path.startsWith("/pets/") ? { status: 200, body: REAL } : { status: 404 }));
  await ws.writeText(SYS, "target.json", JSON.stringify({ baseUrl: t.url }));
});
afterEach(async () => { await t.close(); await rm(dir, { recursive: true, force: true }); });

const adapter = () => new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
const calls = async () => Number(await readFile(path.join(genDir, "count"), "utf8"));
const specNow = () => ws.read(SYS, "mockspec.json", MockSpecSchema);
const answer = (spec: MockSpec) => ({ files: [{ path: "server.mjs", content: fakeServerSource(spec) }], notes: [] });
const fixture = async () => JSON.parse(await readFile(path.join(out, "fixtures/getPet/200.json"), "utf8"));
async function generateFake(): Promise<void> {
  await writeFile(path.join(genDir, "1.json"), JSON.stringify(answer(await specNow())));
  await generate(ws, SYS, { outDir: out, profile: fakeProfile, adapter: adapter() });
}

describe("recordResponses", () => {
  it("LLM 목(fake 프로필): 녹화 바디가 fixture 파일이 되고 LLM은 다시 부르지 않는다", async () => {
    await generateFake();
    const r = await recordResponses(ws, SYS, { profile: fakeProfile, adapter: adapter() });
    expect(r.result.matched).toEqual(["getPet"]);
    expect(r.result.skipped).toEqual([{ featureId: "createPet", reason: "mutating" }]);
    expect(r.result.applied).toMatchObject({ selected: 2, generate: { skipped: false, attempts: 0 } });
    expect(r.notes).toEqual([]);
    expect(await fixture()).toEqual(REAL);
    expect(await calls()).toBe(1);
    expect(r.driftMarkdown).toContain("# petstore 실제 시스템 대조 (");
    expect(r.driftPath).toBe(r.result.driftPath);
  }, 60_000);

  it("TS 템플릿 목도 fixture가 바뀐다", async () => {
    await generate(ws, SYS, { outDir: out });
    const r = await recordResponses(ws, SYS);
    expect(r.result.applied?.generate?.language).toBe("ts");
    expect(await fixture()).toEqual(REAL);
  }, 60_000);

  it("사용자가 고친 fixture는 보존하고 메모로 알린다", async () => {
    await generateFake();
    await writeFile(path.join(out, "fixtures/getPet/200.json"), JSON.stringify({ mine: true }));
    const r = await recordResponses(ws, SYS, { profile: fakeProfile, adapter: adapter() });
    expect(await fixture()).toEqual({ mine: true });
    expect(r.notes).toEqual(["fixtures/getPet/200.json: 보존됨 — 녹화가 반영되지 않음"]);
  }, 60_000);

  it("generate.json이 없으면 select만 하고 generate는 안내만 한다", async () => {
    const r = await recordResponses(ws, SYS);
    expect(r.result.applied).toEqual({ selected: 2, generate: null });
    expect(r.notes).toEqual(["generate를 실행하면 반영됩니다"]);
    expect((await specNow()).features.find((f) => f.id === "getPet")!.fixtures[0]).toEqual({ status: 200, body: REAL, source: "recorded" });
  });

  it("옛 LLM lock(inputHash 없음)은 generate를 건너뛴다", async () => {
    await generateFake();
    const { inputHash: _drop, ...old } = (await readLock(out))!;
    await writeFile(path.join(out, "specmock.lock.json"), JSON.stringify(LockSchema.parse(old), null, 2));
    const before = await fixture();
    const r = await recordResponses(ws, SYS, { profile: fakeProfile, adapter: adapter() });
    expect(r.result.applied).toEqual({ selected: 2, generate: null });
    expect(r.notes).toEqual(["generate를 실행하면 반영됩니다(LLM 재생성 필요)"]);
    expect(await fixture()).toEqual(before);
    expect(await calls()).toBe(1);
  }, 60_000);

  it("apply: false면 select도 하지 않는다", async () => {
    const before = await specNow();
    const r = await recordResponses(ws, SYS, { apply: false });
    expect(r.result.applied).toBeNull();
    expect(r.notes).toEqual([]);
    expect(await specNow()).toEqual(before);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run packages/core/test/recordService.test.ts`
Expected: FAIL — `Failed to load url ../src/service/record.js`.

- [ ] **Step 3: 서비스 작성**

```ts
// packages/core/src/service/record.ts
import path from "node:path";
import type { GenerateReport } from "../generate/generator.js";
import { generate } from "../generate/index.js";
import { readLock } from "../generate/lock.js";
import type { LanguageProfile } from "../generate/profiles/index.js";
import type { LlmAdapter } from "../llm/adapter.js";
import { readTarget, record, type RecordResult } from "../record/index.js";
import { select } from "../select/index.js";
import { GenerateInfoSchema, MockSpecSchema, SelectionSchema } from "../types.js";
import { specInputHash } from "../util/specHash.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

export const APPLY_LATER = "generate를 실행하면 반영됩니다";
export const PRESERVED_NOTE = "보존됨 — 녹화가 반영되지 않음";

export interface RecordResponsesOptions {
  allowMutating?: boolean;
  features?: string[];
  refresh?: boolean;
  /** 기본 true. false면 녹화·drift만. */
  apply?: boolean;
  /** target.json의 ${ENV} 치환에 쓸 환경. 기본 process.env. */
  env?: Record<string, string | undefined>;
  onEvent?: OnEvent;
  signal?: AbortSignal;
  /** 테스트 전용: 언어 프로필·LLM 어댑터 주입. apply는 LLM을 부르지 않지만 generate가 프로필을 찾는 데 쓴다. */
  profile?: LanguageProfile;
  adapter?: LlmAdapter;
}

export interface RecordResponsesResult { result: RecordResult; driftPath: string; driftMarkdown: string; notes: string[] }

/** 실제 시스템 응답을 녹화하고 drift.md를 쓴 뒤, apply면 select → generate(LLM 없이)로 mock에 반영한다. */
export async function recordResponses(ws: Workspace, system: string, opts: RecordResponsesOptions = {}): Promise<RecordResponsesResult> {
  const target = await readTarget(ws, system, opts.env ?? process.env);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const { result, driftMarkdown } = await record(ws, system, spec, target, {
    allowMutating: opts.allowMutating, features: opts.features, refresh: opts.refresh, onEvent: opts.onEvent, signal: opts.signal,
  });
  const notes: string[] = [];
  if (opts.apply !== false) {
    opts.onEvent?.({ stage: "record", message: "select 다시 실행(녹화 반영)" });
    const selection = await ws.read(system, "selection.json", SelectionSchema);
    const sel = await select(ws, system, selection.selected);
    let generated: GenerateReport | null = null;
    const info = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
    const outDir = info ? path.resolve(info.outDir) : null;
    const lock = outDir ? await readLock(outDir) : null;
    if (!outDir || !lock) {
      notes.push(APPLY_LATER);
    } else if (lock.generator === "llm" && lock.inputHash !== specInputHash(await ws.read(system, "mockspec.json", MockSpecSchema))) {
      // 기능 정의가 바뀌었거나 옛 lock: generate가 LLM을 부르게 되므로 반영하지 않는다(D5).
      notes.push(`${APPLY_LATER}(LLM 재생성 필요)`);
    } else {
      opts.onEvent?.({ stage: "record", message: "generate 다시 실행(fixture 반영)" });
      generated = await generate(ws, system, { outDir, language: lock.language, profile: opts.profile, adapter: opts.adapter, signal: opts.signal });
      for (const p of generated.preserved) if (p.startsWith("fixtures/")) notes.push(`${p}: ${PRESERVED_NOTE}`);
    }
    result.applied = { selected: sel.resolved.length, generate: generated };
  }
  return { result, driftPath: result.driftPath, driftMarkdown, notes };
}
```

`lock.generator === "llm"`이고 `inputHash`가 같으면 generate는 `skipped` 경로(mockspec 같음) 또는 Task 7의 fixture 경로를 타므로 LLM을 부르지 않는다. TS 템플릿은 LLM이 없어 항상 generate한다.

`packages/core/src/service/index.ts` 끝에 추가:
```ts
export { recordResponses, APPLY_LATER, PRESERVED_NOTE, type RecordResponsesOptions, type RecordResponsesResult } from "./record.js";
```

`packages/core/src/index.ts`의 `export { renderCoverage } from "./verify/coverage.js";`(:33) 바로 뒤에 추가:
```ts
export { DRIFT_FILE, RECORDED_DIR, TARGET_EXAMPLE, TARGET_FILE, isSafeFeatureId, readRecorded, readTarget, record, type RecordOptions, type RecordResult, type Target } from "./record/index.js";
export { specInputHash, featureInputHash } from "./util/specHash.js";
```

`Recorded`·`RecordedSchema`는 `export * from "./types.js"`(:3)로 이미 나간다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run packages/core/test/recordService.test.ts packages/core/test/record.test.ts packages/core/test/service.test.ts`
Expected: PASS(6건 + 기존). `pnpm -F @specmock/core typecheck` 오류 0.

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/service/record.ts packages/core/src/service/index.ts packages/core/src/index.ts packages/core/test/recordService.test.ts
git commit -m "feat(core): add recordResponses service with apply

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 9: CLI `specmock record`

**Files:**
- Create: `packages/cli/src/commands/record.ts`
- Modify: `packages/cli/src/cli.ts:12`(import), `:27`(등록)
- Modify: `packages/cli/test/plugin.test.ts:47`(명령 정규식)
- Test: `packages/cli/test/cli.test.ts`(끝에 describe 추가)

CLI 테스트는 tsx 자식 프로세스로 CLI를 돌리고 stdout/stderr/종료 코드만 본다. core를 빌드한 뒤 돌린다(`pnpm -s build:core` 또는 `pnpm build`).

- [ ] **Step 1: 실패하는 테스트**

`packages/cli/test/cli.test.ts` import에 추가:
```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
```

파일 끝에 추가:
```ts
describe("Phase 3B CLI (record)", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });
  /** getPet 응답 바디를 주는 실제 시스템 대역. */
  async function realSystem(body: unknown): Promise<string> {
    server = createServer((req, res) => {
      const ok = req.method === "GET" && /^\/pets\/[^/]+$/.test(req.url!.split("?")[0]!);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? body : { message: "no" }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  async function selected(target?: object) {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "getPet,createPet");
    if (target) await writeFile(path.join(dir, ".specmock", "petstore", "target.json"), JSON.stringify(target));
  }

  it("전부 일치하면 종료 코드 0, 요약과 drift 경로를 출력한다", async () => {
    await selected({ baseUrl: await realSystem({ id: 1, name: "Real" }) });
    const { stdout } = await specmock("record", "petstore");
    expect(stdout).toContain("녹화: 요청 2 · 일치 1 · 스펙과 다름 0 · 상태 불일치 0 · 건너뜀 1 · 실패 0");
    expect(stdout).toContain(`drift: ${path.join(dir, ".specmock", "petstore", "drift.md")}`);
    expect(stdout).toContain("- generate를 실행하면 반영됩니다");
  });

  it("--json은 RecordResult만 출력한다", async () => {
    await selected({ baseUrl: await realSystem({ id: 1, name: "Real" }) });
    const { stdout } = await specmock("record", "petstore", "--json", "--no-apply");
    const j = JSON.parse(stdout);
    expect(j).toMatchObject({ system: "petstore", matched: ["getPet"], recorded: ["getPet"], applied: null });
    expect(j.skipped).toEqual([{ featureId: "createPet", reason: "mutating" }]);
  });

  it("스펙과 다르면 종료 코드 2", async () => {
    await selected({ baseUrl: await realSystem({ id: "p-1", name: "Real" }) });
    await expect(specmock("record", "petstore", "--feature", "getPet")).rejects.toMatchObject({
      code: 2, stdout: expect.stringContaining("✗ getPet 스펙과 다름:"),
    });
  });

  it("target.json이 없으면 예시와 함께 종료 코드 1", async () => {
    await selected();
    await expect(specmock("record", "petstore")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('"baseUrl": "https://api.example.com/v2"'),
    });
  });

  it("환경변수가 없으면 변수 이름만 보여 준다", async () => {
    await selected({ baseUrl: "http://127.0.0.1:9", headers: { Authorization: "Bearer ${SPECMOCK_CLI_TOKEN}" } });
    const err = await specmock("record", "petstore").catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 1, stderr: expect.stringContaining("환경변수 SPECMOCK_CLI_TOKEN이 없습니다") });
    expect((err as { stderr: string }).stderr).not.toContain("Bearer");
  });
});
```

`packages/cli/test/plugin.test.ts:47` 수정 전:
```ts
        for (const m of line.matchAll(/specmock (ingest|analyze|list|select|generate|verify|run)\b([^`\n]*)/g)) {
```

수정 후:
```ts
        for (const m of line.matchAll(/specmock (ingest|analyze|list|select|generate|verify|record|run)\b([^`\n]*)/g)) {
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -s build:core && pnpm vitest run packages/cli/test/cli.test.ts -t "record"`
Expected: FAIL — `error: unknown command 'record'`(종료 코드 1, 첫 테스트는 stdout 불일치).

- [ ] **Step 3: 명령 작성**

```ts
// packages/cli/src/commands/record.ts
import { recordResponses, type RecordResponsesResult, type RecordResult } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function recordFailed(r: RecordResult): boolean {
  return r.drifted.length + r.statusMismatch.length + r.failed.length > 0;
}

export function formatRecord(v: RecordResponsesResult): string {
  const r = v.result;
  const total = r.matched.length + r.drifted.length + r.statusMismatch.length + r.skipped.length + r.failed.length;
  const lines = [`녹화: 요청 ${total} · 일치 ${r.matched.length} · 스펙과 다름 ${r.drifted.length} · 상태 불일치 ${r.statusMismatch.length} · 건너뜀 ${r.skipped.length} · 실패 ${r.failed.length}`];
  for (const d of r.drifted) lines.push(`  ✗ ${d.featureId} 스펙과 다름: ${d.errors.join("; ")}`);
  for (const m of r.statusMismatch) lines.push(`  ✗ ${m.featureId} 상태 불일치: 기대 ${m.expected}, 실제 ${m.actual}${m.hint ? `. ${m.hint}` : ""}`);
  for (const f of r.failed) lines.push(`  ✗ ${f.featureId} 실패: ${f.reason}`);
  if (r.skipped.length) lines.push(`  건너뜀(변경 요청, --allow-mutating으로 포함): ${r.skipped.map((s) => s.featureId).join(", ")}`);
  lines.push(`녹화 파일: ${r.recorded.length}개`);
  lines.push(`drift: ${v.driftPath}`);
  if (r.applied) {
    const g = r.applied.generate;
    lines.push(`반영: select ${r.applied.selected}개${g ? ` · generate ${g.outDir} (파일 ${g.written.length}개)` : ""}`);
  }
  for (const n of v.notes) lines.push(`- ${n}`);
  return lines.join("\n");
}

export function registerRecord(program: Command): void {
  program
    .command("record")
    .description("mockspec의 정상 요청을 target.json의 실제 시스템에 보내 응답을 녹화하고 drift.md를 쓴다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--allow-mutating", "POST·PUT·PATCH·DELETE 요청도 보낸다(실제 데이터가 바뀔 수 있음)", false)
    .option("--feature <id...>", "이 기능만 녹화")
    .option("--refresh", "기존 녹화를 모두 지우고 다시 녹화", false)
    .option("--no-apply", "녹화·drift만 하고 select·generate를 다시 실행하지 않는다")
    .option("--json", "RecordResult를 JSON으로 출력", false)
    .action(async (system: string, opts: { allowMutating: boolean; feature?: string[]; refresh: boolean; apply: boolean; json: boolean }, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      let v: RecordResponsesResult;
      try {
        v = await recordResponses(ws, system, {
          allowMutating: opts.allowMutating, features: opts.feature, refresh: opts.refresh, apply: opts.apply,
          onEvent: (e) => process.stderr.write(e.message + "\n"),
        });
      } catch (e) { fail((e as Error).message); }
      printJsonOr(opts.json, v.result, () => formatRecord(v));
      // verify와 같이 exitCode만 설정한다(stdout 파이프 잘림 방지).
      if (recordFailed(v.result)) process.exitCode = 2;
    });
}
```

`packages/cli/src/cli.ts:12` `import { registerVerify } from "./commands/verify.js";` 바로 뒤에 추가:
```ts
import { registerRecord } from "./commands/record.js";
```

`:27` `registerVerify(program);` 바로 뒤에 추가:
```ts
registerRecord(program);
```

`RecordResult`·`RecordResponsesResult`·`recordResponses`는 Task 8에서 `@specmock/core`로 export했다. 사용자가 고친 fixture의 "보존됨 — 녹화가 반영되지 않음"은 서비스 `notes`로 와서 `- …` 줄로 나온다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm -s build:core && pnpm vitest run packages/cli/test/cli.test.ts packages/cli/test/plugin.test.ts`
Expected: PASS. plugin.test는 SKILL.md에 아직 `specmock record`가 없어 그대로 통과한다(Task 10에서 줄을 넣으면 `--help`와 대조된다). `pnpm -F @specmock/cli typecheck` 오류 0.

- [ ] **Step 5: 커밋**

```bash
git add packages/cli/src/commands/record.ts packages/cli/src/cli.ts packages/cli/test/cli.test.ts packages/cli/test/plugin.test.ts
git commit -m "feat(cli): add specmock record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 10: MCP `record_responses`와 SKILL.md

**Files:**
- Modify: `packages/mcp/src/names.ts:2-5`(도구 이름)
- Modify: `packages/mcp/src/tools/mock.ts:3-6`(import), 파일 끝 `verify_mock` 등록 뒤(새 도구)
- Modify: `packages/mcp/test/tools.test.ts:21,24,207,213`(12 → 13), 끝에 describe 추가
- Modify: `packages/mcp/test/plugin.test.ts:24`(접미사 정규식)
- Modify: `plugin/skills/specmock/SKILL.md:28`(도구 표), `:42` 다음(흐름), `:56` 다음(안전 규칙), `:115` 다음(CLI)

`createServer.ts`는 바꾸지 않는다. 새 도구는 `registerMockTools` 안에 등록한다. MCP 테스트는 `connect()`가 서버를 제한된 env로 띄우므로 target.json에 `${ENV}`를 쓰지 않는다. MCP 테스트 전에 `pnpm build`(core·mcp)를 한다.

- [ ] **Step 1: 실패하는 테스트**

`packages/mcp/test/tools.test.ts:21` 수정 전/후:
```ts
  it("registers exactly TOOL_NAMES (12 tools, no leftovers)", async () => {
```

```ts
  it("registers exactly TOOL_NAMES (13 tools, no leftovers)", async () => {
```

`:24` `expect(TOOL_NAMES).toHaveLength(12);` → `expect(TOOL_NAMES).toHaveLength(13);`
`:207`·`:213` `expect((await s.client.listTools()).tools.length).toBe(12);` → `.toBe(13);`(두 곳)

import에 추가:
```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
```

파일 끝에 추가:
```ts
describe("record_responses", () => {
  let real: Server | undefined;
  afterEach(async () => { await new Promise<void>((r) => (real ? real.close(() => r()) : r())); real = undefined; });
  async function realSystem(): Promise<string> {
    real = createServer((req, res) => {
      const ok = req.method === "GET" && /^\/pets\/[^/?]+/.test(req.url!);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { id: 1, name: "Real" } : {}));
    });
    await new Promise<void>((r) => real!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(real!.address() as AddressInfo).port}`;
  }

  it("녹화하고 drift 요약을 돌려주며 TS mock의 fixture를 바꾼다", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet", "createPet"] });
    const g = await s.ok("generate_mock", { system: "petstore" });
    await writeFile(path.join(dir, ".specmock", "petstore", "target.json"), JSON.stringify({ baseUrl: await realSystem() }));
    const r = await s.ok("record_responses", { system: "petstore" });
    expect(r).toMatchObject({ matched: ["getPet"], skipped: [{ featureId: "createPet", reason: "mutating" }], driftPath: path.join(dir, ".specmock", "petstore", "drift.md") });
    expect(r.driftSummary).toContain("요청 2 · 일치 1");
    expect(r.applied).toMatchObject({ selected: 2, generated: true });
    expect(JSON.parse(await readFile(path.join(g.outDir, "fixtures", "getPet", "200.json"), "utf8"))).toEqual({ id: 1, name: "Real" });
  });

  it("target.json이 없으면 예시를 담은 isError", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet"] });
    expect(await s.err("record_responses", { system: "petstore" })).toContain("https://api.example.com/v2");
  });
});
```

`packages/mcp/test/plugin.test.ts:24` 수정 전:
```ts
    const mentioned = new Set([...docs.matchAll(/`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock|ui|generation))`/g)].map((x) => x[1]!));
```

수정 후:
```ts
    const mentioned = new Set([...docs.matchAll(/`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock|ui|generation|responses))`/g)].map((x) => x[1]!));
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm build && pnpm vitest run packages/mcp/test/tools.test.ts packages/mcp/test/plugin.test.ts`
Expected: FAIL — 도구 수 12 ≠ 13, `record_responses` 호출이 "Tool record_responses not found" isError, plugin.test는 SKILL.md에 `record_responses`가 없어 집합 불일치.

- [ ] **Step 3: 도구 등록**

`packages/mcp/src/names.ts` 수정 전:
```ts
  "list_features", "show_feature", "select_features", "generate_mock", "finalize_generation", "verify_mock", "open_ui",
```

수정 후:
```ts
  "list_features", "show_feature", "select_features", "generate_mock", "finalize_generation", "verify_mock", "record_responses", "open_ui",
```

`packages/mcp/src/tools/mock.ts:3-6` import 수정 전:
```ts
import {
  assertLanguage, defaultMockDir, finalizeGeneration, findFeature, generate, listFeatures, prepareGeneration, readLock, readSessionMarker, select,
  SUPPORTED_LANGUAGES, verifyMock, type OnEvent, type Workspace,
} from "@specmock/core";
```

수정 후:
```ts
import {
  assertLanguage, defaultMockDir, finalizeGeneration, findFeature, generate, listFeatures, prepareGeneration, readLock, readSessionMarker, recordResponses, select,
  SUPPORTED_LANGUAGES, verifyMock, type OnEvent, type Workspace,
} from "@specmock/core";
```

`verify_mock` 등록(`}));`) 뒤, `registerMockTools`의 닫는 `}` 앞에 추가:
```ts
  server.registerTool("record_responses", {
    title: "실제 시스템 녹화",
    description: "mockspec의 정상 요청 contract를 .specmock/<system>/target.json의 실제 시스템에 보내 응답을 recorded/에 저장하고 drift.md(스펙과 실제의 차이)를 쓴다. 기본은 GET·HEAD만 보낸다. 녹화 뒤 select → generate를 다시 실행해 mock fixture에 반영한다(LLM은 부르지 않는다). target.json이 없으면 오류에 예시가 있다 — 사용자에게 만들어 달라고 한다. 헤더의 ${ENV}는 Claude Code를 실행한 셸의 환경변수에서 읽는다.",
    inputSchema: z.object({
      system: SystemArg,
      allowMutating: z.boolean().optional().describe("POST·PUT·PATCH·DELETE도 보낸다. 실제 데이터가 바뀔 수 있으므로 반드시 사용자에게 대상 시스템과 요청 목록을 알리고 확인받은 뒤에만 true"),
      features: z.array(z.string()).optional().describe("이 기능 id만 녹화"),
      refresh: z.boolean().optional().describe("기존 녹화를 모두 지우고 다시 녹화"),
      apply: z.boolean().optional().describe("기본 true. false면 녹화·drift만"),
    }),
    outputSchema: z.object({
      baseUrl: z.string(),
      recorded: z.array(z.string()),
      matched: z.array(z.string()),
      drifted: z.array(z.object({ featureId: z.string(), errors: z.array(z.string()) })),
      statusMismatch: z.array(z.object({ featureId: z.string(), expected: z.number(), actual: z.number(), hint: z.string().optional() })),
      skipped: z.array(z.object({ featureId: z.string(), reason: z.literal("mutating") })),
      failed: z.array(z.object({ featureId: z.string(), reason: z.string() })),
      applied: z.object({ selected: z.number(), generated: z.boolean(), outDir: z.string().nullable(), preserved: z.array(z.string()) }).nullable(),
      notes: z.array(z.string()),
      driftPath: z.string(),
      driftSummary: z.string(),
    }),
  }, guard(async ({ system, allowMutating, features, refresh, apply }, ctx) => {
    const v = await withProgress(ctx, onEvent, (ev) => recordResponses(ws, system, { allowMutating, features, refresh, apply, onEvent: ev }), opts.heartbeatMs ?? 5000, "record");
    const r = v.result;
    const g = r.applied?.generate ?? null;
    // drift.md 머리(제목·요약 줄) + 다름·불일치 항목. 건너뜀·실패 목록은 구조화 결과에 있다.
    const md = v.driftMarkdown.split("\n");
    const items = md.filter((l, i) => l.startsWith("- ") && md.slice(0, i).reverse().find((x) => x.startsWith("## "))?.match(/^## (스펙과 다름|상태 불일치)$/));
    const driftSummary = [md[0], md[1], ...items].join("\n");
    const data = {
      baseUrl: r.baseUrl, recorded: r.recorded, matched: r.matched, drifted: r.drifted, statusMismatch: r.statusMismatch, skipped: r.skipped, failed: r.failed,
      applied: r.applied ? { selected: r.applied.selected, generated: g !== null, outDir: g?.outDir ?? null, preserved: g?.preserved ?? [] } : null,
      notes: v.notes, driftPath: absPath(ws.dir(system), v.driftPath), driftSummary,
    };
    return ok(`${driftSummary}\n\ndrift: ${data.driftPath}${v.notes.length ? `\n${v.notes.map((n) => `- ${n}`).join("\n")}` : ""}`, data);
  }));
```

`applied`는 `GenerateReport` 전체 대신 `generated`·`outDir`·`preserved`로 줄인다(도구 응답 크기). drift.md 머리 두 줄은 Task 4 `renderDrift`의 제목·요약 줄이다.

- [ ] **Step 4: SKILL.md**

`plugin/skills/specmock/SKILL.md:28` `| \`verify_mock\` | contract test + coverage.md |` 바로 뒤에 추가:
```markdown
| `record_responses` | `target.json`의 실제 시스템에 정상 요청을 보내 녹화 + drift.md, mock fixture에 반영 (`allowMutating`, `features`, `refresh`, `apply`) |
```

`:42`(4번 항목) 하위 목록 맨 끝(`open_ui` 줄 뒤)에 추가:
```markdown
   - 사용자가 "실제 응답으로 바꾸고 싶다" · "실제 시스템과 비교해 달라"고 하면 `record_responses`. `target.json`이 없다는 오류면 예시를 보여 주고 사용자에게 만들어 달라고 한다(비밀 값은 `${환경변수}`로만). `driftSummary`를 보여 주고 다름·불일치가 있으면 스펙과 실제 중 어느 쪽이 맞는지 묻는다.
```

안전 규칙 목록(`:56` `submit_extraction`의 `ok: false` 줄) 바로 뒤에 추가:
```markdown
- `record_responses`의 `allowMutating: true`는 실제 시스템에 생성·삭제 요청을 보낸다. 대상 `baseUrl`과 건너뛴 기능(`skipped`)을 알리고 확인받은 뒤에만 쓴다. `target.json` 헤더의 `${ENV}`는 Claude Code를 실행한 셸에 있어야 한다. 없다는 오류면 그 셸에서 변수를 설정하고 Claude Code를 다시 띄우라고 안내한다. 사용자에게 키 값을 대화에 붙여 넣으라고 하지 않는다.
```

CLI 블록(`:115` `specmock verify <system> …` 줄) 바로 뒤에 추가:
```bash
specmock record <system> [--allow-mutating] [--feature <id>] [--refresh] [--no-apply] [--json]   # 실제 시스템 녹화 → drift.md, 종료 코드 2 = drift
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm build && pnpm vitest run packages/mcp/test packages/cli/test/plugin.test.ts`
Expected: PASS. cli plugin.test는 SKILL.md의 `specmock record … --allow-mutating --feature --refresh --no-apply --json`이 `specmock record --help`에 있는지 대조한다. `pnpm -F @specmock/mcp typecheck` 오류 0.

- [ ] **Step 6: 커밋**

```bash
git add packages/mcp/src/names.ts packages/mcp/src/tools/mock.ts packages/mcp/test/tools.test.ts packages/mcp/test/plugin.test.ts plugin/skills/specmock/SKILL.md
git commit -m "feat(mcp): add record_responses tool and skill docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 11: ui-server `target`·`record` 라우트와 job kind

**Files:**
- Modify: `packages/ui-server/src/api-types.ts:32`(JobKind)
- Modify: `packages/ui-server/src/jobs.ts:20`(CANCELLABLE)
- Modify: `packages/ui-server/src/security.ts:21`(POST_ONLY)
- Modify: `packages/ui-server/src/app.ts:5`(import), `:18` 뒤(Body), `:137` 뒤(라우트)
- Test: `packages/ui-server/test/api.test.ts`(끝에 describe)

결정 D18(이 Task에서 추가): `GET target`은 설계의 `{ exists, baseUrl? }`에 `example`(TARGET_EXAMPLE, 화면의 복사 버튼용 — 웹에 같은 문자열을 두 번 두지 않는다)과 `error?`(형식 오류 문구, 필드 이름만 담긴다)를 더한다. env 치환은 하지 않는다 — 존재·형식만 본다(모든 변수를 빈 값으로 보는 env를 넘긴다). headers·params는 응답에 싣지 않는다.

- [ ] **Step 1: 실패하는 테스트**

`packages/ui-server/test/api.test.ts` import에 추가(기존 `node:fs/promises` 줄에 `mkdir` 추가):
```ts
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
```

파일 끝에 추가:
```ts
describe("record (3B)", () => {
  let real: Server | undefined;
  afterEach(async () => { real?.closeAllConnections(); await new Promise<void>((r) => (real ? real.close(() => r()) : r())); real = undefined; });
  /** hang이면 응답하지 않는다(취소 테스트용). */
  async function realSystem(hang = false): Promise<string> {
    real = createServer((req, res) => {
      if (hang) return;
      const ok = req.method === "GET" && /^\/pets\/[^/?]+/.test(req.url!);
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { id: 1, name: "Real" } : {}));
    });
    await new Promise<void>((r) => real!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(real!.address() as AddressInfo).port}`;
  }
  async function prepare(c: ReturnType<typeof client>, target?: unknown) {
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    await c.post("/systems/petstore/selection", { ids: ["getPet"] });
    if (target) {
      await mkdir(path.join(root, ".specmock", "petstore"), { recursive: true });
      await writeFile(path.join(root, ".specmock", "petstore", "target.json"), JSON.stringify(target));
    }
  }
  const finished = async (c: ReturnType<typeof client>) => {
    await vi.waitFor(async () => expect((await c.get("/jobs")).body.data.running).toHaveLength(0), { timeout: 10_000 });
    return (await c.get("/jobs")).body.data.recent[0] as { kind: string; state: string; cancellable: boolean; result?: { result: { matched: string[] }; driftMarkdown: string } };
  };

  it("GET target: 없으면 exists false와 예시", async () => {
    const c = client();
    await prepare(c);
    const r = await c.get("/systems/petstore/target");
    expect(r.body).toEqual({ ok: true, data: { exists: false, example: expect.stringContaining("https://api.example.com/v2") } });
  });

  it("GET target: baseUrl만 싣고 headers·params·환경변수 이름은 싣지 않는다", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://real.example.com/v2/", headers: { Authorization: "Bearer ${UI_SECRET_TOKEN}" }, params: { petId: "777" } });
    const r = await c.get("/systems/petstore/target");
    expect(r.body.data).toMatchObject({ exists: true, baseUrl: "https://real.example.com/v2" });
    const text = JSON.stringify(r.body);
    for (const s of ["Authorization", "UI_SECRET_TOKEN", "777"]) expect(text).not.toContain(s);
  });

  it("GET target: 형식 오류는 exists true + error(필드 이름)", async () => {
    const c = client();
    await prepare(c, { baseUrl: "https://x.example.com", header: {} });
    expect((await c.get("/systems/petstore/target")).body.data).toMatchObject({ exists: true, error: expect.stringContaining("header") });
  });

  it("POST record → job kind record(취소 가능), 끝나면 결과와 drift 본문", async () => {
    const c = client();
    await prepare(c, { baseUrl: await realSystem() });
    const r = await c.post("/systems/petstore/record", { allowMutating: false });
    expect(r.status).toBe(202);
    const j = await finished(c);
    expect(j).toMatchObject({ kind: "record", state: "done", cancellable: true });
    expect(j.result!.result.matched).toEqual(["getPet"]);
    expect(j.result!.driftMarkdown).toContain("# petstore 실제 시스템 대조 (");
    expect(await readdir(path.join(root, ".specmock", "petstore", "recorded"))).toEqual(["getPet.json"]);
  });

  it("record 진행 중 두 번째 POST는 409 busy, 취소하면 cancelled", async () => {
    const c = client();
    await prepare(c, { baseUrl: await realSystem(true), timeoutMs: 30_000 });
    const first = await c.post("/systems/petstore/record");
    const second = await c.post("/systems/petstore/record");
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ ok: false, error: { code: "busy" }, jobId: first.body.data.jobId });
    await c.post(`/jobs/${first.body.data.jobId}/cancel`);
    expect((await finished(c)).state).toBe("cancelled");
  });

  it("GET /record는 405", async () => {
    const c = client();
    await prepare(c);
    expect((await c.get("/systems/petstore/record")).status).toBe(405);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm build && pnpm vitest run packages/ui-server/test/api.test.ts -t "record \(3B\)"`
Expected: FAIL — `/target`·`/record`가 404(`not-found`), GET `/record`는 405가 아닌 404.

- [ ] **Step 3: 구현**

`packages/ui-server/src/api-types.ts:32` 수정 전/후:
```ts
export type JobKind = "extract" | "generate" | "verify";
```

```ts
export type JobKind = "extract" | "generate" | "verify" | "record";
```

`packages/ui-server/src/jobs.ts:20` 수정 전/후:
```ts
const CANCELLABLE: Record<JobKind, boolean> = { extract: true, verify: true, generate: true };
```

```ts
const CANCELLABLE: Record<JobKind, boolean> = { extract: true, verify: true, generate: true, record: true };
```

`packages/ui-server/src/security.ts:21` 수정 전/후:
```ts
const POST_ONLY = /^\/api\/(?:systems\/[^/]+\/(?:analyze|extract|generate|verify)|jobs\/[^/]+\/cancel)\/?$/;
```

```ts
const POST_ONLY = /^\/api\/(?:systems\/[^/]+\/(?:analyze|extract|generate|verify|record)|jobs\/[^/]+\/cancel)\/?$/;
```

`packages/ui-server/src/app.ts:5` import에 `ClaudeCodeAdapter` 옆으로 `readTarget, recordResponses, TARGET_EXAMPLE`를 추가한다(알파벳 순 유지):
```ts
import { analyzeSpec, assertLanguage, CatalogSchema, ClaudeCodeAdapter, findFeature, generate, ingestSpec, listFeatures, readLock, readTarget, recordResponses, select, summarizeChunks, TARGET_EXAMPLE, verifyMock, Workspace } from "@specmock/core";
```

`:18` `const VerifyBody = …` 뒤에 추가:
```ts
const RecordBody = z.object({ allowMutating: z.boolean().optional(), refresh: z.boolean().optional() });
/** GET target은 존재·형식만 본다. 모든 `${ENV}`를 빈 값으로 치환해 env 오류가 나지 않게 한다(치환 결과는 버린다). */
const ANY_ENV: Record<string, string> = new Proxy({}, { get: () => "" });
```

verify 라우트(`app.post("/api/systems/:s/verify", …);`, `:131-137`) 바로 뒤에 추가:
```ts
  // target.json의 headers·params는 응답·로그에 싣지 않는다(비밀). baseUrl만 보인다.
  app.get("/api/systems/:s/target", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    try {
      const t = await readTarget(ws, system, ANY_ENV);
      return ok(c, { exists: true, baseUrl: t.baseUrl, example: TARGET_EXAMPLE });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("이(가) 없습니다")) return ok(c, { exists: false, example: TARGET_EXAMPLE });
      return ok(c, { exists: true, error: message, example: TARGET_EXAMPLE });
    }
  });
  app.post("/api/systems/:s/record", async (c) => {
    const system = c.req.param("s");
    const b = await optionalBody(c, RecordBody);
    await assertRegistered(ws, system);
    return accepted(c, jobs.start(system, "record", ({ signal, onEvent }) => recordResponses(ws, system, {
      allowMutating: b.allowMutating, refresh: b.refresh, signal, onEvent,
      adapter: new ClaudeCodeAdapter({ command: claudeCommand }),
    })).id);
  });
```

`adapter`는 apply 단계의 generate가 LLM lock을 만나도 부르지 않지만(inputHash가 같을 때만 fixture만 다시 쓴다, Task 7), 서비스 시그니처가 받으므로 다른 라우트와 같이 넘긴다. job 결과는 `RecordResponsesResult`(`result`·`driftPath`·`driftMarkdown`·`notes`)를 그대로 싣는다 — target 원문·헤더 값은 들어 있지 않다(Task 5 `record()`가 `maskHeaders`를 거친 요청 헤더만 recorded에 쓴다).

- [ ] **Step 4: 통과 확인**

Run: `pnpm build && pnpm vitest run packages/ui-server/test`
Expected: PASS(기존 포함). `pnpm -F @specmock/ui-server typecheck` 오류 0.

- [ ] **Step 5: 커밋**

```bash
git add packages/ui-server/src/api-types.ts packages/ui-server/src/jobs.ts packages/ui-server/src/security.ts packages/ui-server/src/app.ts packages/ui-server/test/api.test.ts
git commit -m "feat(ui-server): add target and record routes with record job kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 12: Web "실제 시스템" 카드

**Files:**
- Modify: `packages/web/src/format.ts:3`(JOB_KIND_LABEL), `packages/web/src/api.ts:30` 뒤(target·record)
- Create: `packages/web/src/components/RecordCard.tsx`
- Modify: `packages/web/src/screens/Verify.tsx:8`(import), `:142`(카드 위치)
- Test: `packages/web/test/Verify.test.tsx`, `packages/web/test/coverage.test.ts`

`test/fakes.ts`는 경로별 가짜 응답을 받는 범용 도구라 바꾸지 않는다. 대신 `Verify.test.tsx`의 `setup()` 기본 경로에 `GET …/target`을 더한다(없으면 fakeApi가 404를 돌려준다). 기존 테스트가 `pre.coverage`가 없음을 확인하므로 카드의 `<pre>`는 `record-example`·`drift` 클래스를 쓴다.

- [ ] **Step 1: 실패하는 테스트**

`packages/web/test/Verify.test.tsx`의 `setup()` 경로 목록에서 `"POST /api/jobs/v1/cancel": …` 줄 뒤에 추가:
```ts
    "GET /api/systems/petstore/target": ok({ exists: false, example: "{\n  \"baseUrl\": \"https://api.example.com/v2\"\n}" }),
```

파일 끝에 추가:
```ts
it("target.json이 없으면 만들라는 안내와 예시, 녹화 버튼 없음", async () => {
  setup();
  render(<App />);
  const card = await screen.findByRole("region", { name: "실제 시스템" });
  expect(await within(card).findByText(/target\.json/)).toBeTruthy();
  expect(card.querySelector("pre.record-example")!.textContent).toContain("https://api.example.com/v2");
  expect(within(card).getByRole("button", { name: "예시 복사" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "녹화" })).toBeNull();
});

it("녹화: 변경 요청 포함 → POST /record {allowMutating:true}, 끝나면 요약·drift 본문", async () => {
  const api = setup({}, null, {
    "GET /api/systems/petstore/target": ok({ exists: true, baseUrl: "https://real.example.com/v2", example: "{}" }),
    "POST /api/systems/petstore/record": () => ({ status: 202, body: { ok: true, data: { jobId: "r1" } } }),
  });
  render(<App />);
  const card = await screen.findByRole("region", { name: "실제 시스템" });
  expect(await within(card).findByText("https://real.example.com/v2")).toBeTruthy();
  fireEvent.click(within(card).getByRole("checkbox", { name: /변경 요청 포함/ }));
  fireEvent.click(within(card).getByRole("button", { name: "녹화" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/record"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/petstore/record")]).toEqual({ allowMutating: true });
  const rj = { id: "r1", system: "petstore", kind: "record", state: "running", cancellable: true, startedAt: "t" };
  emit("job-started", rj);
  expect(await within(card).findByRole("button", { name: "녹화 취소" })).toBeTruthy();
  emit("job-done", { ...rj, state: "done", result: {
    result: { baseUrl: "https://real.example.com/v2", matched: ["getPet"], drifted: [{ featureId: "listPets", errors: ["body.id 없음"] }], statusMismatch: [], skipped: [{ featureId: "createPet", reason: "mutating" }], failed: [] },
    driftPath: "drift.md", driftMarkdown: "# petstore 실제 시스템 대조 (t, https://real.example.com/v2)\n\n## 스펙과 다름\n\n- `listPets`: body.id 없음", notes: ["generate를 실행하면 반영됩니다"],
  } });
  expect(await within(card).findByText("일치 1 · 스펙과 다름 1 · 상태 불일치 0 · 건너뜀 1 · 실패 0")).toBeTruthy();
  expect(card.querySelector("pre.drift")!.textContent).toContain("body.id 없음");
  expect(within(card).getByText("generate를 실행하면 반영됩니다")).toBeTruthy();
});
```

`packages/web/test/coverage.test.ts` 끝에 추가(설계 §3.3: 파서는 행 수 고정이 아님을 확인):
```ts
it("recorded 행이 더해진 5행 표도 푼다", () => {
  const md = MD.replace("| spec-example |", "| recorded | 1 | 실제 시스템 응답을 녹화 |\n| spec-example |");
  const parsed = parseCoverage(md)!;
  expect(parsed.sources).toHaveLength(5);
  expect(parsed.sources[0]).toEqual({ name: "recorded", count: 1, meaning: "실제 시스템 응답을 녹화" });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm build && pnpm vitest run packages/web/test/Verify.test.tsx packages/web/test/coverage.test.ts`
Expected: Verify 새 테스트 2개 FAIL(region "실제 시스템" 없음). coverage 새 테스트는 이미 PASS(파서 변경 불필요 — 회귀 방지용).

- [ ] **Step 3: 구현**

`packages/web/src/format.ts:3` 수정 전/후:
```ts
export const JOB_KIND_LABEL: Record<string, string> = { extract: "추출", generate: "생성", verify: "검증" };
```

```ts
export const JOB_KIND_LABEL: Record<string, string> = { extract: "추출", generate: "생성", verify: "검증", record: "녹화" };
```

`packages/web/src/api.ts` — `ApiError` 클래스 뒤에 타입 추가:
```ts
/** GET /api/systems/:s/target. headers·params는 서버가 싣지 않는다. */
export interface TargetInfo { exists: boolean; baseUrl?: string; error?: string; example: string }
```

`:30` `verify: …` 줄 뒤에 추가:
```ts
  target: (name: string) => call<TargetInfo>("GET", `${s(name)}/target`),
  record: (name: string, allowMutating: boolean) => call<{ jobId: string }>("POST", `${s(name)}/record`, { allowMutating }),
```

`packages/web/src/components/RecordCard.tsx`(새 파일):
```tsx
import type { Job } from "@specmock/ui-server/api-types";
import { useEffect, useState } from "react";
import { ApiError, api, type TargetInfo } from "../api";
import { useJob } from "../useJob";
import { Notice } from "./Notice";

/** core RecordResponsesResult(service/record.ts) 중 화면이 쓰는 부분. */
interface RecordDone {
  result: { baseUrl: string; matched: string[]; drifted: unknown[]; statusMismatch: unknown[]; skipped: unknown[]; failed: unknown[] };
  driftMarkdown: string;
  notes: string[];
}
interface Props { system: string; jobs: Job[]; tick: number; refreshJobs: () => void }

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

/** ⑤ 화면의 "실제 시스템" 카드. target.json 편집은 하지 않는다(브라우저에 비밀을 받지 않는다). */
export function RecordCard({ system, jobs, tick, refreshJobs }: Props) {
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { last, running, seen, watch } = useJob(jobs, system, "record");

  useEffect(() => {
    api.target(system).then((t) => { setTarget(t); setUnreadable(false); }).catch(() => setUnreadable(true));
  }, [system, tick]);

  const start = async () => {
    setError(null);
    try { const r = await api.record(system, mutating); watch(r.jobId); refreshJobs(); } catch (e) {
      const err = asError(e);
      if (err.code === "busy" && err.jobId) watch(err.jobId);
      setError(err); refreshJobs();
    }
  };
  const copy = () => { void navigator.clipboard?.writeText(target!.example).then(() => setCopied(true)); };

  const other = jobs.find((j) => j.system === system && j.kind !== "record" && j.state === "running");
  const done = last?.state === "done" ? (last.result as RecordDone | undefined) : undefined;
  const r = done?.result;
  return (
    <section className="record-card" aria-label="실제 시스템">
      <h3 className="cov-h">실제 시스템</h3>
      {error && !(error.code === "busy" && running) ? <Notice message={error.message} hint={error.hint} /> : null}
      {seen?.state === "failed" ? <Notice message={seen.error?.message ?? "녹화에 실패했어요"} hint={seen.error?.hint} /> : null}
      {seen?.state === "cancelled" ? <p className="muted">녹화를 취소했어요.</p> : null}
      {unreadable ? <p className="muted">실제 시스템 설정을 읽지 못했어요.</p> : !target ? null : !target.exists ? (
        <div>
          <p className="muted"><code>.specmock/{system}/target.json</code>을 만들어 주세요. 비밀 값은 <code>{"${환경변수}"}</code>로만 적어요(파일을 커밋하지 마세요).</p>
          <pre className="record-example">{target.example}</pre>
          <button type="button" className="btn-ghost" onClick={copy}>{copied ? "복사했어요" : "예시 복사"}</button>
        </div>
      ) : target.error ? <Notice message={target.error} /> : running ? (
        <div className="progress-row">
          <span className="muted">{running.progress?.message ?? "녹화를 시작했어요"}</span>
          {running.cancellable ? <button type="button" className="btn-ghost" onClick={() => void api.cancel(running.id).then(refreshJobs, (e: unknown) => setError(asError(e)))}>녹화 취소</button> : null}
        </div>
      ) : (
        <div>
          <p className="muted">대상 <code>{target.baseUrl}</code></p>
          <label><input type="checkbox" checked={mutating} onChange={(e) => setMutating(e.target.checked)} /> 변경 요청 포함 (POST·PUT·PATCH·DELETE — 실제 데이터가 바뀔 수 있어요)</label>
          <div><button type="button" className="btn-primary" disabled={!!other} onClick={() => void start()}>녹화</button></div>
        </div>
      )}
      {r && done ? (
        <>
          <p className="summary"><strong>일치 {r.matched.length} · 스펙과 다름 {r.drifted.length} · 상태 불일치 {r.statusMismatch.length} · 건너뜀 {r.skipped.length} · 실패 {r.failed.length}</strong></p>
          {done.notes.length ? <ul className="cov-list">{done.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          <pre className="drift">{done.driftMarkdown}</pre>
        </>
      ) : null}
    </section>
  );
}
```

`packages/web/src/screens/Verify.tsx:8` 뒤에 `import { RecordCard } from "../components/RecordCard";`를 추가한다. `:142` 수정 전:
```tsx
      {cov ? <Coverage data={cov} /> : md ? <pre className="coverage">{coverageSummary(md)}</pre> : null}
```

수정 후(녹화는 generate 없이도 할 수 있으므로 `notGenerated`와 무관하게 보인다, D17):
```tsx
      <RecordCard system={system} jobs={jobs} tick={tick} refreshJobs={refreshJobs} />
      {cov ? <Coverage data={cov} /> : md ? <pre className="coverage">{coverageSummary(md)}</pre> : null}
```

Verify의 `other`(`:87`)는 `kind !== "verify"`라 녹화 중에는 "다른 작업(녹화)이 진행 중이에요"가 보인다 — `JOB_KIND_LABEL`에 `record`를 더한 이유다. `styles/`는 기존 클래스(`cov-h`·`cov-list`·`summary`·`progress-row`)를 재사용하고, `packages/web/src/styles/app.css:145` `.cmd, .coverage { … }`의 선택자를 `.cmd, .coverage, .record-example, .drift { … }`로 바꾼다(규칙 본문 그대로).

- [ ] **Step 4: 통과 확인**

Run: `pnpm build && pnpm vitest run packages/web/test`
Expected: PASS(기존 Verify 테스트 포함 — `setup()`에 target 경로가 있어 alert가 생기지 않는다). `pnpm -F @specmock/web typecheck` 오류 0.

- [ ] **Step 5: 커밋**

```bash
git add packages/web/src packages/web/test/Verify.test.tsx packages/web/test/coverage.test.ts
git commit -m "feat(web): add real-system record card to verify screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Task 13: 문서, `pnpm record:check`, 최종 확인

**Files:**
- Create: `scripts/record-check.ts` · Modify: `package.json:18` 뒤(스크립트)
- Modify: `README.md:334` 뒤(새 절), `:374`(명령), `:387`(로드맵) · `docs/architecture.md:122` 뒤(상태 파일), `:225`(로드맵)
- Modify: `docs/superpowers/specs/2026-11-04-specmock-design.md:536`(§10), `:545` 뒤(§11) · `docs/superpowers/specs/2026-11-09-phase3b-record-design.md` 끝(구현 중 변경)

대상 공개 API는 키가 필요 없는 Swagger Petstore v3(`https://petstore3.swagger.io/api/v3`, 스펙 `/openapi.json`)다. 공용 데모라 데이터가 늘 바뀌므로 **drift(종료 코드 2)도 성공**으로 본다. 실패 기준은 오류(1)와 "요청 0건 · 녹화 0건"뿐이다. 변경 요청은 보내지 않는다(`allowMutating` 없음, `apply: false`).

- [ ] **Step 1: 스크립트**

`scripts/record-check.ts`:
```ts
// pnpm record:check   (= pnpm build:core && tsx scripts/record-check.ts)
// 공개 Swagger Petstore v3에 GET만 보내 record가 실제 네트워크에서 동작하는지 본다. 키 불필요. 데모 데이터가 바뀌므로 drift는 정상.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeSpec, ingestSpec, recordResponses, select, Workspace } from "@specmock/core";

const BASE = "https://petstore3.swagger.io/api/v3";
const root = await mkdtemp(path.join(os.tmpdir(), "specmock-record-check-"));
try {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "petstore3", [`${BASE}/openapi.json`]);
  await analyzeSpec(ws, "petstore3");
  await select(ws, "petstore3", ["all"]);
  await writeFile(ws.file("petstore3", "target.json"), JSON.stringify({ baseUrl: BASE, params: { petId: "1", orderId: "1", username: "user1" } }));
  const { result, driftMarkdown } = await recordResponses(ws, "petstore3", { apply: false, onEvent: (e) => console.error(e.message) });
  console.log(driftMarkdown);
  const sent = result.matched.length + result.drifted.length + result.statusMismatch.length + result.failed.length;
  console.log(`요청 ${sent} · 녹화 ${result.recorded.length} · 건너뜀(변경 요청) ${result.skipped.length}`);
  process.exit(sent > 0 && result.recorded.length > 0 ? 0 : 1);
} finally {
  await rm(root, { recursive: true, force: true });
}
```

`package.json`의 `"llm:check": …,` 줄 뒤에 `"record:check": "pnpm -s build:core && tsx scripts/record-check.ts",`를 추가한다.

- [ ] **Step 2: 실행**

Run: `pnpm typecheck && pnpm record:check; echo "exit=$?"`
Expected: typecheck 오류 0(`tsconfig.scripts.json`이 `scripts/`를 포함). drift.md 본문과 `요청 N · 녹화 M …`(N, M > 0), `exit=0`. 네트워크가 없으면 첫 요청 연결 실패로 exit=1 — 수동 확인 전용이라 `pnpm test`에 넣지 않는다.

- [ ] **Step 3: 문서**

`README.md` "커버리지 리포트" 절(`:334`) 끝에 출처 목록을 `recorded / spec-example / doc-sample / schema-generated / empty`로 고치고, 그 절 뒤에 새 절을 넣는다:
````markdown
## 실제 시스템 녹화

실제 시스템이 있으면 정상 요청을 보내 응답을 fixture로 씁니다. `.specmock/<system>/target.json`을 직접 만듭니다.

```json
{ "baseUrl": "https://api.example.com/v2", "headers": { "Authorization": "Bearer ${PETS_TOKEN}" }, "params": { "petId": "123" } }
```

- 비밀 값은 `${환경변수}`로만 적습니다. 값은 실행한 셸의 환경변수에서 읽고 파일·로그·drift.md에 남기지 않습니다. 그래도 이 파일은 커밋하지 마세요(`.gitignore`에 `.specmock/*/target.json`).
- `specmock record <system>`은 GET·HEAD만 보냅니다. 생성·삭제 요청까지 보내려면 `--allow-mutating`(실제 데이터가 바뀝니다). `--feature <id>`로 일부만, `--refresh`로 기존 녹화를 지우고 다시, `--no-apply`로 mock 반영 없이 녹화만 합니다.
- 결과: `.specmock/<system>/recorded/<기능>.json`, 스펙과의 차이는 `drift.md`("스펙과 다름" = 응답이 스키마와 다름, "상태 불일치" = 기대한 상태 코드가 아님. 404면 `params`로 실제 id를 지정). 녹화 응답은 fixture 출처 `recorded`로 들어가고, 이미 생성한 mock은 LLM 호출 없이 fixture만 바뀝니다. 직접 고친 fixture는 보존됩니다.
- 종료 코드: 0 전부 일치 · 2 drift 있음 · 1 오류. 동작 확인: `pnpm record:check`(공개 Petstore v3, 네트워크 필요).
````

`README.md:374` 줄 끝에 ` 실제 네트워크 녹화 확인은 \`pnpm record:check\`입니다.`를 붙인다. `:387` `| 3 | Proxy/녹화, API 키 어댑터, 다른 언어 프로필 추가 |` → `| 3 | 녹화(record, 3B 완료), 다른 언어 생성(3A 완료), API 키 어댑터 |`.

`docs/architecture.md:122` `coverage.md` 행 뒤에 추가:
```markdown
| `target.json` | 사용자 | record | 실제 시스템 `baseUrl`·`headers`(`${ENV}`만)·`params`·`timeoutMs`. 커밋 금지 |
| `recorded/<기능>.json` | record | select | 실제 응답(상태·헤더·본문, 비밀 마스킹)과 `specHash` |
| `drift.md` | record | 사용자 | 스펙과 다름·상태 불일치·건너뜀·실패 |
```

`:225` `Proxy/녹화 · API 키                  :a4, after a3, 1` → `녹화(record, 3B) · API 키           :a4, after a3, 1`.

설계 문서 `2026-11-04-specmock-design.md:536` 문단의 마지막 문장 "Proxy/녹화와 API 키 어댑터는 남은 3단계다."를 다음으로 바꾼다:
```markdown
3B는 프록시 대신 `record` 명령이다: mockspec의 정상 contract를 `target.json`의 실제 시스템에 보내 `recorded/`에 저장하고 `drift.md`를 쓴다. `select`는 녹화를 최우선 fixture 출처 `recorded`로 쓰고, `generate`는 입력(`inputHash`)이 같으면 LLM 없이 fixture만 다시 쓴다. MCP 도구는 13개(`record_responses`). 상세: [2026-11-09-phase3b-record-design.md](2026-11-09-phase3b-record-design.md), [계획](../plans/2026-11-09-phase3b-record.md). API 키 어댑터는 남은 3단계다.
```

`:545` 행 뒤(§11 표)에 추가:
```markdown
| 녹화는 끝나는 `record` 명령 | 상주 프록시 | ui-server 작업 구조(시스템당 하나·끝나는 작업)와 잠금에 맞고, HTTPS·요청↔기능 매칭 문제가 없다. 비밀은 `${ENV}`로만 |
```

`2026-11-09-phase3b-record-design.md` 끝에 추가(§6이 말하는 "구현 중 변경" 기록 자리. §7·§8은 이미 있으므로 새 번호):
```markdown
## 9. 구현 중 변경

계획 문서 "설계 문서 대비 결정 사항" D1–D18 중 설계와 달라진 것: generate lock에 `inputHash`를 두어 fixture만 바뀐 경우 LLM 없이 다시 씀(D4·D5), `applied.generate`가 `null`일 수 있음(generate 전 녹화, D17), `GET target`에 `example`·`error` 추가(D18). 리뷰로 바뀐 결정은 구현 뒤 이 절에 더한다.
```

- [ ] **Step 4: 최종 확인**

Run: `pnpm typecheck && pnpm test && git diff --stat d10311e -- packages/core/test/__snapshots__`
Expected: typecheck 오류 0, 테스트 전부 PASS(Task 0 기준선 + 새 테스트), TS 스냅샷 해시 파일 변경 없음(fixture 출처 문구만 바뀌는 `recorded`는 petstore에 녹화가 없어 출력에 나오지 않는다).

- [ ] **Step 5: 커밋**

```bash
git add scripts/record-check.ts package.json README.md docs/architecture.md docs/superpowers/specs/2026-11-04-specmock-design.md docs/superpowers/specs/2026-11-09-phase3b-record-design.md
git commit -m "docs: document record command and add record:check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
