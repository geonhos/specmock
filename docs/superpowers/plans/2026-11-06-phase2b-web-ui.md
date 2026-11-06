# Phase 2B: Web UI 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 웹 화면에서 스펙 등록 → 분석 → 기능 선택 → mock 생성 → 검증을 끝낸다. 화면 서버(`@specmock/ui-server`)는 2A 서비스 층의 얇은 래퍼이고, 화면(`@specmock/web`)은 React SPA다. 진입점은 CLI `specmock ui`와 MCP 도구 `open_ui`(도구 11개) 둘이다. 화면 서버가 두 번째 쓰기 주체가 되므로 core에 프로세스 간 파일 잠금과 취소 신호를 넣는다.

**Architecture:**
- core: `withSystemLock(ws, system, fn)`이 `<system>/.lock`을 `wx`로 만들어 프로세스 간 직렬화한다. 같은 프로세스 안에서는 기존 Promise 체인을 realpath 키로 유지한다. 대상은 추출 제출(`submitExtraction`), 선택 저장(`select`), 생성(`generate`)이다. 오래 걸리는 작업(추출·검증)은 `AbortSignal`을 받아 `claude`·npm·mock 자식 프로세스를 정리한다.
- ui-server: Hono 앱 하나(`createApp`)가 `/api/*` JSON, `/api/events` SSE, 그 밖의 경로는 웹 빌드 결과를 맡는다. `startUiServer({ root, port })`가 `127.0.0.1`에 바인딩한다. 추출·생성·검증은 작업(job)으로 돌리고 SSE로 진행을 알린다. 작업 공간은 `fs.watch(recursive)`로 감시해 `workspace-changed`를 보낸다.
- web: Vite 빌드 결과(`packages/web/dist`)를 ui-server가 서빙한다. API 응답 타입은 ui-server의 `api-types`(core 타입 재사용)를 type-only로 가져온다.

**Tech Stack:** 2A 스택에 다음을 더한다. 버전은 아래 "사전 확인된 사실"에서 배포일과 Node 22.19 호환을 확인했다.
- 화면 서버: hono ^4.13.16, @hono/node-server ^2.1.6. 둘 다 루트 devDependency로 이미 잠금 파일에 있다.
- 화면: react / react-dom ^19.3.1, @types/react / @types/react-dom ^19.3.0, vite ^8.3.5, @vitejs/plugin-react ^6.2.1.
- 화면 테스트: @testing-library/react ^16.3.3, @testing-library/user-event ^14.6.8, @testing-library/dom ^10.4.2, jsdom ^29.1.1.
- E2E: @playwright/test ^1.64.1. 별도 스크립트로 돌리고 기본 `pnpm test`에는 넣지 않는다.

**사전 확인된 사실 (2026-11-06, 이 기기 macOS / Node 26.10.0, pnpm 12.9.1):**

서비스 층의 진행 이벤트:
- `packages/core/src/service/events.ts`의 모양은 `OnEvent = (e: { stage, message, done?, total? }) => void` 하나다.
- `stage`는 `"ingest" | "analyze" | "extract" | "merge" | "select" | "generate" | "verify"` 중 하나다.
- 추출은 청크마다 `{ stage: "extract", message: "추출 d/t (청크 i: written|skipped|failed)", done, total }`를 낸다(`runLlmExtraction`이 `extract()`의 `onProgress`를 바꿔 냄).
- verify는 npm install을 할 때만 이벤트를 낸다(`onLog`). generate·select는 이벤트를 내지 않는다.

문서 추출의 `claude` 실행:
- `ClaudeCodeAdapter.extract`(`packages/core/src/llm/claudeCode.ts:31`)는 청크마다 `claude --print --output-format json --json-schema <schema> --no-session-persistence [--model m] --tools ""`를 `spawn`한다. 작업 디렉터리는 임시 디렉터리이고, 프롬프트는 stdin으로 넘긴다.
- 시간 초과(기본 180s)가 나면 SIGKILL을 보낸다. 취소 수단은 없다. `LlmAdapter.extract(req)`, `ExtractRequest`, `ExtractOptions`, `runLlmExtraction`, `AnalyzeSpecOptions` 어디에도 `signal`이 없다.
- `extract()`(`analyze/extract.ts:23`)는 청크를 순서대로 처리하고, 실패하면 `failed`에 기록한 뒤 다음 청크로 넘어간다. 이미 써진 청크는 `refresh` 없이 다시 돌리면 건너뛴다. 그래서 "실패 청크만 재시도"는 `refresh: false`로 다시 돌리면 된다.
- 검증: `ensureInstalled`(`verify/server.ts:51`)가 `npm install`을 spawn하고 `startMock`이 mock 서버를 spawn한다. 둘 다 취소 수단이 없다(`stop()`은 SIGTERM을 보내고 3s 뒤 SIGKILL).
- **core 변경 필요:** 취소를 위해 `signal`을 위 경로 전부에 넣어야 한다(Task 2).

동시성 (2A 실행 기록의 후속 과제와 같음):
- `submit.ts:48-55`의 잠금은 프로세스 안에서만 동작한다(`Map<string, Promise>` 체인).
- `submit.ts:90-91`에서 `NNN.json`은 잠금 **밖**에서 쓴다. 키(`ws.file(system, "extracted")`)는 realpath로 바꾸지 않는다. manifest 쓰기가 실패해도 `NNN.json`을 지우지 않는다.
- `extract()`는 메모리 manifest(`opts.manifest`)를 넘겨 잠금 안에서 그대로 쓴다. 그래서 다른 프로세스가 그 사이 기록한 항목을 덮어쓸 수 있다.
- `select`(`select/index.ts:90-93`)는 `selection.json`과 `mockspec.json`을, `generate`(`generate/index.ts:25-31`)는 `generate.json`을 잠금 없이 쓴다.
- `generate/lock.ts`의 `LOCK_FILE`(`specmock.lock.json`)은 mock 디렉터리 표식으로, 이름만 비슷하고 동시성 잠금과는 무관하다. 새 잠금 모듈 이름은 헷갈리지 않게 `workspaceLock.ts`로 한다.

`listFeatures`:
- 모르는 그룹을 주면 `알 수 없는 그룹: …`을 던진다(`service/features.ts:25`).
- 이 예외를 기대하는 테스트는 없다(`grep -rn "알 수 없는 그룹" packages/*/test` 0건).

서비스 층 오류:
- core·서비스 층에는 **오류 코드가 없다**. 모두 한국어 메시지를 담은 일반 `Error`다.
- 대표 메시지:
  - `<name> 파일이 없습니다 (<file>). 먼저 \`specmock analyze <s>\`를 실행하세요.` (`workspace.ts:48`)
  - `시스템 이름이 올바르지 않습니다`
  - `알 수 없는 기능 id`
  - `선택 결과가 비어 있습니다`
  - `…specmock이 만든 디렉터리가 아닙니다(specmock.lock.json 없음). 덮어쓰려면 --force`
- 2A MCP 층은 `rewriteHints`(`packages/mcp/src/result.ts:9`)로 CLI 명령을 도구 이름으로 바꾼다. 화면 서버도 같은 방식으로 바꾸되, 오류 코드는 새로 정한다.

`fs.watch({ recursive: true })` (직접 실행해 확인):
- Node 22.19.0 darwin(`npx node@22.19.0`), Node 22.19.0 linux(docker `node:22.19.0-slim`), Node 26.10 darwin 모두에서 동작한다.
- 감시를 시작한 뒤에 만든 하위 디렉터리 안의 쓰기도 잡는다.
- `filename`은 감시 루트 기준 상대 경로다(`petstore/extracted/000.json`). 원자 쓰기의 `*.tmp` 이름도 들어온다. linux는 `change` 이벤트도 낸다.
- 감시 대상 디렉터리는 미리 있어야 한다(없으면 ENOENT). 서버가 시작할 때 `.specmock`을 `mkdir -p`한다.
- 대안(chokidar, 폴링)은 필요 없다. 필터 규칙: 첫 경로 조각 = 시스템 이름, `*.tmp`·`.lock`·`*.stale`은 무시, 시스템별 150ms 디바운스.

빌드·테스트 설정:
- 루트 `package.json` scripts:
  - `build: pnpm -r build`
  - `test: pnpm build:mcp && vitest run`
  - `typecheck: pnpm build:core && pnpm -r typecheck && tsc -p tsconfig.scripts.json`
- `pnpm-workspace.yaml`은 `packages/*`다. 새 패키지는 `packages/ui-server`, `packages/web`에 두면 자동으로 포함된다.
- `pnpm -r build`는 의존 순서로 돈다(위상 정렬).
- `vitest.config.ts`는 `include: ["packages/*/test/**/*.test.ts"]`, timeout 60s, 환경은 node다. 웹 테스트(`.tsx`, jsdom)는 `test.projects`가 필요하다. vitest 5.1.0 타입에 `projects?: TestProjectConfiguration[]`이 있다.
- 패키지 공통 설정:
  - `tsconfig.json`: base 확장(NodeNext, `verbatimModuleSyntax`, strict), `rootDir src`, `outDir dist`.
  - `tsconfig.test.json`: `noEmit`, `types: ["node"]`, include `src` + `test`.
  - scripts: `build: tsc -p tsconfig.json`, `typecheck: tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`, `test: vitest run --root ../.. packages/<x>`.
- 워크트리에는 node_modules가 없다. 실행 전에 `pnpm install`이 필요하다.

버전과 배포일 (`pnpm view <pkg> time --json`, 기준 2026-11-06 12:01 UTC, release-age 1440분):
- react / react-dom 19.3.1 (10-14), @types/react·@types/react-dom 19.3.0 (09-09).
- vite: 최신 8.3.6은 11-05 05:40 배포다. 잠금 파일에는 이미 8.3.5가 있으므로 `^8.3.5`로 둔다. node 조건은 `^20.19 || >=22.12`.
- @vitejs/plugin-react 6.2.1 (11-02). peer는 vite ^8, node 조건은 `^20.19 || >=22.12`.
- @testing-library/react 16.3.3, user-event 14.6.8, dom 10.4.2.
- **jsdom 30·31은 `node ^22.22.2`를 요구해 Node 22.19와 맞지 않는다.** 그래서 jsdom ^29.1.1을 쓴다(node `^20.19 || ^22.13 || >=24`, 04-30 배포).
- **@playwright/test 1.65.0은 11-05 18:30 UTC 배포로 24시간이 안 돼 막힌다.** 그래서 1.64.1(10-14)을 쓴다.
- vitest 5.1.0 peer: vite `^6.4 || ^7 || ^8`, jsdom `*`.
- `hono/streaming`에 `streamSSE`가 있다(`dist/helper/streaming/sse.js`). `@hono/node-server`는 `serve`와 `serve-static`을 export한다.

MCP 도구 수가 10에서 11로 바뀔 때 깨지는 곳:
- `packages/mcp/test/tools.test.ts:20`: 테스트 이름 "10 tools".
- `packages/mcp/test/tools.test.ts:23`: `toHaveLength(10)`.
- `packages/mcp/test/tools.test.ts:205`, `:211`: `tools.length).toBe(10)`.
- `packages/mcp/test/plugin.test.ts:24`: 정규식 `` /`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock))`/g ``가 `open_ui`를 잡지 못한다. SKILL.md에 언급된 이름 집합과 `TOOL_NAMES`를 비교하므로, `|ui`를 더하지 않으면 실패한다.
- 문서: README 도구 표, `docs/superpowers/specs/2026-11-04-specmock-design.md:527` "MCP 도구는 10개다".

Playwright 브라우저:
- `pnpm install`은 브라우저를 받지 않는다. `pnpm exec playwright install chromium`이 따로 필요하고, 수백 MB를 내려받는다.
- 사용자는 `pnpm install && pnpm build && pnpm test`만 돌린다. 그래서 E2E는 별도 `pnpm test:e2e`로 둔다(설계 §7-1의 "새 clone에서 통과"를 지키기 위해서).

**설계 문서 대비 결정 사항 (이 계획에서 확정):**
1. **오류 코드는 화면 서버가 정한다.** 설계 §4.1은 "2A 서비스 층 코드 재사용"이라고 했지만, 서비스 층에는 코드가 없다.
   - 코드: `invalid` 400, `not-found` 404, `busy` 409, `overwrite-required` 409, `cancelled` 499, `failed` 500.
   - 변환은 `toApiError`가 오류 클래스(`LockBusyError`)와 메시지 패턴으로 한다. **취소(499)는 오류 이름이 아니라 ui-server가 쥔 `signal.aborted`로 판정한다**(Task 5의 작업 실행부가 `signal.aborted`이면 `cancelled`로 매핑). 자식 프로세스 오류가 AbortError 이름을 우연히 달고 와도, 또는 취소 후 다른 오류로 바뀌어 와도 사용자의 취소 의도가 기준이 되게 하기 위해서다.
   - hint 변환은 `rewriteHints`와 같은 방식이다(`specmock analyze x` → "② 분석").
2. **빈 선택은 저장하지 않는다.**
   - 이유: `select`가 빈 결과에 예외를 던지고(`select/index.ts:68`), 빈 mockspec은 생성할 것이 없다.
   - 화면은 모두 해제하면 하단 바에 "하나 이상 골라 주세요"를 띄운다. 저장된 선택은 바꾸지 않는다.
   - core는 바꾸지 않는다.
3. **화면의 등록은 `harvest: "never"`로 한다.**
   - 이유: ego-browser 수집은 최대 300s 걸리는 대화형 기능이라 동기 요청에 맞지 않는다.
   - 수집 후보로 판정되면 "브라우저 수집이 필요해 보여요" 안내와 함께 CLI(`specmock ingest <s> <url> --harvest always`)나 대화를 권한다.
4. **mock 기본 출력 경로는 `<root>/mock/<system>`을 명시해 넘긴다.**
   - 이유: `defaultMockDir`이 `process.cwd()` 기준이다. CLI `ui`는 cwd가 root라 같지만, 직접 넘겨 cwd에 기대지 않는다.
   - 이전에 생성한 경로가 있으면(`generate.json`의 outDir) 그 값을 기본값으로 한다.
5. **ui-server는 web에 런타임 의존만 한다.**
   - web 빌드 결과 경로는 `<ui-server>/../web/dist`로 정한다.
   - 의존 그래프는 `web → ui-server`(type-only devDependency) 한 방향이라 순환이 없다. `pnpm -r build`가 core → ui-server → web·mcp·cli 순서로 돈다.
   - 웹 빌드가 없으면 시작할 때 "`pnpm build`를 먼저 실행하세요"로 실패한다.
6. **루트 `test`를 `pnpm build && vitest run`으로 바꾼다.**
   - 이유: MCP `open_ui` 테스트와 CLI `ui` 테스트가 웹 빌드 결과를 쓴다. 기존 `build:mcp`는 web을 빌드하지 않는다.
   - `build:mcp` 스크립트는 남긴다.
7. **잠금 대상에 "선택 저장 전체"를 넣는다.** `select`의 읽기-계산-쓰기를 통째로 잠근다. `--add`/`--remove`가 이전 선택을 읽기 때문이다.
8. **`extract()`의 메모리 manifest를 쓰지 않는다.**
   - 잠금 안에서는 항상 디스크 manifest를 다시 읽고 키 하나만 갱신한다. 넘겨받은 `opts.manifest`에도 같은 키를 반영한다.
   - 이유: 다른 프로세스의 제출을 덮어쓰지 않기 위해서다.
   - 부작용: `extract()`가 메모리에서만 지운 낡은 키가 디스크에 남는다. 해당 `NNN.json`은 이미 지워졌으므로 `summarizeChunks`의 `done`과 다음 `extract()` 판정에는 영향이 없다.
9. **화면 서버 단독 실행에서만 브라우저를 연다.**
   - CLI `ui`는 `--no-open`이 없으면 `open`(darwin), `xdg-open`(linux), `cmd /c start`(win32)를 detached로 띄우고, 실패는 무시한다. `open` npm 패키지는 쓰지 않는다.
   - MCP `open_ui`는 URL만 돌려준다.
10. **MCP 안의 화면 서버는 프로세스를 붙잡지 않는다(`unref`).** HTTP 서버, 감시자, SSE 하트비트 타이머를 모두 unref한다. 그래서 Claude Code가 stdio를 닫으면 MCP 프로세스가 그대로 끝난다(설계 "MCP 서버가 끝나면 함께 종료").
11. **기준 시안과 토큰 표가 다른 곳은 토큰 표를 따른다.**
    - 크기 차이: 시안 h1 20px ↔ 토큰 24px, 상세 경로 18px ↔ 22px, 경로 12px ↔ 13.5px.
    - 단계 칩: 시안은 `border-radius: 999px`(알약 모양)인데, 설계는 "알약 배지 금지"다. 단계 칩은 `radius-sm`(8px)으로 한다.
    - 배치, 색, 행 모양은 시안을 따른다.
12. **`claude` CLI가 있는지는 PATH 탐색으로 판정한다**(`findExecutable`). 화면 서버는 테스트·E2E용 `claudeCommand` 옵션을 받는다(가짜 `claude` 실행 파일 경로).

13. **작업 공간 위치는 CLI의 `--workspace`를 따른다.** `startUiServer`·`createApp`에 `workspaceDir?`(기본 `<root>/.specmock`) 옵션을 둔다. `specmock ui`는 `root = process.cwd()`, `workspaceDir = path.resolve(--workspace)`를 넘긴다. 설계는 이 옵션을 말하지 않지만, 없으면 `--workspace`를 쓴 CLI 사용자의 상태가 화면에 보이지 않는다. 옵션은 Task 10 Step 2에서 더한다. 그때 Task 3·5 코드의 `path.join(opts.root, ".specmock")`(createApp의 Workspace, startUiServer의 mkdir·감시 경로)를 모두 `opts.workspaceDir ?? path.join(opts.root, ".specmock")`로 바꾼다.

**열린 가정 (해당 Task의 첫 단계에서 확인하고, 틀리면 실행 기록에 남긴다):**
- A1 (Task 6): vitest `test.projects`에 `packages/web/vite.config.ts` 경로를 넣으면, 그 파일의 `plugins`와 `test`(jsdom)가 적용되고 include가 그 디렉터리 기준으로 풀린다.
- A2 (Task 6): `packages/web`에서 `vitest/config`를 import하면, pnpm 엄격 모드에서도 상위의 루트 `node_modules/vitest`로 풀린다.
- A3 (Task 3): `@hono/node-server` 2.1.6의 `serve({ port: 0, hostname: "127.0.0.1" })`는 콜백 `info.port`로 실제 포트를 준다. 포트를 쓰는 중이면 반환된 서버에서 `error`(EADDRINUSE) 이벤트가 난다.
- A4 (Task 5): `app.request()`로 받은 SSE 응답 body(ReadableStream)를 테스트에서 조각 단위로 읽을 수 있다(소켓 없이 이벤트 순서 검증).
- A5 (Task 11): Playwright 1.64.1이 Node 22.19와 이 기기의 chromium에서 동작한다.

**지켜야 할 제약 (모든 Task 공통):**
- 사용자 환경에 개발자 개인 도구가 없다. 코드·문서·커밋 메시지·테스트 이름에 그 흔적을 남기지 않는다. 검사 테스트는 2A처럼 문자열을 조합해서 쓴다.
- 테스트는 실제 구독이나 모델을 호출하지 않는다. `packages/core/test/bin/`의 가짜 `claude` 실행 파일을 쓴다.
- 테스트의 가짜 비밀값은 실행 중에 조립한다. 예: `"sk_" + "live_" + "x".repeat(24)`.
- `packages/cli/test/cli.test.ts`는 수정 없이 통과해야 한다. CLI 기존 명령의 출력도 바꾸지 않는다.
- `.specmock/`, `mock/`, `e2e/.tmp/`, 웹 `dist/`는 커밋하지 않는다.
- 최신 버전이 release-age(1440분)에 막히면 바로 이전 버전으로 고정한다. 확인은 `pnpm view <pkg> time --json`으로 한다.
- 화면 문구는 해요체다. 그라데이션·알약 배지·이모지를 쓰지 않고, 웹 폰트를 번들하지 않는다.
- 각 Task는 실패하는 테스트를 먼저 돌려 실패 메시지를 확인한 뒤 구현한다. Task가 끝나면 `pnpm test`와 `pnpm typecheck`를 돌리고 커밋한다.

**이 계획에 없는 것:**
- 실행 중인 mock 서버 조작·요청 콘솔(3단계)
- 인증·원격 접속
- 마켓플레이스 배포
- `analyze_spec` 프롬프트 재전송 비용
- 2A 후속 과제 중 동시성·`listFeatures`를 뺀 나머지
- README 스크린샷(스타일 확정 후 사용자가 찍는다)
- Windows 실측(브라우저 열기 명령만 분기)

---

## 파일 구조

| 파일 | 상태 | 책임 |
|---|---|---|
| `packages/core/src/workspaceLock.ts` | 생성 | `withSystemLock`, `LockBusyError`. 프로세스 간 `.lock` 잠금과 realpath 키 프로세스 내 체인 |
| `packages/core/src/analyze/submit.ts` | 수정 | 잠금 안에서 NNN.json + manifest 쓰기, manifest 실패 시 NNN.json 삭제, 디스크 manifest 재읽기 |
| `packages/core/src/select/index.ts` | 수정 | `select` 전체를 `withSystemLock`으로 감쌈 |
| `packages/core/src/generate/index.ts` | 수정 | `generate` 전체를 `withSystemLock`으로 감쌈 |
| `packages/core/src/service/features.ts` | 수정 | 모르는 그룹 → 빈 rows |
| `packages/core/src/llm/adapter.ts`, `llm/claudeCode.ts` | 수정 | `ExtractRequest.signal`, abort 시 자식 SIGKILL |
| `packages/core/src/analyze/extract.ts` | 수정 | `ExtractOptions.signal`, 청크마다 확인, abort는 실패로 기록하지 않고 던짐 |
| `packages/core/src/service/analyze.ts` | 수정 | `AnalyzeSpecOptions.signal`을 `runLlmExtraction`에 전달(가짜 claude는 기존 `adapter` 옵션으로 주입) |
| `packages/core/src/verify/server.ts`, `verify/index.ts`, `service/verify.ts` | 수정 | `signal`을 npm install, mock 기동, 계약 루프에 전달 |
| `packages/core/src/index.ts` | 수정 | `withSystemLock`, `LockBusyError` export |
| `packages/core/test/workspaceLock.test.ts` | 생성 | 교차 프로세스, 회수, realpath, busy |
| `packages/core/test/fixtures/lock-child.ts` | 생성 | 자식 프로세스용 스크립트(tsx로 실행) |
| `packages/core/test/cancel.test.ts` | 생성 | 추출·검증 취소 시 자식 정리 |
| `packages/core/test/bin/claude-pid` | 생성 | 자기 pid를 `PID_FILE`에 쓰고 오래 자는 가짜 claude |
| `packages/ui-server/package.json`, `tsconfig*.json` | 생성 | 새 패키지 |
| `packages/ui-server/src/api-types.ts` | 생성 | API 요청/응답 타입(core 타입 재사용). web이 type-only로 가져감 |
| `packages/ui-server/src/errors.ts` | 생성 | `toApiError`, `toUiHint` |
| `packages/ui-server/src/security.ts` | 생성 | Host/Origin 검사 미들웨어 |
| `packages/ui-server/src/static.ts` | 생성 | 웹 빌드 결과 서빙(경로 탈출 차단, SPA 폴백) |
| `packages/ui-server/src/systems.ts` | 생성 | 시스템 목록과 단계 상태, 시스템 개요 |
| `packages/ui-server/src/jobs.ts` | 생성 | `JobManager`(시스템당 하나, 취소, 최근 결과) |
| `packages/ui-server/src/bus.ts` | 생성 | SSE용 이벤트 버스 |
| `packages/ui-server/src/watch.ts` | 생성 | `.specmock` 감시 → `workspace-changed` |
| `packages/ui-server/src/which.ts` | 생성 | `findExecutable` |
| `packages/ui-server/src/app.ts` | 생성 | `createApp(ctx)`, 라우트 전체 |
| `packages/ui-server/src/server.ts` | 생성 | `startUiServer` |
| `packages/ui-server/src/index.ts` | 생성 | 공개 export |
| `packages/ui-server/test/*.test.ts` | 생성 | `app.request()` 기반 테스트, 서버 기동 테스트 |
| `packages/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | 생성 | 새 패키지(빌드는 `tsc --noEmit && vite build`) |
| `packages/web/src/styles/tokens.css`, `app.css` | 생성 | §3.3 토큰 CSS 변수와 공통 스타일 |
| `packages/web/src/api.ts`, `events.ts` | 생성 | API 클라이언트, SSE 훅 |
| `packages/web/src/App.tsx`, `components/*`, `screens/*` | 생성 | 공통 틀과 화면 ①~⑤ |
| `packages/web/test/*.test.tsx`, `test/setup.ts` | 생성 | Testing Library 테스트 |
| `packages/cli/src/commands/ui.ts`, `cli.ts` | 생성·수정 | `specmock ui` |
| `packages/cli/test/ui.test.ts` | 생성 | `ui` 명령 기동·종료 |
| `packages/mcp/src/names.ts`, `tools/ui.ts`, `createServer.ts` | 수정·생성 | `open_ui` |
| `packages/mcp/test/tools.test.ts`, `plugin.test.ts` | 수정 | 11개, 정규식 `ui` |
| `packages/mcp/test/ui.test.ts` | 생성 | `open_ui` 같은 URL, stdio 종료 시 프로세스 종료 |
| `plugin/skills/specmock/SKILL.md` | 수정 | "화면으로 고르고 싶다" → `open_ui` |
| `vitest.config.ts`, 루트 `package.json`, `.gitignore` | 수정 | projects, scripts, devDeps, `e2e/.tmp/` |
| `playwright.config.ts`, `e2e/serve.ts`, `e2e/ui.spec.ts` | 생성 | E2E |
| `README.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-11-04-specmock-design.md` | 수정 | 문서 |

---

### Task 1: core 동시성 — 파일 잠금, realpath 키, manifest 실패 정리, `listFeatures` 빈 결과

**Files:**
- Create: `packages/core/src/workspaceLock.ts`, `packages/core/test/workspaceLock.test.ts`, `packages/core/test/fixtures/lock-child.ts`
- Modify: `packages/core/src/analyze/submit.ts`, `packages/core/src/select/index.ts`, `packages/core/src/generate/index.ts`, `packages/core/src/service/features.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/workspaceLock.test.ts`, 기존 `submit.test.ts`·`extract.test.ts`·`select.test.ts`·`generate.test.ts`·`service.test.ts`(수정 없이 통과)

- [ ] **Step 0: 의존성 설치**

```bash
pnpm install
pnpm build
pnpm test
```

기대 결과: 2A 최종 상태와 같다(40 files / 308 tests 통과). 수가 다르면 출발점으로 실행 기록에 적는다.

- [ ] **Step 1: 자식 프로세스 스크립트**

`packages/core/test/fixtures/lock-child.ts`. 부모가 `process.execPath --import tsx <이 파일> <모드> ...`로 실행한다. tsx는 루트 devDependency다.

```ts
import { Workspace, submitExtraction, withSystemLock } from "../../src/index.js";
import { AnalyzeRequestSchema } from "../../src/types.js";

const [mode, root, system, arg] = process.argv.slice(2);
const ws = new Workspace(root!);

if (mode === "hold") {
  // 잠금을 잡고 "locked"를 알린 뒤 arg ms 동안 쥐고 있는다.
  await withSystemLock(ws, system!, async () => {
    process.stdout.write("locked\n");
    await new Promise((r) => setTimeout(r, Number(arg)));
  });
} else if (mode === "submit") {
  // 청크 arg를 빈 결과로 제출한다(여러 자식이 동시에 다른 청크를 제출).
  const index = Number(arg);
  const req = await ws.read(system!, "analyze-request.json", AnalyzeRequestSchema);
  const chunk = req.chunks.find((c) => c.index === index)!;
  const r = await submitExtraction(ws, system!, { index, contentHash: chunk.contentHash!, result: { endpoints: [] } });
  process.stdout.write(JSON.stringify(r) + "\n");
}
```

`withSystemLock`은 Step 3에서 index.ts가 export한다.

- [ ] **Step 2: 실패하는 테스트**

`packages/core/test/workspaceLock.test.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockBusyError, Workspace, listFeatures, prepare, submitExtraction, withSystemLock } from "../src/index.js";
import { AnalyzeRequestSchema } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "fixtures", "lock-child.ts");

function child(args: string[]): { done: Promise<string>; firstLine: Promise<string>; pid: number } {
  const p = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  let resolveLine!: (s: string) => void;
  const firstLine = new Promise<string>((r) => { resolveLine = r; });
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolveLine(out.split("\n")[0]!); });
  const done = new Promise<string>((resolve, reject) => p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)))));
  return { done, firstLine, pid: p.pid! };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-lock-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("withSystemLock", () => {
  it("다른 프로세스가 쥐고 있으면 timeoutMs 뒤 LockBusyError(code busy)", async () => {
    const ws = new Workspace(root);
    const holder = child(["hold", root, "pets", "1500"]);
    expect(await holder.firstLine).toBe("locked");
    const err = await withSystemLock(ws, "pets", async () => "ran", { timeoutMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect(err.code).toBe("busy");
    await holder.done;
    expect(await withSystemLock(ws, "pets", async () => "ran")).toBe("ran");
  });

  it("죽은 pid의 잠금은 회수한다", async () => {
    const ws = new Workspace(root);
    const dead = child(["hold", root, "other", "0"]);
    await dead.done;
    await mkdir(ws.dir("pets"), { recursive: true });
    await writeFile(path.join(ws.dir("pets"), ".lock"), JSON.stringify({ pid: dead.pid, at: new Date().toISOString(), token: "t" }));
    expect(await withSystemLock(ws, "pets", async () => "ran", { timeoutMs: 500 })).toBe("ran");
  });

  it("살아 있는 pid라도 staleMs를 넘긴 잠금은 회수한다", async () => {
    const ws = new Workspace(root);
    await mkdir(ws.dir("pets"), { recursive: true });
    const old = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path.join(ws.dir("pets"), ".lock"), JSON.stringify({ pid: process.pid, at: old, token: "t" }));
    expect(await withSystemLock(ws, "pets", async () => "ran", { timeoutMs: 500, staleMs: 1_000 })).toBe("ran");
  });

  it("심볼릭 링크로 연 작업 공간도 같은 잠금(프로세스 안에서 순서 보장)", async () => {
    const real = path.join(root, "real");
    await mkdir(real);
    const alias = path.join(root, "alias");
    await symlink(real, alias);
    const a = new Workspace(real), b = new Workspace(alias);
    const order: string[] = [];
    let release!: () => void;
    const first = withSystemLock(a, "pets", () => new Promise<void>((r) => { order.push("a-start"); release = () => { order.push("a-end"); r(); }; }));
    await new Promise((r) => setTimeout(r, 20));
    const second = withSystemLock(b, "pets", async () => { order.push("b"); });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("끝나면 .lock을 지운다(예외로 끝나도)", async () => {
    const ws = new Workspace(root);
    await expect(withSystemLock(ws, "pets", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(readFile(path.join(ws.dir("pets"), ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("submitExtraction 교차 프로세스", () => {
  it("자식 프로세스 6개가 동시에 서로 다른 청크를 제출해도 manifest에 전부 남는다", async () => {
    const ws = new Workspace(root);
    // 청크 6개짜리 문서
    const doc = Array.from({ length: 6 }, (_, i) => `## Section ${i}\n\n${"text ".repeat(120)}`).join("\n\n");
    await ingestText(ws, "pets", doc);
    const req = await prepare(ws, "pets", { maxChars: 700, overlap: 50 });
    expect(req.chunks.length).toBeGreaterThanOrEqual(6);
    const kids = req.chunks.slice(0, 6).map((c) => child(["submit", root, "pets", String(c.index)]));
    await Promise.all(kids.map((k) => k.done));
    const manifest = JSON.parse(await readFile(ws.file("pets", "extracted/manifest.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(req.chunks.slice(0, 6).map((c) => String(c.index).padStart(3, "0")).sort());
  });

  it("manifest 쓰기가 실패하면 방금 쓴 NNN.json을 지운다", async () => {
    const ws = new Workspace(root);
    await ingestText(ws, "pets", "## A\n\nGET /pets returns pets.\n");
    const req = await prepare(ws, "pets");
    // manifest.json 자리를 비어 있지 않은 디렉터리로 만들어 쓰기를 실패시킨다(2A Task 2와 같은 방법).
    await mkdir(ws.file("pets", "extracted/manifest.json/x"), { recursive: true });
    const c = req.chunks[0]!;
    await expect(submitExtraction(ws, "pets", { index: c.index, contentHash: c.contentHash!, result: { endpoints: [] } })).rejects.toThrow();
    await expect(readFile(ws.file("pets", "extracted/000.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("listFeatures", () => {
  it("모르는 그룹은 예외 대신 빈 rows", async () => {
    const ws = new Workspace(root);
    await petstoreCatalog(ws, "pets");
    const r = await listFeatures(ws, "pets", { group: "nope" });
    expect(r.rows).toEqual([]);
    expect(r.total).toBeGreaterThan(0);
    expect(r.group).toBe("nope");
  });
});
```

`ingestText`와 `petstoreCatalog`는 같은 파일 아래에 둔다. 기존 `service.test.ts`·`submit.test.ts`가 쓰는 준비 함수(`ingestSpec`으로 임시 md·`fixtures/petstore.yaml`을 등록하고 `analyzeSpec`을 부름)를 그대로 옮겨 쓴다. `prepare(ws, s, { maxChars, overlap })`는 `service.test.ts:93`과 같은 모양이다(`ChunkOptions`는 두 필드가 모두 필수).

실행:

```bash
pnpm vitest run packages/core/test/workspaceLock.test.ts
```

기대 결과: `withSystemLock`/`LockBusyError` export가 없어 import 단계에서 실패한다(`does not provide an export named 'LockBusyError'` 또는 `is not a function`). `listFeatures` 테스트는 `알 수 없는 그룹: nope`으로 실패한다.

- [ ] **Step 3: `workspaceLock.ts` 구현**

```ts
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./workspace.js";

/** <system>/ 안의 잠금 파일. 화면 서버의 작업 공간 감시는 이 이름을 무시한다. */
export const SYSTEM_LOCK_FILE = ".lock";

export interface LockBody { pid: number; at: string; token: string }

export class LockBusyError extends Error {
  readonly code = "busy" as const;
  constructor(readonly lockFile: string, readonly holder: LockBody | null) {
    super(`다른 곳(CLI/대화/화면)에서 같은 시스템을 쓰는 중입니다 (${lockFile}${holder ? `, pid ${holder.pid}` : ""}). 끝난 뒤 다시 시도하세요.`);
    this.name = "LockBusyError";
  }
}

export interface SystemLockOptions {
  /** 잠금을 기다리는 최대 시간. 넘으면 LockBusyError. 기본 15s. */
  timeoutMs?: number;
  /** 이보다 오래된 잠금은 pid가 살아 있어도 회수한다. 기본 10분(잠금 구간은 짧은 쓰기뿐이다). */
  staleMs?: number;
  pollMs?: number;
}

/** 프로세스 안 직렬화: realpath 키별 Promise 체인. 같은 프로세스의 요청이 파일 잠금을 두고 폴링 경쟁하지 않게 한다. */
const chains = new Map<string, Promise<unknown>>();

/**
 * <system> 단위로 fn을 직렬화한다. 프로세스 안에서는 체인 순서, 프로세스 사이에서는 `<system>/.lock`(wx 생성).
 * 같은 시스템에 대해 중첩 호출하면 교착되므로 fn 안에서 다시 부르지 않는다.
 */
export async function withSystemLock<T>(ws: Workspace, system: string, fn: () => Promise<T>, opts: SystemLockOptions = {}): Promise<T> {
  const dir = ws.dir(system);
  await mkdir(dir, { recursive: true });
  const key = await realpath(dir);
  const file = path.join(key, SYSTEM_LOCK_FILE);
  const task = () => withFileLock(file, fn, opts);
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  try { return await run; } finally { if (chains.get(key) === tail) chains.delete(key); }
}

async function withFileLock<T>(file: string, fn: () => Promise<T>, opts: SystemLockOptions): Promise<T> {
  const token = await acquire(file, opts);
  try { return await fn(); } finally { await release(file, token); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readBody(file: string): Promise<LockBody | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as LockBody; } catch { return null; }
}

async function isStale(file: string, body: LockBody | null, staleMs: number): Promise<boolean> {
  if (body) return !alive(body.pid) || Date.now() - Date.parse(body.at) > staleMs;
  // 내용이 비었거나 깨짐: 다른 프로세스가 open과 write 사이일 수 있으므로 mtime이 충분히 오래됐을 때만.
  try { return Date.now() - (await stat(file)).mtimeMs > Math.min(staleMs, 5_000); } catch { return false; }
}

async function acquire(file: string, { timeoutMs = 15_000, staleMs = 10 * 60_000, pollMs = 25 }: SystemLockOptions): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const h = await open(file, "wx");
      try { await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token } satisfies LockBody)); }
      finally { await h.close(); }
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const body = await readBody(file);
    if (await isStale(file, body, staleMs)) { await reclaim(file, body); continue; }
    if (Date.now() >= deadline) throw new LockBusyError(file, body);
    await sleep(pollMs);
  }
}

/**
 * 남은 잠금을 치운다. 판정과 삭제 사이에 다른 프로세스가 회수·재획득했을 수 있으므로
 * 고유 이름으로 옮긴 뒤 token을 다시 확인하고, 다르면(새 잠금을 가져온 것) link로 되돌린다.
 */
async function reclaim(file: string, seen: LockBody | null): Promise<void> {
  const aside = `${file}.${process.pid}.${randomUUID()}.stale`;
  try { await rename(file, aside); } catch { return; }
  const got = await readBody(aside);
  if (seen && got && got.token !== seen.token) await link(aside, file).catch(() => {});
  await rm(aside, { force: true });
}

async function release(file: string, token: string): Promise<void> {
  if ((await readBody(file))?.token === token) await rm(file, { force: true });
}
```

`packages/core/src/index.ts`에 추가한다:

```ts
export { withSystemLock, LockBusyError, SYSTEM_LOCK_FILE, type LockBody, type SystemLockOptions } from "./workspaceLock.js";
```

- [ ] **Step 4: `submitExtraction`을 잠금 안으로**

`submit.ts`의 `manifestLocks`와 `withManifestLock`(48-55행)을 지우고, 90-99행을 바꾼다:

```ts
  const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
  const file = ws.file(system, rel);
  const key = extractedFileName(chunk.index).replace(/\.json$/, "");
  await mkdir(path.dirname(file), { recursive: true });
  await withSystemLock(ws, system, async () => {
    await writeFileAtomic(file, JSON.stringify({ endpoints: parsed.data.endpoints }, null, 2) + "\n");
    try {
      // 잠금 안에서 디스크 manifest를 다시 읽는다. 다른 프로세스가 기록한 항목을 덮어쓰지 않기 위해서다.
      const manifest = await readManifest(ws, system);
      manifest[key] = actual;
      await writeManifest(ws, system, manifest);
    } catch (e) {
      // manifest에 오르지 못한 NNN.json은 extract()가 '손으로 쓴 것'으로 오인하므로 지운다.
      await rm(file, { force: true });
      throw e;
    }
    if (opts.manifest) opts.manifest[key] = actual;
  });
  return { ok: true, file };
```

- import에 `rm`(`node:fs/promises`)과 `withSystemLock`(`../workspaceLock.js`)을 더한다.
- `SubmitExtractionOptions.manifest` 주석을 "넘기면 기록한 키를 여기에도 반영한다(호출자 메모리 동기화용). 쓰기는 항상 디스크 manifest 기준."으로 고친다.
- 파일 상단의 "범위: 한 프로세스 안" 주석은 지운다.

- [ ] **Step 5: select·generate 잠금, `listFeatures`**

`select/index.ts`: 기존 본문을 `selectUnlocked`로 옮기고 공개 함수는 감싼다.

```ts
export async function select(ws: Workspace, system: string, exprs: string[], opts: SelectOptions = {}): Promise<SelectResult> {
  return withSystemLock(ws, system, () => selectUnlocked(ws, system, exprs, opts));
}
```

`generate/index.ts`도 같은 모양(`generateUnlocked`)으로 바꾼다. 두 함수 안에서 서로를 부르지 않는지(`runPipeline`은 순서대로 부를 뿐임) `grep -n "select(\|generate(" packages/core/src`로 확인한다. 중첩 호출은 교착을 부른다.

`service/features.ts` 25-27행의 throw를 지운다. 필터 결과가 빈 배열이 되므로 `rows: []`가 된다. `formatCatalog`는 이미 `그룹 nope: 0개 기능`을 그린다(`catalog.test.ts:64`).

- [ ] **Step 6: 통과 확인과 반복 실행**

```bash
pnpm vitest run packages/core/test/workspaceLock.test.ts
pnpm vitest run packages/core/test/submit.test.ts packages/core/test/extract.test.ts packages/core/test/select.test.ts packages/core/test/generate.test.ts packages/core/test/service.test.ts
for i in 1 2 3 4 5; do pnpm vitest run packages/core/test/workspaceLock.test.ts --silent || break; done
```

기대 결과:
- 모두 통과한다. 기존 테스트 파일은 수정하지 않는다.
- 반복 5회도 통과한다. 횟수는 5회로 고정하고, 실패하면 횟수와 메시지를 실행 기록에 남긴다.
- 6개 동시 제출 테스트는 잠금 없이도 우연히 통과할 수 있다(확률적 경합). 잠금의 실패 확인은 첫 테스트(busy)가 맡는다.

- [ ] **Step 7: 전체와 커밋**

```bash
pnpm test && pnpm typecheck
git add packages/core
git commit -m "feat(core): 시스템 단위 파일 잠금(프로세스 간), realpath 키, manifest 실패 정리, listFeatures 빈 결과"
```

---

### Task 2: core 취소 신호 — 추출·검증의 `AbortSignal`

**Files:**
- Create: `packages/core/test/cancel.test.ts`, `packages/core/test/bin/claude-pid`
- Modify: `packages/core/src/llm/adapter.ts`, `llm/claudeCode.ts`, `analyze/extract.ts`, `service/analyze.ts`, `verify/server.ts`, `verify/index.ts`, `service/verify.ts`

- [ ] **Step 1: 가짜 claude (pid 기록)**

`packages/core/test/bin/claude-pid` (실행 권한 `chmod +x`):

```bash
#!/usr/bin/env bash
# 취소 테스트용: 자기 pid를 PID_FILE에 남기고 오래 잔다. exec로 바꿔 pid가 sleep과 같게 한다.
echo $$ > "${PID_FILE:?}"
exec sleep 30
```

- [ ] **Step 2: 실패하는 테스트**

`packages/core/test/cancel.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClaudeCodeAdapter, Workspace, analyzeSpec, ingestSpec, summarizeChunks } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
let root: string, pidFile: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-cancel-")); pidFile = path.join(root, "pid"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timeout");
}

it("추출 중 abort하면 claude 자식을 죽이고 AbortError로 끝나며, 실패 청크로 기록하지 않는다", async () => {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "pets", [path.join(here, "..", "..", "..", "examples", "docs-sample", "pets-api.md")]);
  const ac = new AbortController();
  const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-pid"), env: { PID_FILE: pidFile } });
  const run = analyzeSpec(ws, "pets", { llm: "claude-code", adapter, signal: ac.signal });
  await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim().length > 0);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  ac.abort();
  const err = await run.catch((e) => e);
  expect(err.name).toBe("AbortError");
  await waitFor(async () => !isAlive(pid));
  expect((await summarizeChunks(ws, "pets")).every((c) => !c.done)).toBe(true);
});

it("시작 전에 이미 abort된 signal이면 claude를 띄우지 않는다", async () => {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "pets", [path.join(here, "..", "..", "..", "examples", "docs-sample", "pets-api.md")]);
  const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-pid"), env: { PID_FILE: pidFile } });
  const err = await analyzeSpec(ws, "pets", { llm: "claude-code", adapter, signal: AbortSignal.abort() }).catch((e) => e);
  expect(err.name).toBe("AbortError");
  await expect(readFile(pidFile)).rejects.toMatchObject({ code: "ENOENT" });
});
```

검증 취소 테스트도 같은 파일에 둔다:
- mock을 생성하고 `node_modules`가 없게 둔다.
- `PATH` 앞에 가짜 `npm`을 둔다. 가짜 `npm`은 `claude-pid`와 같은 스크립트를 `npm` 이름으로 임시 디렉터리에 만든다.
- `verifyMock(ws, s, { signal })`을 abort하면 npm pid가 사라지고 `AbortError`로 끝나는지 확인한다.
- PATH 조작은 `process.env.PATH`를 바꿨다가 `finally`에서 되돌린다. 테스트 파일 안에서만 바뀐다(vitest는 파일마다 워커가 따로다).

```bash
pnpm vitest run packages/core/test/cancel.test.ts
```

기대 결과: TS 타입 오류는 vitest가 무시하므로 실행은 된다. 하지만 `signal`이 전달되지 않아 30s짜리 sleep이 끝날 때까지 기다리다가, `err.name`이 `Error`이거나 테스트가 시간 초과로 실패한다.

- [ ] **Step 3: 구현**

`llm/adapter.ts`:

```ts
export interface ExtractRequest {
  prompt: string;
  schema: Record<string, unknown>;
  /** 취소. abort되면 진행 중인 호출을 끝내고 AbortError로 거부한다. */
  signal?: AbortSignal;
}
```

`llm/claudeCode.ts`의 `extract` 시작과 spawn 부분:

```ts
    req.signal?.throwIfAborted();
    // ...
      const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.opts.env } });
      const onAbort = () => { child.kill("SIGKILL"); reject(req.signal!.reason instanceof Error ? req.signal!.reason : abortError()); };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      // close·error 처리기 맨 앞에서 req.signal?.removeEventListener("abort", onAbort)
```

`abortError()`는 `new DOMException("작업이 취소되었습니다", "AbortError")`다. `AbortSignal.abort()`의 기본 reason도 name이 `AbortError`인 DOMException이라 판정이 일치한다.

`analyze/extract.ts`:
- `ExtractOptions`에 `signal?: AbortSignal`을 더한다.
- 루프 맨 앞에 `opts.signal?.throwIfAborted();`를 둔다.
- `adapter.extract({ ..., signal: opts.signal })`로 넘긴다.
- `catch (e)`에서 `if (opts.signal?.aborted) throw e;`를 `fail(e)`보다 먼저 둔다. 취소는 실패 청크가 아니다.

`service/analyze.ts`:
- `AnalyzeSpecOptions`에 `signal?: AbortSignal`을 더한다.
- `runLlmExtraction`의 `Pick`에 `"signal"`을 더해 `extract(..., { signal: opts.signal })`로 넘긴다.
- merge 직전에 `opts.signal?.throwIfAborted()`를 둔다.
- `analyzeSpec`이 `runLlmExtraction`을 부를 때 signal을 넘긴다.

`verify/server.ts`:
- `ensureInstalled(dir, { onLog, signal })`: spawn 뒤에 `signal`의 abort가 `child.kill("SIGKILL")` 후 AbortError로 거부하게 한다. 시작 전에 `signal?.throwIfAborted()`.
- `StartMockOptions`에 `signal?`을 더해 `ensureInstalled`에 넘긴다.

`verify/index.ts`:
- `VerifyOptions.signal`을 더한다.
- 계약 루프 매 회 `opts.signal?.throwIfAborted()`. `finally`의 `server.stop()`이 mock을 정리한다.

`service/verify.ts`: `verifyMock(ws, s, { dir, onEvent, signal })`.

- [ ] **Step 4: 통과 확인**

```bash
pnpm vitest run packages/core/test/cancel.test.ts packages/core/test/llm.test.ts packages/core/test/extract.test.ts packages/core/test/e2e.test.ts
pnpm test && pnpm typecheck
```

기대 결과: 모두 통과한다. `llm.test.ts`의 기존 타임아웃 테스트(`claude-slow`)는 그대로다.

- [ ] **Step 5: 커밋**

```bash
git add packages/core
git commit -m "feat(core): 추출·검증 취소 신호(AbortSignal) — claude·npm 자식 프로세스 정리"
```

---

### Task 3: `@specmock/ui-server` 골격 — 앱, 바인딩, Host/Origin, 응답 형식, 정적 서빙

**Files:**
- Create: `packages/ui-server/{package.json,tsconfig.json,tsconfig.test.json}`
- Create: `packages/ui-server/src/{index.ts,app.ts,server.ts,security.ts,errors.ts,static.ts,api-types.ts}`
- Test: `packages/ui-server/test/app.test.ts`, `packages/ui-server/test/server.test.ts`, `packages/ui-server/test/errors.test.ts`

- [ ] **Step 1: 패키지**

`packages/ui-server/package.json`:

```json
{
  "name": "@specmock/ui-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./api-types": { "types": "./dist/api-types.d.ts", "default": "./dist/api-types.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    "test": "vitest run --root ../.. packages/ui-server"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.6",
    "@specmock/core": "workspace:*",
    "hono": "^4.13.16"
  }
}
```

`tsconfig.json`과 `tsconfig.test.json`은 `packages/mcp`의 것을 그대로 복사한다. 그다음 실행:

```bash
pnpm install
```

- [ ] **Step 2: 실패하는 테스트**

`packages/ui-server/test/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LockBusyError } from "@specmock/core";
import { toApiError, toUiHint } from "../src/errors.js";

describe("toApiError", () => {
  it.each([
    [new Error("catalog.json 파일이 없습니다 (/x/catalog.json). 먼저 `specmock analyze pets`를 실행하세요."), 404, "not-found"],
    [new Error("시스템 이름이 올바르지 않습니다: 'a b' (문자·숫자·-·_ 만 사용)"), 400, "invalid"],
    [new Error("알 수 없는 기능 id: x.get"), 400, "invalid"],
    [new Error("/m은(는) specmock이 만든 디렉터리가 아닙니다(specmock.lock.json 없음). 덮어쓰려면 --force"), 409, "overwrite-required"],
    [new LockBusyError("/x/.lock", null), 409, "busy"],
    [new DOMException("취소", "AbortError"), 499, "cancelled"],
    [new Error("뭔가 깨짐"), 500, "failed"],
  ])("%s → %d %s", (e, status, code) => {
    const r = toApiError(e);
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ ok: false, error: { code } });
  });

  it("hint의 CLI 명령을 화면 동작 이름으로 바꾸고 message에서는 뺀다", () => {
    const r = toApiError(new Error("catalog.json 파일이 없습니다 (/x). 먼저 `specmock analyze pets`를 실행하세요."));
    expect(r.body.error.hint).toBe("먼저 ② 분석을 진행해 주세요.");
    expect(r.body.error.message).not.toContain("specmock analyze");
  });

  it("busy의 hint", () => {
    expect(toApiError(new LockBusyError("/x/.lock", null)).body.error.hint).toBe("다른 곳(CLI/대화)에서 작업 중이에요. 끝난 뒤 다시 시도해 주세요.");
  });
});

describe("toUiHint", () => {
  it.each([
    ["먼저 specmock generate pets 을 실행하거나 --dir 로 경로를 지정하세요.", "먼저 ④ 생성을 진행하거나 출력 디렉터리를 지정해 주세요."],
    ["먼저 specmock select pets <표현식>을 실행하세요.", "먼저 ③ 기능 선택을 진행해 주세요."],
  ])("%s", (input, expected) => { expect(toUiHint(input)).toBe(expected); });
});
```

`packages/ui-server/test/app.test.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

let root: string, webDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "specmock-ui-"));
  webDir = path.join(root, "web");
  await mkdir(path.join(webDir, "assets"), { recursive: true });
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>specmock</title>");
  await writeFile(path.join(webDir, "assets", "a.js"), "console.log(1)");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const HOST = { host: "127.0.0.1:4310" };
const make = () => createApp({ root, webDir, port: () => 4310 }).app;

describe("보안", () => {
  it("Host가 127.0.0.1:<port>·localhost:<port>면 통과", async () => {
    for (const host of ["127.0.0.1:4310", "localhost:4310"]) {
      expect((await make().request("/api/env", { headers: { host } })).status).toBe(200);
    }
  });
  it.each(["evil.example:4310", "127.0.0.1:9999", "127.0.0.1"])("Host %s → 403", async (host) => {
    const r = await make().request("/api/env", { headers: { host } });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("Origin이 있는데 같은 출처가 아니면 403, 같으면 통과", async () => {
    expect((await make().request("/api/env", { headers: { ...HOST, origin: "http://evil.example" } })).status).toBe(403);
    expect((await make().request("/api/env", { headers: { ...HOST, origin: "http://127.0.0.1:4310" } })).status).toBe(200);
  });
  it("허용하지 않는 메서드는 405 (PUT 전부, POST 전용 경로의 GET)", async () => {
    expect((await make().request("/api/systems/pets/selection", { method: "PUT", headers: HOST })).status).toBe(405);
    expect((await make().request("/api/systems/pets/generate", { headers: HOST })).status).toBe(405);
  });
});

describe("응답 형식", () => {
  it("/api/env → {ok:true,data:{root,claude}}", async () => {
    const body = await (await make().request("/api/env", { headers: HOST })).json();
    expect(body).toMatchObject({ ok: true, data: { root } });
    expect(typeof body.data.claude).toBe("boolean");
  });
  it("모르는 /api 경로 → 404 {ok:false,error:{code:not-found}}", async () => {
    const r = await make().request("/api/nope", { headers: HOST });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("정적 파일", () => {
  it("파일은 그대로, 모르는 화면 경로는 index.html(SPA)", async () => {
    const a = await make().request("/assets/a.js", { headers: HOST });
    expect(a.headers.get("content-type")).toMatch(/javascript/);
    const spa = await make().request("/systems/pets/select", { headers: HOST });
    expect(await spa.text()).toContain("<title>specmock</title>");
  });
  it("경로 탈출은 막는다", async () => {
    const r = await make().request("/..%2f..%2fetc%2fpasswd", { headers: HOST });
    expect(await r.text()).not.toContain("root:");
  });
});
```

`packages/ui-server/test/server.test.ts`:

```ts
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startUiServer } from "../src/server.js";

let root: string, webDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "specmock-ui-"));
  webDir = path.join(root, "web");
  await mkdir(webDir);
  await writeFile(path.join(webDir, "index.html"), "<!doctype html>");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("127.0.0.1의 자동 포트에 뜨고 close로 내려간다", async () => {
  const s = await startUiServer({ root, webDir });
  expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const r = await fetch(new URL("/api/env", s.url));
  expect((await r.json()).ok).toBe(true);
  await s.close();
  await expect(fetch(new URL("/api/env", s.url))).rejects.toThrow();
});

it("지정 포트가 사용 중이면 명확한 오류", async () => {
  const blocker = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const port = (blocker.address() as { port: number }).port;
  await expect(startUiServer({ root, webDir, port })).rejects.toThrow(`포트 ${port}을(를) 이미 쓰고 있어요`);
  blocker.close();
});

it("웹 빌드가 없으면 pnpm build 안내", async () => {
  await expect(startUiServer({ root, webDir: path.join(root, "none") })).rejects.toThrow("`pnpm build`를 먼저 실행하세요");
});
```

```bash
pnpm vitest run packages/ui-server
```

기대 결과: `Cannot find module '../src/errors.js'`, `'../src/app.js'`, `'../src/server.js'`로 세 파일 모두 실패한다.

- [ ] **Step 3: 구현 — errors.ts**

```ts
import { LockBusyError } from "@specmock/core";

export type ErrorCode = "invalid" | "not-found" | "busy" | "overwrite-required" | "cancelled" | "forbidden" | "failed";
export interface ApiErrorBody { ok: false; error: { code: ErrorCode; message: string; hint?: string } }

const STEP: Record<string, string> = { ingest: "① 등록", analyze: "② 분석", select: "③ 기능 선택", generate: "④ 생성", verify: "⑤ 검증" };

/** CLI 안내 문장(“먼저 `specmock analyze x`를 실행하세요”, “--dir 로”)을 화면 동작 안내로 바꾼다. 2A MCP 층 rewriteHints와 같은 방식. */
export function toUiHint(sentence: string): string {
  const m = /`?specmock (ingest|analyze|select|generate|verify)\b/.exec(sentence);
  if (!m) return sentence;
  const step = STEP[m[1]!]!;
  return /--dir 로/.test(sentence)
    ? `먼저 ${step}을 진행하거나 출력 디렉터리를 지정해 주세요.`
    : `먼저 ${step}을 진행해 주세요.`;
}

const HINT_SENTENCE = /\s*먼저 `?specmock [^.]*\.\s*$/;

export function errorBody(code: ErrorCode, message: string, hint?: string): ApiErrorBody {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

export function toApiError(e: unknown): { status: 400 | 403 | 404 | 409 | 499 | 500; body: ApiErrorBody } {
  if (e instanceof LockBusyError) return { status: 409, body: errorBody("busy", e.message, "다른 곳(CLI/대화)에서 작업 중이에요. 끝난 뒤 다시 시도해 주세요.") };
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === "AbortError") return { status: 499, body: errorBody("cancelled", "작업을 취소했어요.") };
  const hintMatch = HINT_SENTENCE.exec(err.message);
  const message = hintMatch ? err.message.slice(0, hintMatch.index) : err.message;
  const hint = hintMatch ? toUiHint(hintMatch[0].trim()) : undefined;
  if (err.message.includes("specmock이 만든 디렉터리가 아닙니다")) {
    return { status: 409, body: errorBody("overwrite-required", message.replace(/\s*덮어쓰려면 --force\s*$/, ""), "경로와 덮어쓸 내용을 확인한 뒤 덮어쓰기를 선택해 주세요.") };
  }
  if (/파일이 없습니다|이\(가\) 없습니다/.test(err.message)) return { status: 404, body: errorBody("not-found", message, hint) };
  if (/올바르지 않습니다|알 수 없는 기능 id|선택 결과가 비어|형식 오류|JSON 파싱 실패|함께 쓸 수 없습니다/.test(err.message)) {
    return { status: 400, body: errorBody("invalid", message, hint) };
  }
  return { status: 500, body: errorBody("failed", message, hint) };
}
```

**취소 판정 (리뷰 반영):** `toApiError`의 `AbortError` 이름 매핑은 보조 수단이다. Task 5의 작업 실행부는 오류 이름이 아니라 ui-server가 쥔 `signal.aborted`로 취소를 판정해 `cancelled`(499)로 매핑한다. 자식 프로세스가 취소 뒤 다른 오류로 끝나도 사용자의 취소 의도가 기준이 되게 하기 위해서다.

Hono `c.json(body, status)`의 status 타입(`ContentfulStatusCode`)에 비표준 499가 없을 수 있다. 없으면 `toApiError`의 반환 타입을 `ContentfulStatusCode`로 두고 499만 `as ContentfulStatusCode`로 캐스트한다. 타입 검사 결과는 Step 5에서 확인한다.

`toUiHint` 테스트의 두 번째 입력은 `<표현식>`을 포함한다. 정규식은 명령 이름만 보므로 영향이 없다. `resolveMockDir`의 문장(`… 이(가) 없습니다. 먼저 specmock generate pets 을 실행하거나 --dir 로 경로를 지정하세요.`)은 `HINT_SENTENCE`가 잡는다.

- [ ] **Step 4: 구현 — security.ts, static.ts, app.ts, server.ts**

`security.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { errorBody } from "./errors.js";

/** 로컬 전용: Host가 127.0.0.1:<port>/localhost:<port>가 아니거나, Origin이 같은 출처가 아니면 거부(DNS 리바인딩·다른 사이트 요청 차단). */
export function localOnly(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    const p = port();
    const allowed = [`127.0.0.1:${p}`, `localhost:${p}`];
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (!allowed.includes(host) || (origin !== undefined && !allowed.some((h) => origin === `http://${h}`))) {
      return c.json(errorBody("forbidden", "이 화면은 이 컴퓨터의 브라우저에서만 열 수 있어요."), 403);
    }
    await next();
  };
}
```

`static.ts`:
- `serveWeb(webDir)`가 Hono 핸들러를 돌려준다.
- `decodeURIComponent(c.req.path)` → `path.resolve(webDir, "." + p)`로 경로를 만든다. 결과가 `webDir + path.sep`로 시작하지 않으면 index.html을 준다.
- 파일이 있으면 확장자별 content-type으로 준다(`.html .js .css .svg .json .ico .woff2` 정도). 없으면 `index.html`(SPA 폴백).
- `/assets/*`에는 `cache-control: public, max-age=31536000, immutable`(Vite 해시 파일명)을 붙인다. 나머지는 `no-cache`다.
- `@hono/node-server/serve-static`은 `root`가 cwd 기준 상대 경로라 쓰지 않는다.

`app.ts`:

```ts
import { Hono } from "hono";
import path from "node:path";
import { Workspace } from "@specmock/core";
import { errorBody, toApiError } from "./errors.js";
import { localOnly } from "./security.js";
import { serveWeb } from "./static.js";
import { findExecutable } from "./which.js";

export interface AppOptions {
  /** 프로젝트 루트. 상태는 <root>/.specmock, mock 기본 경로는 <root>/mock/<system>. */
  root: string;
  webDir: string;
  /** listen 뒤 실제 포트. Host 검사에 쓴다. */
  port: () => number;
  /** 문서 추출에 쓸 claude 실행 파일. 테스트는 가짜 실행 파일 경로를 준다. 기본 "claude". */
  claudeCommand?: string;
}

export function createApp(opts: AppOptions) {
  const ws = new Workspace(path.join(opts.root, ".specmock"));
  const claudeCommand = opts.claudeCommand ?? "claude";
  const app = new Hono();
  app.use("*", localOnly(opts.port));
  app.onError((e, c) => { const r = toApiError(e); return c.json(r.body, r.status); });
  app.get("/api/env", async (c) => c.json({ ok: true, data: { root: opts.root, claude: (await findExecutable(claudeCommand)) !== null } }));
  // Task 4·5의 라우트가 여기에 붙는다.
  app.all("/api/*", (c) => c.json(errorBody("not-found", `알 수 없는 API: ${c.req.method} ${c.req.path}`), 404));
  app.get("*", serveWeb(opts.webDir));
  return { app, ws };
}
```

405 규칙은 Task 3에서 미리 넣는다. 그래서 Task 4·5가 라우트를 붙여도 테스트가 그대로 통과한다.
- `/api/*`의 `PUT`·`PATCH`·`DELETE`는 모두 405다. 이 API는 GET과 POST만 쓴다.
- `GET /api/systems/:s/{analyze,extract,generate,verify}`와 `GET /api/jobs/:id/cancel`도 405다. 이 경로들은 POST 전용이다.
- `selection`은 GET(조회)과 POST(저장)를 모두 받는다.
- 405 응답은 `errorBody("invalid", "허용하지 않는 메서드예요: …")`이고, `allow` 헤더를 붙인다.
- 이 규칙은 404 catch-all보다 앞에 둔다.

`which.ts`:

```ts
import { access, constants } from "node:fs/promises";
import path from "node:path";

/** PATH에서 실행 파일을 찾는다. 경로 구분자가 들어 있으면 그 경로만 본다. 없으면 null. */
export async function findExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates = cmd.includes(path.sep) ? [cmd] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd));
  for (const file of candidates) {
    try { await access(file, constants.X_OK); return file; } catch { /* 다음 */ }
  }
  return null;
}
```

`server.ts`:

```ts
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

/** 모노레포 안 웹 빌드 결과: packages/ui-server/dist → packages/web/dist */
export const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export interface StartUiServerOptions {
  root: string;
  /** 0 또는 생략이면 자동. */
  port?: number;
  webDir?: string;
  claudeCommand?: string;
  /** true면 서버·감시자·타이머가 프로세스를 붙잡지 않는다(MCP 안에서 실행할 때). */
  unref?: boolean;
}
export interface UiServerHandle { url: string; port: number; close: () => Promise<void> }

export async function startUiServer(opts: StartUiServerOptions): Promise<UiServerHandle> {
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  if (!existsSync(path.join(webDir, "index.html"))) {
    throw new Error(`화면 빌드 결과가 없어요 (${webDir}). 저장소 루트에서 \`pnpm build\`를 먼저 실행하세요.`);
  }
  await mkdir(path.join(opts.root, ".specmock"), { recursive: true });
  let port = 0;
  const { app } = createApp({ root: opts.root, webDir, port: () => port, claudeCommand: opts.claudeCommand });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port ?? 0 }, (info: AddressInfo) => { port = info.port; resolve(s); });
    s.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE"
      ? new Error(`포트 ${opts.port}을(를) 이미 쓰고 있어요. 다른 --port를 주거나 생략해 자동 포트를 쓰세요.`)
      : e));
  });
  if (opts.unref) server.unref();
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); }),
  };
}
```

열린 가정 A3: `serve`의 콜백 인자와 `error` 이벤트 모양은 이 단계에서 확인한다. 다르면 `node:http`의 `createServer(getRequestListener(app.fetch))`(`@hono/node-server` export)로 바꾸고 실행 기록에 남긴다. `closeAllConnections`는 열린 SSE 연결 때문에 `close`가 끝나지 않는 것을 막는다.

`index.ts`:

```ts
export { startUiServer, DEFAULT_WEB_DIR, type StartUiServerOptions, type UiServerHandle } from "./server.js";
export { createApp, type AppOptions } from "./app.js";
export type * from "./api-types.js";
```

`api-types.ts`는 이 Task에서 `ApiOk<T> = { ok: true; data: T }`, `ApiErr = ApiErrorBody`, `EnvInfo = { root: string; claude: boolean }`만 둔다. Task 4·5에서 늘린다.

- [ ] **Step 5: 통과 확인, 루트 스크립트**

루트 `package.json`의 `test`를 `"pnpm build && vitest run"`으로 바꾼다(결정 6). `typecheck`도 `pnpm build:core && …`에서 `pnpm --filter "@specmock/ui-server..." build && pnpm -r typecheck && tsc -p tsconfig.scripts.json`으로 바꾼다. mcp·cli·web의 타입 검사에 ui-server의 `dist/*.d.ts`가 필요하기 때문이다. 이렇게 해야 새 clone에서 `pnpm typecheck`만 돌려도 통과한다.

```bash
pnpm vitest run packages/ui-server
pnpm test && pnpm typecheck
```

기대 결과: ui-server 3개 파일이 통과하고 전체도 통과한다. `pnpm -r build` 출력에서 `@specmock/ui-server`가 core 다음에 빌드된다.

- [ ] **Step 6: 커밋**

```bash
git add packages/ui-server package.json pnpm-lock.yaml
git commit -m "feat(ui-server): 화면 서버 골격 — 127.0.0.1 바인딩, Host/Origin 검사, 오류 형식·hint 변환, 정적 서빙"
```

---

### Task 4: API 엔드포인트 (동기 조회·변경)

**Files:**
- Create: `packages/ui-server/src/systems.ts`, `packages/ui-server/test/api.test.ts`
- Modify: `packages/ui-server/src/app.ts`, `packages/ui-server/src/api-types.ts`

API 목록 (모두 `/api` 아래, 응답은 `{ok,data}` / `{ok:false,error}`):

| 메서드·경로 | 서비스 호출 | data |
|---|---|---|
| `GET /env` | `findExecutable` | `{ root, claude }` |
| `GET /systems` | `listSystems` (새, systems.ts) | `SystemSummary[]` = `{ name, kind: SourceInput["kind"] \| null, steps: { registered, analyzed, selected, generated, verified }, chunks?: { done, total } }` |
| `POST /systems` `{ origins: string[], system: string, refresh?: boolean }` | `ingestSpec(ws, system, origins, { refresh, harvest: "never" })` | `IngestSpecResult` |
| `GET /systems/:s` | `systemOverview` (새) | `{ summary, source: inputs[], analyze: "none" \| "prepared" \| "catalog", catalogTotal, selection: Selection \| null, generate: GenerateInfo \| null, coverage: string \| null, defaultOutDir }` |
| `POST /systems/:s/analyze` | `analyzeSpec(ws, s, { llm: "session" })` | `AnalyzeSpecResult` (OpenAPI면 카탈로그, 문서면 prepared) |
| `GET /systems/:s/chunks` | `summarizeChunks` | `ChunkSummary[]` |
| `GET /systems/:s/features` | `listFeatures` | `{ total, rows: FeatureRow[], groups: string[] }` |
| `GET /systems/:s/features/:id` | `findFeature` | `Feature` |
| `GET /systems/:s/selection` | `ws.read(selection.json)` 또는 `null` | `Selection \| null` |
| `POST /systems/:s/selection` `{ ids: string[] }` | `select(ws, s, ids, { literalIds: true })` | `SelectResult`(`select/index.ts:17` — `selected, resolved, selectionFile, mockspecFile, catalogChanged, catalogDiff?`) |

`steps` 판정은 파일 존재로 한다:
- `registered`: `source.json`이 있다.
- `analyzed`: `catalog.json`이 있다.
- `selected`: `selection.json`이 있다.
- `generated`: `generate.json`이 있다.
- `verified`: `coverage.md`가 있다.

`kind`는 source.json 첫 입력의 kind다. `chunks`는 `analyze-request.json`이 있을 때만 `summarizeChunks`에서 센다.

"다시 실행 필요" 판정(설계 §3.1)은 mtime 비교로 한다:
- `selection.json`이 `generate.json`보다 새로우면 `stale.generate = true`.
- `generate.json`이 `coverage.md`보다 새로우면 `stale.verify = true`.
- `catalog.json`이 `selection.json`보다 새로우면 `stale.select = true`.
- 이 값은 `SystemSummary.stale`로 내보낸다.

- [ ] **Step 1: 실패하는 테스트** `packages/ui-server/test/api.test.ts`

```ts
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const PETSTORE = path.join(REPO, "packages", "core", "test", "fixtures", "petstore.yaml");
const PETS_MD = path.join(REPO, "examples", "docs-sample", "pets-api.md");
const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-api-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function client() {
  const { app } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310 });
  return {
    get: async (p: string) => { const r = await app.request(`/api${p}`, { headers: HOST }); return { status: r.status, body: await r.json() }; },
    post: async (p: string, b: unknown = {}) => { const r = await app.request(`/api${p}`, { method: "POST", headers: HOST, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; },
  };
}

describe("OpenAPI 경로", () => {
  it("등록 → 분석 → 기능 목록 → 상세 → 선택 저장 → 시스템 단계", async () => {
    const c = client();
    expect((await c.get("/systems")).body).toEqual({ ok: true, data: [] });
    const reg = await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    expect(reg.body).toMatchObject({ ok: true, data: { system: "petstore", inputs: [{ kind: "openapi" }] } });
    const an = await c.post("/systems/petstore/analyze");
    expect(an.body).toMatchObject({ ok: true, data: { mode: "catalog", via: "openapi" } });
    const list = await c.get("/systems/petstore/features");
    expect(list.body.data.rows.length).toBeGreaterThan(0);
    expect(list.body.data.groups.length).toBeGreaterThan(0);
    const id = list.body.data.rows[0].id;
    expect((await c.get(`/systems/petstore/features/${encodeURIComponent(id)}`)).body.data.id).toBe(id);
    const sel = await c.post("/systems/petstore/selection", { ids: [id] });
    expect(sel.body).toMatchObject({ ok: true, data: { selected: [id] } });
    const systems = (await c.get("/systems")).body.data;
    expect(systems[0]).toMatchObject({ name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: false } });
  });

  it("모르는 그룹 필터는 빈 rows (Task 1)", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    expect((await c.get("/systems/petstore/features?group=nope")).body.data.rows).toEqual([]);
  });
});

describe("문서 경로", () => {
  it("분석은 prepared + 청크 표(done=false)", async () => {
    const c = client();
    await c.post("/systems", { system: "pets", origins: [PETS_MD] });
    expect((await c.post("/systems/pets/analyze")).body.data.mode).toBe("prepared");
    const chunks = (await c.get("/systems/pets/chunks")).body.data;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((x: { done: boolean }) => !x.done)).toBe(true);
  });
});

describe("오류 형식", () => {
  it("분석 전 기능 목록 → 404 not-found, hint는 화면 동작 이름", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    const r = await c.get("/systems/petstore/features");
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: "not-found", hint: "먼저 ② 분석을 진행해 주세요." });
  });
  it("잘못된 시스템 이름 → 400 invalid", async () => {
    expect((await client().post("/systems", { system: "a b", origins: [PETSTORE] })).body.error.code).toBe("invalid");
  });
  it("본문 형식 오류 → 400 invalid", async () => {
    expect((await client().post("/systems", { system: "x" })).body.error.code).toBe("invalid");
  });
  it("빈 선택 → 400 invalid (결정 2)", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    expect((await c.post("/systems/petstore/selection", { ids: [] })).body.error.code).toBe("invalid");
  });
});
```

`examples/docs-sample/pets-api.md`는 읽기만 하므로 복사하지 않는다. ingest는 원본을 바꾸지 않는다.

```bash
pnpm vitest run packages/ui-server/test/api.test.ts
```

기대 결과: `/api/systems`가 아직 없어 `{ ok:false, error:{ code:"not-found" } }`가 나오고 `toEqual`에서 실패한다.

- [ ] **Step 2: 구현**

본문 검증에는 zod를 쓴다. core가 이미 zod ^4.6.7에 의존하므로 ui-server `dependencies`에도 `"zod": "^4.6.7"`을 더한다.

```ts
const IngestBody = z.object({ system: z.string().min(1), origins: z.array(z.string().min(1)).min(1), refresh: z.boolean().optional() });
const SelectionBody = z.object({ ids: z.array(z.string()) });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new InvalidRequest(z.prettifyError(parsed.error));
  return parsed.data;
}
```

- `InvalidRequest extends Error`는 `toApiError`에서 `invalid`로 매핑한다. errors.ts에 클래스로 둔다.
- 빈 `ids`는 `select`가 `선택 결과가 비어 있습니다`를 던지므로 그대로 `invalid`가 된다.
- 라우트 핸들러는 서비스 함수를 부르고 `c.json({ ok: true, data })`만 한다.
- `systems.ts`:
  - `listSystems(ws)`: `readdir(ws.root, { withFileTypes: true })`에서 디렉터리이고 이름이 `/^[\p{L}\p{N}_-]+$/u`인 것만 고른다. 이름순으로 정렬한다.
  - `systemOverview(ws, root, s)`: 위 표의 모양을 만든다.
  - `defaultOutDir`는 `generate.json`의 outDir가 있으면 그 값이고, 없으면 `path.join(root, "mock", s)`다.
  - 작업 공간 경로는 `ws.root`(`workspace.ts:20` `constructor(readonly root …)`)로 읽는다.
- `api-types.ts`에 위 data 타입을 core 타입으로 정의한다(`import type { FeatureRow, Feature, ChunkSummary, IngestSpecResult, AnalyzeSpecResult } from "@specmock/core"`). `Selection`·`GenerateInfo`·`SourceInput`은 `types.ts`(94·141·69행)에 있고 index가 `export * from "./types.js"`로 내보낸다. kind 타입은 `SourceInput["kind"]`로 쓴다.

- [ ] **Step 3: 통과 확인과 커밋**

```bash
pnpm vitest run packages/ui-server
pnpm test && pnpm typecheck
git add packages/ui-server pnpm-lock.yaml
git commit -m "feat(ui-server): 등록·분석·청크·기능·선택 API"
```

---

### Task 5: 작업(job) 관리 + SSE + 작업 공간 감시

**Files:**
- Create: `packages/ui-server/src/{jobs.ts,bus.ts,watch.ts}`, `packages/ui-server/test/{jobs.test.ts,sse.test.ts,watch.test.ts}`
- Modify: `packages/ui-server/src/{app.ts,server.ts,api-types.ts}`

API 추가:

| 메서드·경로 | 동작 |
|---|---|
| `POST /systems/:s/extract` `{ refresh?: boolean }` | 작업 시작. `analyzeSpec(ws, s, { llm: "claude-code", adapter: new ClaudeCodeAdapter({ command: claudeCommand }), refresh, onEvent, signal })`(`llm` 열거값·`adapter`는 `service/analyze.ts:19,25`, `ClaudeCodeAdapter`·`ClaudeCodeOptions.command`는 core index export, `signal`은 Task 2에서 더함) → prepare → 청크 추출 → merge. 결과 `{ mode:"catalog", via:"llm", incomplete, ... }` |
| `POST /systems/:s/generate` `{ outDir?: string, force?: boolean }` | 작업 시작. `generate(ws, s, { outDir: outDir ?? defaultOutDir, force })` |
| `POST /systems/:s/verify` `{ dir?: string }` | 작업 시작. `verifyMock(ws, s, { dir, onEvent, signal })` |
| `GET /jobs` | `{ running: Job[], recent: Job[] }`. `recent`는 시스템·종류별 마지막 완료 작업 하나씩 |
| `POST /jobs/:id/cancel` | 취소. 없는 id면 404, 이미 끝났으면 `{ ok:true, data:{ state } }` |
| `GET /events` | SSE. 이벤트: `ready`, `job-started`, `job-progress`, `job-done`, `job-failed`, `workspace-changed`, `ping`(15s) |

작업 시작 응답:
- 성공하면 `202 { ok:true, data:{ jobId } }`다.
- 같은 시스템에 진행 중인 작업이 있으면 `409 { ok:false, error:{ code:"busy", message, hint:"진행 중인 작업이 있어요." }, jobId }`다. 화면은 이 `jobId`로 이동한다.

`Job` 모양:

```ts
{
  id: string; system: string; kind: "extract" | "generate" | "verify";
  state: "running" | "done" | "failed" | "cancelled";
  startedAt: string; endedAt?: string;
  progress?: { message: string; done?: number; total?: number };
  result?: unknown; error?: ApiErrorBody["error"];
}
```

SSE 이벤트 데이터:
- `job-*`의 data는 `Job` 그대로다.
- `workspace-changed`의 data는 `{ system: string | null, files: string[] }`다. `system: null`은 파일 이름을 알 수 없어 전체를 다시 불러오라는 뜻이다.

- [ ] **Step 1: 실패하는 테스트**

`jobs.test.ts`: `JobManager`를 직접 쓴다. 소켓은 필요 없다.

```ts
import { expect, it } from "vitest";
import { JobManager } from "../src/jobs.js";
import { EventBus } from "../src/bus.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

it("시스템당 하나: 진행 중에 또 시작하면 BusyJobError(jobId 포함)", async () => {
  const jobs = new JobManager(new EventBus());
  let finish!: () => void;
  const a = jobs.start("pets", "extract", () => new Promise<void>((r) => { finish = r; }));
  expect(() => jobs.start("pets", "verify", async () => {})).toThrowError(expect.objectContaining({ code: "busy", jobId: a.id }));
  jobs.start("other", "verify", async () => {}); // 다른 시스템은 된다
  finish(); await tick();
  expect(jobs.get(a.id)!.state).toBe("done");
});

it("cancel은 signal을 abort하고 state=cancelled, error.code=cancelled", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe((e) => seen.push(e.event));
  const jobs = new JobManager(bus);
  const j = jobs.start("pets", "extract", ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  jobs.cancel(j.id); await tick(); await tick();
  expect(jobs.get(j.id)).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
  expect(seen).toEqual(["job-started", "job-failed"]);
});

it("진행 이벤트는 job-progress로, 결과는 job-done으로", async () => {
  const bus = new EventBus();
  const seen: { event: string; data: any }[] = [];
  bus.subscribe((e) => seen.push(e));
  const jobs = new JobManager(bus);
  jobs.start("pets", "extract", async ({ onEvent }) => { onEvent({ stage: "extract", message: "추출 1/2", done: 1, total: 2 }); return { ok: 1 }; });
  await tick(); await tick();
  expect(seen.map((e) => e.event)).toEqual(["job-started", "job-progress", "job-done"]);
  expect(seen[1]!.data.progress).toEqual({ message: "추출 1/2", done: 1, total: 2 });
  expect(seen[2]!.data.result).toEqual({ ok: 1 });
  expect(jobs.list().recent).toHaveLength(1);
});
```

`sse.test.ts`: `createApp` + `app.request("/api/events")`의 body를 읽는다(열린 가정 A4).

```ts
it("ready 다음 작업 이벤트가 순서대로 온다", async () => {
  const { app, bus } = createApp({ root, webDir, port: () => 4310 });
  const res = await app.request("/api/events", { headers: HOST });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: string[] = [];
  const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; for (const m of value.matchAll(/^event: (.+)$/gm)) events.push(m[1]!); if (events.includes("job-done")) return; } })();
  await new Promise((r) => setTimeout(r, 20));
  bus.publish("job-started", { id: "1" }); bus.publish("job-done", { id: "1" });
  await pump; await reader.cancel();
  expect(events).toEqual(["ready", "job-started", "job-done"]);
});
```

추출 작업 통합 테스트도 `sse.test.ts`에 둔다. 가짜 claude를 쓴다.
- `createApp({ ..., claudeCommand: <REPO>/packages/core/test/bin/claude })`로 앱을 만들고, `pets-api.md`를 등록한 뒤 `/analyze`를 부른다.
- `POST /systems/pets/extract` → 202 `{jobId}`를 확인한다.
- `GET /jobs`를 폴링해 `recent[0].state === "done"`, `result.mode === "catalog"`를 확인한다.
- `GET /systems/pets/features`의 rows에 `GET /pets/{petId}`가 있는지 확인한다.

취소 통합 테스트:
- `claudeCommand`를 `claude-pid`로 주고 `PID_FILE`은 `process.env`로 넘긴다. `ClaudeCodeAdapter`는 자식에게 `{ ...process.env, ...opts.env }`를 준다(`claudeCode.ts:42`). 테스트가 끝나면 env를 지운다.
- `POST /jobs/:id/cancel` 뒤에 pid가 사라지고 `state === "cancelled"`인지 확인한다.
- 다시 `extract`를 시작할 수 있는지(busy가 아닌지) 확인한다.

`watch.test.ts`:

```ts
it("시스템 파일 변경 → workspace-changed{system,files}, .tmp·.lock은 무시, 디바운스로 한 번", async () => {
  const dir = path.join(root, ".specmock");
  await mkdir(path.join(dir, "pets"), { recursive: true });
  const got: { system: string | null; files: string[] }[] = [];
  const w = watchWorkspace(dir, (e) => got.push(e), { debounceMs: 100 });
  await writeFile(path.join(dir, "pets", "selection.json.123.tmp"), "x");
  await writeFile(path.join(dir, "pets", ".lock"), "x");
  await writeFile(path.join(dir, "pets", "selection.json"), "{}");
  await writeFile(path.join(dir, "pets", "mockspec.json"), "{}");
  await mkdir(path.join(dir, "pets", "extracted"), { recursive: true });
  await writeFile(path.join(dir, "pets", "extracted", "000.json"), "{}");
  await expect.poll(() => got.length, { timeout: 2000 }).toBe(1);
  expect(got[0]!.system).toBe("pets");
  expect(got[0]!.files.sort()).toEqual(["extracted/000.json", "mockspec.json", "selection.json"].sort());
  w.close();
});
```

`extracted` 디렉터리 생성 이벤트(`extracted`)는 파일 목록에서 빼도 되고 넣어도 된다. 플랫폼마다 디렉터리 이벤트가 다르기 때문이다. 실제 테스트는 `files`에 위 세 파일이 **포함되는지**(`expect.arrayContaining`)만 본다. 위 코드의 `toEqual`은 구현할 때 `arrayContaining`으로 쓴다.

```bash
pnpm vitest run packages/ui-server/test/jobs.test.ts packages/ui-server/test/sse.test.ts packages/ui-server/test/watch.test.ts
```

기대 결과: `Cannot find module '../src/jobs.js'` 등으로 실패한다.

- [ ] **Step 2: 구현**

`bus.ts`:

```ts
export interface BusEvent { event: string; data: unknown }
export class EventBus {
  private subs = new Set<(e: BusEvent) => void>();
  subscribe(fn: (e: BusEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  publish(event: string, data: unknown): void { for (const fn of this.subs) fn({ event, data }); }
}
```

`jobs.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { OnEvent } from "@specmock/core";
import type { EventBus } from "./bus.js";
import { toApiError } from "./errors.js";
import type { Job, JobKind } from "./api-types.js";

export class BusyJobError extends Error { readonly code = "busy" as const; constructor(readonly jobId: string) { super("이 시스템에서 진행 중인 작업이 있어요."); } }
export interface JobContext { signal: AbortSignal; onEvent: OnEvent }

export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running = new Map<string, string>(); // system → jobId
  constructor(private readonly bus: EventBus) {}

  start(system: string, kind: JobKind, run: (ctx: JobContext) => Promise<unknown>): Job {
    const busy = this.running.get(system);
    if (busy) throw new BusyJobError(busy);
    const job: Job = { id: randomUUID(), system, kind, state: "running", startedAt: new Date().toISOString() };
    const ac = new AbortController();
    this.jobs.set(job.id, job); this.controllers.set(job.id, ac); this.running.set(system, job.id);
    // SSE 루프는 큐에서 꺼낼 때 직렬화하므로 그때의 객체가 아니라 발행 시점의 사본을 보낸다.
    const snap = (): Job => ({ ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) });
    this.bus.publish("job-started", snap());
    const onEvent: OnEvent = (e) => { job.progress = { message: e.message, done: e.done, total: e.total }; this.bus.publish("job-progress", snap()); };
    void (async () => {
      try {
        job.result = await run({ signal: ac.signal, onEvent });
        job.state = "done"; job.endedAt = new Date().toISOString();
        this.bus.publish("job-done", snap());
      } catch (e) {
        job.error = toApiError(e).body.error;
        job.state = ac.signal.aborted ? "cancelled" : "failed";
        if (ac.signal.aborted) job.error = { code: "cancelled", message: "작업을 취소했어요." };
        job.endedAt = new Date().toISOString();
        this.bus.publish("job-failed", snap());
      } finally {
        this.running.delete(system); this.controllers.delete(job.id);
        this.prune(system, kind, job.id);
      }
    })();
    return job;
  }
  cancel(id: string): Job | undefined { this.controllers.get(id)?.abort(); return this.jobs.get(id); }
  get(id: string): Job | undefined { return this.jobs.get(id); }
  list(): { running: Job[]; recent: Job[] } {
    const all = [...this.jobs.values()];
    return { running: all.filter((j) => j.state === "running"), recent: all.filter((j) => j.state !== "running") };
  }
  /** 끝난 작업은 시스템·종류별 마지막 하나만 남긴다. */
  private prune(system: string, kind: JobKind, keep: string) {
    for (const [id, j] of this.jobs) if (id !== keep && j.system === system && j.kind === kind && j.state !== "running") this.jobs.delete(id);
  }
  /** 서버 종료 시 진행 중인 작업을 모두 취소한다. */
  cancelAll(): void { for (const ac of this.controllers.values()) ac.abort(); }
}
```

`generate` 작업이 `overwrite-required`로 실패하면 `job.error.code`가 그 값이 된다. 화면은 확인 창을 띄운 뒤 `force: true`로 다시 시작한다.

`watch.ts`:

```ts
import { watch } from "node:fs";

const IGNORE = /(^|\/)(\.lock|[^/]*\.tmp|[^/]*\.stale)$/;

export function watchWorkspace(dir: string, emit: (e: { system: string | null; files: string[] }) => void, opts: { debounceMs?: number; unref?: boolean } = {}) {
  const pending = new Map<string | null, Set<string>>();
  const timers = new Map<string | null, NodeJS.Timeout>();
  const w = watch(dir, { recursive: true }, (_ev, filename) => {
    const rel = filename ? String(filename).split(/[\\/]/).join("/") : null;
    if (rel && IGNORE.test(rel)) return;
    const [system, ...rest] = rel ? rel.split("/") : [null];
    const key = system ?? null;
    const set = pending.get(key) ?? new Set<string>();
    if (rest.length) set.add(rest.join("/"));
    pending.set(key, set);
    clearTimeout(timers.get(key));
    const t = setTimeout(() => { timers.delete(key); const files = [...(pending.get(key) ?? [])]; pending.delete(key); emit({ system: key, files }); }, opts.debounceMs ?? 150);
    if (opts.unref) t.unref();
    timers.set(key, t);
  });
  if (opts.unref) w.unref();
  return { close: () => { for (const t of timers.values()) clearTimeout(t); w.close(); } };
}
```

app.ts의 SSE:

```ts
import { streamSSE } from "hono/streaming";
app.get("/api/events", (c) => streamSSE(c, async (stream) => {
  const queue: BusEvent[] = [];
  let wake: (() => void) | undefined;
  const off = bus.subscribe((e) => { queue.push(e); wake?.(); });
  const ping = setInterval(() => { queue.push({ event: "ping", data: {} }); wake?.(); }, 15_000);
  if (opts.unref) ping.unref();
  stream.onAbort(() => { off(); clearInterval(ping); wake?.(); });
  await stream.writeSSE({ event: "ready", data: "{}" });
  while (!stream.aborted) {
    const e = queue.shift();
    if (!e) { await new Promise<void>((r) => { wake = r; }); wake = undefined; continue; }
    await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
  }
}));
```

- `createApp`은 `{ app, ws, bus, jobs }`를 돌려준다.
- `startUiServer`는 `watchWorkspace(<root>/.specmock, (e) => bus.publish("workspace-changed", e), { unref })`를 붙인다. `close()`에서 감시자를 닫고, `jobs.cancelAll()`을 부르고, 서버를 닫는다.
- 작업 라우트에서 `BusyJobError`는 `c.json({ ...errorBody("busy", e.message, "진행 중인 작업이 있어요."), jobId: e.jobId }, 409)`로 응답한다.
- `stream.aborted`·`onAbort` 이름은 hono 4.13 `SSEStreamingApi`에서 확인한다. 다르면 실행 기록에 남긴다.

- [ ] **Step 3: 통과 확인(반복 포함)과 커밋**

```bash
pnpm vitest run packages/ui-server
for i in 1 2 3; do pnpm vitest run packages/ui-server/test/watch.test.ts packages/ui-server/test/sse.test.ts --silent || break; done
pnpm test && pnpm typecheck
git add packages/ui-server
git commit -m "feat(ui-server): 작업 관리(시스템당 하나·취소·재연결용 /api/jobs), SSE, 작업 공간 감시"
```

기대 결과: 통과한다. 반복은 3회로 고정한다(감시·SSE의 타이밍 의존 확인).

---

### Task 6: `@specmock/web` 골격 — Vite/React, 토큰, 공통 틀, API 클라이언트, SSE 훅, vitest projects

**Files:**
- Create: `packages/web/{package.json,tsconfig.json,vite.config.ts,index.html}`
- Create: `packages/web/src/{main.tsx,App.tsx,api.ts,events.ts,route.ts}`, `src/styles/{tokens.css,app.css}`, `src/components/{Sidebar.tsx,StepBar.tsx,Notice.tsx,ConfirmDialog.tsx}`
- Create: `packages/web/test/{setup.ts,fakes.ts,App.test.tsx,api.test.ts}`
- Modify: `vitest.config.ts`, 루트 `package.json`

- [ ] **Step 1: 패키지와 설정**

`packages/web/package.json`:

```json
{
  "name": "@specmock/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.json && vite build",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "dev": "vite",
    "test": "vitest run --root ../.. --project web"
  },
  "dependencies": { "react": "^19.3.1", "react-dom": "^19.3.1" },
  "devDependencies": {
    "@specmock/core": "workspace:*",
    "@specmock/ui-server": "workspace:*",
    "@testing-library/dom": "^10.4.2",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.8",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.2.1",
    "jsdom": "^29.1.1",
    "vite": "^8.3.5"
  }
}
```

`@specmock/ui-server`와 `@specmock/core`는 devDependency다. 둘 다 **타입만** 가져오기 때문이다(`import type`, 결정 5). pnpm 엄격 모드에서는 직접 의존으로 적지 않은 패키지를 풀지 못하므로 core도 적는다. pnpm `-r build`는 위상 순서로 빌드하므로 ui-server가 web보다 먼저 빌드된다. ui-server는 web에 의존하지 않고 실행 중에 `../web/dist`를 읽으므로 순환이 없다.

`packages/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"], "jsx": "react-jsx",
    "strict": true, "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true,
    "skipLibCheck": true, "noEmit": true, "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`tsconfig.base.json`(NodeNext)은 상속하지 않는다. 번들러가 해석하므로 `.js` 확장자 import 규칙이 맞지 않기 때문이다.

`packages/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4310" } }, // 개발 중 `specmock ui --port 4310 --no-open` 옆에서 `pnpm --filter @specmock/web dev`
  test: {
    name: "web",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
```

`packages/web/index.html`에는 `<div id="root">`와 `<script type="module" src="/src/main.tsx">`를 두고, `<html lang="ko">`로 한다.

루트 `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: "node", include: ["packages/*/test/**/*.test.ts"], exclude: ["packages/web/**", "**/node_modules/**"] } },
      "packages/web/vite.config.ts",
    ],
  },
});
```

`packages/web/dist/`는 `.gitignore`의 `dist/` 규칙(3행)에 이미 걸린다.

```bash
pnpm install
pnpm vitest run --project node   # 기존 테스트가 그대로 node 프로젝트로 돈다
```

기대 결과: Task 5까지의 테스트 수와 같다. **A1·A2 확인**: `pnpm vitest list --project web`이 오류 없이 빈 목록을 내야 한다. `vitest/config`를 풀지 못하면 web devDependencies에 `"vitest": "^5.1.0"`을 더한다. `projects` 경로 해석이 다르면 `{ extends: "packages/web/vite.config.ts", test: { root: "packages/web" } }` 형태로 바꾼다. 어느 쪽이든 실행 기록에 남긴다.

- [ ] **Step 2: 실패하는 테스트**

`test/setup.ts`:

```ts
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());
```

`test/fakes.ts`는 가짜 `fetch`와 가짜 `EventSource`를 둔다.
- `fakeApi(routes: Record<string, (body?: unknown) => { status?: number; body: unknown }>)`: 키는 `"GET /api/systems"` 형식이다. 호출은 `calls`에 기록한다. `vi.stubGlobal("fetch", …)`로 설치한다.
- `FakeEventSource`: `emit(event, data)`로 이벤트를 흘린다. 인스턴스는 `FakeEventSource.last`로 찾는다.

`test/api.test.ts`:

```ts
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());

it("ok면 data를, 아니면 ApiError(code, hint)를", async () => {
  fakeApi({
    "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude: false } } }),
    "GET /api/systems/x/features": () => ({ status: 404, body: { ok: false, error: { code: "not-found", message: "없음", hint: "먼저 ② 분석을 진행해 주세요." } } }),
  });
  expect(await api.env()).toEqual({ root: "/r", claude: false });
  await expect(api.features("x")).rejects.toMatchObject({ code: "not-found", hint: "먼저 ② 분석을 진행해 주세요." });
  await expect(api.features("x")).rejects.toBeInstanceOf(ApiError);
});
```

`test/App.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FakeEventSource, fakeApi } from "./fakes";

beforeEach(() => { vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

const systems = [
  { name: "petstore", kind: "openapi", steps: { registered: true, analyzed: true, selected: true, generated: false, verified: false }, stale: {} },
  { name: "pets", kind: "markdown", steps: { registered: true, analyzed: false, selected: false, generated: false, verified: false }, stale: {}, chunks: { done: 0, total: 3 } },
];

it("사이드바에 시스템 목록과 + 스펙 등록, 상단에 단계 5개", async () => {
  fakeApi({ "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude: true } } }), "GET /api/systems": () => ({ body: { ok: true, data: systems } }) });
  render(<App />);
  const nav = await screen.findByRole("navigation", { name: "시스템" });
  expect(within(nav).getByRole("link", { name: /petstore/ })).toBeTruthy();
  expect(within(nav).getByRole("link", { name: "+ 스펙 등록" })).toBeTruthy();
  for (const s of ["① 등록", "② 분석", "③ 기능 선택", "④ 생성", "⑤ 검증"]) expect(screen.getByText(s)).toBeTruthy();
});

it("workspace-changed가 오면 시스템 목록을 다시 불러온다", async () => {
  const api = fakeApi({ "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude: true } } }), "GET /api/systems": () => ({ body: { ok: true, data: systems } }) });
  render(<App />);
  await screen.findByRole("link", { name: /petstore/ });
  const before = api.calls.filter((c) => c === "GET /api/systems").length;
  FakeEventSource.last!.emit("workspace-changed", { system: "pets", files: ["catalog.json"] });
  await vi.waitFor(() => expect(api.calls.filter((c) => c === "GET /api/systems").length).toBe(before + 1));
});

it("SSE가 끊기면 '연결이 끊겼어요' 알림, 다시 연결되면 사라진다", async () => { /* FakeEventSource.last.fail() → 알림 → emit("ready") → 사라짐 */ });
```

jest-dom은 쓰지 않는다. `toBeTruthy`, `getAttribute`, `textContent`로 확인한다.

```bash
pnpm vitest run --project web
```

기대 결과: `Failed to resolve import "../src/api"` 등으로 실패한다.

- [ ] **Step 3: 구현**

`src/api.ts`:

```ts
import type { ApiErr, ApiOk, EnvInfo, SystemSummary, SystemOverview, FeatureList, Job, JobList } from "@specmock/ui-server/api-types";
import type { ChunkSummary, Feature, Selection } from "@specmock/core";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string, readonly jobId?: string) { super(message); }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as ApiOk<T> | (ApiErr & { jobId?: string });
  if (j.ok) return j.data;
  throw new ApiError(r.status, j.error.code, j.error.message, j.error.hint, j.jobId);
}
const s = (name: string) => `/api/systems/${encodeURIComponent(name)}`;

export const api = {
  env: () => call<EnvInfo>("GET", "/api/env"),
  systems: () => call<SystemSummary[]>("GET", "/api/systems"),
  ingest: (system: string, origins: string[]) => call<unknown>("POST", "/api/systems", { system, origins }),
  overview: (name: string) => call<SystemOverview>("GET", s(name)),
  analyze: (name: string) => call<{ mode: "catalog" | "prepared" }>("POST", `${s(name)}/analyze`),
  chunks: (name: string) => call<ChunkSummary[]>("GET", `${s(name)}/chunks`),
  features: (name: string, group?: string) => call<FeatureList>("GET", `${s(name)}/features${group ? `?group=${encodeURIComponent(group)}` : ""}`),
  feature: (name: string, id: string) => call<Feature>("GET", `${s(name)}/features/${encodeURIComponent(id)}`),
  selection: (name: string) => call<Selection | null>("GET", `${s(name)}/selection`),
  saveSelection: (name: string, ids: string[]) => call<{ selected: string[] }>("POST", `${s(name)}/selection`, { ids }),
  extract: (name: string, refresh = false) => call<{ jobId: string }>("POST", `${s(name)}/extract`, { refresh }),
  generate: (name: string, outDir: string, force = false) => call<{ jobId: string }>("POST", `${s(name)}/generate`, { outDir, force }),
  verify: (name: string) => call<{ jobId: string }>("POST", `${s(name)}/verify`, {}),
  jobs: () => call<JobList>("GET", "/api/jobs"),
  cancel: (id: string) => call<Job>("POST", `/api/jobs/${id}/cancel`),
};
```

Task 4·5에서 `api-types.ts`에 `SystemSummary`, `SystemOverview`, `FeatureList`, `Job`, `JobList`가 정의되어 있어야 한다. 빠진 것이 있으면 이 Task에서 더한다.

`src/events.ts`: `useServerEvents(handlers)` 훅이다.
- `new EventSource("/api/events")`를 하나 연다(App에서 한 번).
- `ready`면 `connected = true`, `onerror`면 `false`로 둔다. EventSource는 스스로 재연결한다.
- 다시 연결되면(`ready`) 핸들러의 `onReconnect`를 부른다. App은 여기서 `api.systems()`와 `api.jobs()`를 다시 불러 진행 중인 작업을 이어 보여 준다.
- 이벤트 이름별로 핸들러를 부른다.

`src/route.ts`: 라우터 의존성 없이 `history.pushState` + `popstate`로 처리한다. 경로 규칙은 다음과 같다.
- `/` → 첫 시스템 또는 등록 화면
- `/new` → ① 등록
- `/systems/:s/analyze` → ②
- `/systems/:s/select` → ③
- `/systems/:s/generate` → ④
- `/systems/:s/verify` → ⑤

`useRoute()`가 `{ screen, system, go(path) }`를 준다. 서버의 SPA 폴백(Task 3) 덕분에 새로 고침해도 같은 화면이 열린다.

`src/App.tsx`의 틀은 기준 시안의 3카드 배치다. 사이드바 카드 232px, 본문 카드, 상세 카드 392px(③에서만)를 8px 간격으로 놓는다.
- `<nav aria-label="시스템">`: 시스템마다 `<a>`(이름 + 단계 점 5개) 하나, 맨 아래에 "+ 스펙 등록".
- `<StepBar>`: 높이 56px. 단계 칩 5개를 `radius-sm`으로 그린다(결정 11).
  - 완료한 단계는 `<button>`(클릭하면 이동)이다. 아직 못 가는 단계는 `aria-disabled="true"`다.
  - `stale` 단계에는 "다시 실행 필요" 보조 글자(`text-3`)를 붙인다.
- `<Notice>`: 오류와 연결 상태 알림이다. `role="alert"`이고 hint가 있으면 둘째 줄에 둔다.
- `<ConfirmDialog>`: `<dialog>` 요소다. 제목, 본문, "취소" / 주 버튼을 둔다. 주 버튼은 높이 42px, `accent`. jsdom은 `HTMLDialogElement.showModal`을 지원하지 않으므로 `open` 속성을 직접 토글한다.

`src/styles/tokens.css`는 §3.3 표를 그대로 옮긴다.

```css
:root {
  --bg: #101013; --surface-1: #17171c; --surface-2: #202027; --surface-3: #2c2c35;
  --line: #26262d; --line-strong: #34343d;
  --text: #ffffff; --text-2: #c3c3c6; --text-3: #8b8b92;
  --accent: #3182f6; --accent-ink: #ffffff; --selected: rgba(49,130,246,.16);
  --get: #33c48a; --post: #ffb331; --put: #4e9bff; --patch: #a586ff; --delete: #f04452;
  --ok: #33c48a; --danger: #f04452;
  --radius-sm: 8px; --radius-lg: 14px;
  --font: Pretendard, "Apple SD Gothic Neo", system-ui, sans-serif;
  --mono: "JetBrains Mono", "SF Mono", Menlo, monospace;
  --fs-body: 14px; --fs-title: 24px; --fs-detail-path: 22px; --fs-code: 13.5px; --fs-num: 12px;
  --h-row: 32px; --h-group: 36px; --h-input: 38px; --h-button: 42px; --h-top: 56px;
  --w-sidebar: 232px; --w-detail: 392px; --gap: 8px;
  color-scheme: dark;
}
```

`app.css`는 기준 시안(`docs/superpowers/specs/assets/2026-11-06-phase2b-style-reference.html`)의 `<style>`을 토큰 변수로 옮긴 것이다. 크기는 토큰 값을 쓰고 단계 칩은 8px로 한다(결정 11). `@font-face`나 웹 폰트 URL은 넣지 않는다.

- [ ] **Step 4: 통과 확인과 빌드**

```bash
pnpm vitest run --project web
pnpm build && ls packages/web/dist/index.html packages/web/dist/assets
pnpm test && pnpm typecheck
```

기대 결과: web 테스트가 통과한다. `dist/index.html`과 해시가 붙은 `assets/*.js`·`*.css`가 생긴다. 이제 Task 3의 `DEFAULT_WEB_DIR`가 실제 빌드를 가리킨다.

- [ ] **Step 5: 커밋**

```bash
git add packages/web vitest.config.ts package.json pnpm-lock.yaml .gitignore
git commit -m "feat(web): 화면 골격 — Vite/React, 디자인 토큰, 공통 틀, API 클라이언트, SSE 재연결"
```

---

### Task 7: 화면 ① 등록, ② 분석

**Files:**
- Create: `packages/web/src/screens/{Register.tsx,Analyze.tsx}`, `packages/web/src/components/ChunkTable.tsx`
- Test: `packages/web/test/{Register.test.tsx,Analyze.test.tsx}`

- [ ] **Step 1: 실패하는 테스트**

`Register.test.tsx`:
- 경로 `/x/docs/petstore.yaml`을 입력하면 시스템 이름 칸에 `petstore`가 제안된다. 이름은 직접 고칠 수 있다.
- URL `https://api.example.com/openapi.json`이면 `api-example-com`이 제안된다(호스트, 점은 `-`).
- "등록"을 누르면 `POST /api/systems {system, origins:[경로]}`가 호출된다. 응답의 `inputs[0].kind`가 "형식: OpenAPI"처럼 표시되고 `/systems/petstore/analyze`로 이동한다.
- 400 `invalid`면 `role="alert"`에 message가 나온다.

이름 제안 규칙: 파일이면 확장자를 뺀 basename, URL이면 hostname이다. 둘 다 `[^\p{L}\p{N}_-]`를 `-`로 바꾸고 소문자로 만든다. 순수 함수 `suggestSystemName`으로 만들어 `test/name.test.ts`에서 따로 확인한다. kind 표시 이름은 `openapi→OpenAPI`, `html→웹 페이지`, `markdown→Markdown`, `pdf→PDF`, `text→텍스트`다. 이 다섯 값이 `SourceInputSchema.kind` 열거값 전부다(`packages/core/src/types.ts:59`).

`Analyze.test.tsx`:
- OpenAPI: overview가 `analyze:"none"`이면 "분석하기" 버튼 하나가 보인다. 누르면 `POST /analyze`가 호출되고, `mode:"catalog"`가 오면 `/systems/petstore/select`로 이동한다.
- 문서: `analyze:"prepared"`이면 청크 표(제목, 글자 수, 상태 "대기/완료/실패")가 보인다.
- "추출 시작"을 누르면 확인 창이 뜬다. 문구는 "청크 3개를 `claude` CLI로 추출해요. 구독 사용량이 발생해요."다.
  - "취소"를 누르면 아무 호출도 없다.
  - "추출 시작"을 누르면 `POST /extract {refresh:false}`가 호출된다.
- 진행: `job-progress {progress:{done:1,total:3}}` 이벤트가 오면 진행 바가 `aria-valuenow="1"`, `aria-valuemax="3"`가 된다. 이 중에 "취소"를 누르면 `POST /api/jobs/<id>/cancel`이 호출된다.
- `job-done {result:{mode:"catalog"}}`가 오면 `/select`로 이동한다. `result.incomplete`이 있으면 이동하지 않고 "실패한 청크 N개만 다시 추출" 버튼을 보인다. 이 버튼은 `refresh:false`로 다시 시작하며, extract가 완료·최신 청크를 건너뛴다(`extract.ts:45`).
- `env.claude === false`이면 "추출 시작" 대신 다음 안내가 나온다: "이 컴퓨터에서 `claude` CLI를 찾지 못했어요. Claude Code 대화에서 `analyze_spec`부터 진행하면 추출 결과가 이 화면에 바로 반영돼요."
- 409 busy이고 `jobId`가 있으면 그 작업의 진행 표시로 이어진다.

```bash
pnpm vitest run --project web test/Register.test.tsx test/Analyze.test.tsx test/name.test.ts
```

기대 결과: `Failed to resolve import "../src/screens/Register"`.

- [ ] **Step 2: 구현**
- 화면은 `api`와 `useServerEvents`만 쓴다. 상태는 각 화면의 `useState`에 둔다(상태 관리 라이브러리 없음).
- 청크 표 행 높이는 32px다. 상태 글자색은 완료가 `ok`, 실패가 `danger`, 대기가 `text-3`이다.
- 진행 바는 `<div role="progressbar" aria-valuemin=0 aria-valuenow aria-valuemax>`로 만든다. 채움은 `accent`다.
- 진행 중인 작업은 App이 가진 `jobs` 상태(`/api/jobs` + SSE)에서 `system === 현재 && state === "running"`인 것으로 찾는다. 그래서 새로 고침해도 진행 표시가 이어진다.
- 청크 상태는 `GET /chunks`의 `done`과 job 진행으로 그린다. `workspace-changed {files:["extracted/…"]}`가 오면 다시 불러온다. 대화에서 제출한 결과도 이렇게 반영된다(완료 기준 3).

- [ ] **Step 3: 통과 확인과 커밋**

```bash
pnpm vitest run --project web
pnpm typecheck
git add packages/web
git commit -m "feat(web): ① 등록(형식 표시·이름 제안), ② 분석(청크 표·확인 창·진행·취소·실패 재시도)"
```

---

### Task 8: 화면 ③ 기능 선택

**Files:**
- Create: `packages/web/src/screens/Select.tsx`, `src/components/{FeatureTable.tsx,FeatureDetail.tsx,TriCheckbox.tsx,SelectionBar.tsx}`, `src/selection.ts`
- Test: `packages/web/test/{selection.test.ts,Select.test.tsx}`

- [ ] **Step 1: 실패하는 테스트**

`selection.test.ts`는 순수 로직 테스트다.

```ts
import { expect, it } from "vitest";
import { groupState, toggleGroup, filterRows } from "../src/selection";

const rows = [
  { id: "pets.list", group: "pets", method: "GET", path: "/pets", summary: "목록" },
  { id: "pets.create", group: "pets", method: "POST", path: "/pets", summary: "등록" },
  { id: "store.inv", group: "store", method: "GET", path: "/store/inventory", summary: "재고" },
] as const;

it("그룹 3상태", () => {
  expect(groupState(rows, "pets", new Set())).toBe("none");
  expect(groupState(rows, "pets", new Set(["pets.list"]))).toBe("some");
  expect(groupState(rows, "pets", new Set(["pets.list", "pets.create"]))).toBe("all");
});
it("그룹 토글: none/some → all, all → none (보이는 행만)", () => {
  expect([...toggleGroup(rows, "pets", new Set(["pets.list"]))].sort()).toEqual(["pets.create", "pets.list"]);
  expect([...toggleGroup(rows, "pets", new Set(["pets.list", "pets.create", "store.inv"]))]).toEqual(["store.inv"]);
});
it("검색(경로·요약·id, 대소문자 무시) + 그룹·메서드 필터", () => {
  expect(filterRows(rows, { q: "INVEN" }).map((r) => r.id)).toEqual(["store.inv"]);
  expect(filterRows(rows, { method: "POST" }).map((r) => r.id)).toEqual(["pets.create"]);
  expect(filterRows(rows, { group: "store", q: "pets" })).toEqual([]);
});
```

`FeatureRow`의 실제 필드 이름(`summary` 유무 등)은 `packages/core/src/service/features.ts`의 `ListFeaturesResult`에서 확인하고 테스트 데이터를 그에 맞춘다. MCP `list_features` outputSchema(`mock.ts`)에는 `index, id, group, method, path, provenance, confidence, hasExample, warnings`가 있고 summary는 없다. 검색 대상은 있는 필드로 정한다.

`Select.test.tsx`:
- 그룹 행의 체크박스는 `role="checkbox"`다. 일부만 선택되면 `aria-checked="mixed"`다.
  - 그룹 체크박스를 누르면 400ms 디바운스 뒤 `POST /selection {ids}`가 **한 번** 호출된다. 테스트는 `vi.useFakeTimers()` 뒤 `advanceTimersByTime(400)`.
- 그룹 행을 누르면 접히고 펼쳐진다(`aria-expanded`).
- 행을 누르면 오른쪽 상세 패널에 `GET /features/:id` 결과(메서드, 경로, 요청/응답 스키마, 예시, 출처 인용)가 나온다. 체크박스 클릭은 상세를 열지 않는다.
- 하단 고정 바는 "3개 선택 · mock 생성 →"이다. 0개면 버튼이 비활성이고 "하나 이상 골라 주세요"가 보인다(결정 2). 0개는 저장 호출을 하지 않는다.
- 저장이 실패하면 `role="alert"`에 오류와 hint가 나온다. 선택 상태는 화면에 유지한다.
- 외부 변경: `workspace-changed {system:"petstore", files:["selection.json"]}`가 오면 다음처럼 처리한다.
  - 로컬에 저장 안 된 변경이 없으면 `GET /selection`을 다시 불러 반영한다.
  - 저장 대기 중(디바운스 안)이면 "다른 곳에서 선택이 바뀌었어요. [불러오기]" 배너를 띄우고 로컬 값을 유지한다.
  - 우리가 저장하고 1초 안에 온 이벤트는 무시한다.
- `catalog.json`이 바뀌면 목록을 다시 부른다. 없는 id는 선택에서 빠진다(core `select`의 `catalogChanged`와 같은 의미).
- 선택 안 된 행은 경로를 `text-3`으로 흐리게 보인다. `{petId}` 같은 경로 변수는 `<span class="var">`로 감싸 `text-3`. 클래스 이름으로 확인한다.

```bash
pnpm vitest run --project web test/selection.test.ts test/Select.test.tsx
```

기대 결과: 모듈이 없어 실패한다.

- [ ] **Step 2: 구현**
- `selection.ts`에 `groupState`, `toggleGroup`, `filterRows`, `splitPathVars`가 있다. 그룹 토글은 **필터로 보이는 행만** 바꾼다. 검색 중 그룹 체크가 숨은 행을 건드리지 않게 하기 위해서다.
- `TriCheckbox`: 원형 체크박스(§3.3)다. `role="checkbox"`, `aria-checked` 값은 `true`/`false`/`mixed`이고 Space·Enter 키를 받는다.
- `FeatureTable`의 그룹 행은 36px, 기능 행은 32px다. 메서드 글자는 `--get` 같은 색 변수에 `mono 12px`다. 선택된 행 배경은 `selected`다. 메서드는 배지 없이 글자색만 쓴다.
- `FeatureDetail`: 392px 카드다. 경로는 `mono 22px`이고, 스키마·예시는 `<pre>`(mono 13.5px)로 보인다. 출처는 `provenance`·`confidence`·근거 인용을 보인다.
- 저장: 마지막 변경 400ms 뒤에 `api.saveSelection(ids)`를 부른다. 진행 중인 저장이 있으면 끝난 뒤 최신 값으로 한 번 더 부른다(직렬화).
- 서버는 `select`를 잠금 안에서 처리하므로(Task 1) CLI·대화와 동시에 써도 파일은 깨지지 않는다. 마지막에 쓴 쪽이 남는다.

- [ ] **Step 3: 통과 확인과 커밋**

```bash
pnpm vitest run --project web
pnpm typecheck
git add packages/web
git commit -m "feat(web): ③ 기능 선택 — 그룹 3상태·검색·필터·상세 패널·자동 저장·외부 변경 배너"
```

---

### Task 9: 화면 ④ 생성, ⑤ 검증

**Files:**
- Create: `packages/web/src/screens/{Generate.tsx,Verify.tsx}`
- Test: `packages/web/test/{Generate.test.tsx,Verify.test.tsx}`

- [ ] **Step 1: 실패하는 테스트**

`Generate.test.tsx`:
- 출력 디렉터리 입력의 기본값은 overview의 `defaultOutDir`이다(예: `/r/mock/petstore`). 값은 고칠 수 있다.
- "생성"을 누르면 `POST /generate {outDir, force:false}`가 호출된다.
- `job-failed {error:{code:"overwrite-required", message}}`가 오면 확인 창이 뜬다. 제목은 "덮어쓸까요?"이고, 본문에 경로와 message가 들어간다.
  - "덮어쓰기"를 누르면 `force:true`로 다시 호출한다.
  - "취소"를 누르면 호출하지 않는다.
- `job-done {result:{dir, files:[…], ...}}`가 오면 생성 파일 목록과 실행 방법을 보인다. 실행 방법은 `cd <dir> && npm install && npm start`이고, 결과의 실제 필드에 맞춘다. 그 아래에 "⑤ 검증으로 →" 버튼이 있다.
- `GenerateResult` 필드(파일 목록·실행 명령)는 `packages/core/src/generate/index.ts`와 CLI `commands/generate.ts`의 출력 문구에서 확인해 같은 내용을 보인다.

`Verify.test.tsx`:
- "검증 시작"을 누르면 `POST /verify`가 호출된다. 진행 메시지(`job-progress.progress.message`, 예: "npm install…", "계약 테스트 3/5")가 보인다. 이때 취소 버튼이 있다.
- `job-done`가 오면 기능별 통과/실패 표를 보인다. 통과는 `ok`, 실패는 `danger` 글자로 한다. 실패 행은 펼쳐서 이유를 볼 수 있다. 위에는 "통과 N · 실패 M"과 커버리지 요약(`coverage.md` 앞부분, MCP `coverageSummary`와 같은 범위)을 보인다.
- `failed > 0`은 오류 알림이 아니라 결과다(CLI의 종료 코드 2와 같은 상황). `role="alert"`를 쓰지 않는다.
- `stale.verify`(생성이 검증보다 새로움)면 "다시 실행 필요" 표시가 뜬다.

`VerifyMockResult`는 `{ dir, result: VerifyResult, coverageFile, coverageMarkdown }`다(`service/verify.ts:20`). 기능별 행은 `result`(`VerifyResult`, `packages/core/src/verify/index.ts`)에서 그리고, 커버리지 요약은 `coverageMarkdown`의 `## contract test` 앞부분을 쓴다. 테스트 데이터는 `VerifyResult` 타입에 맞춘다.

```bash
pnpm vitest run --project web test/Generate.test.tsx test/Verify.test.tsx
```

기대 결과: 모듈이 없어 실패한다.

- [ ] **Step 2: 구현**

화면은 Task 7과 같은 작업 진행 패턴을 쓴다. 이 패턴은 `useJob(system, kind)` 훅으로 묶는다(Task 7의 추출 화면도 이 훅으로 바꾼다). 커버리지 요약은 서버 overview의 `coverage`(문자열)에서 `## contract test` 앞부분을 잘라 `<pre>`로 보인다.

- [ ] **Step 3: 통과 확인과 커밋**

```bash
pnpm vitest run --project web
pnpm build && pnpm test && pnpm typecheck
git add packages/web
git commit -m "feat(web): ④ 생성(덮어쓰기 확인), ⑤ 검증(기능별 결과·커버리지)"
```

---

### Task 10: 진입점 — `specmock ui`, MCP `open_ui`(11번째 도구), 스킬 안내

**Files:**
- Create: `packages/cli/src/commands/ui.ts`, `packages/cli/test/ui.test.ts`
- Modify: `packages/cli/src/cli.ts`, `packages/cli/package.json`
- Create: `packages/mcp/src/tools/ui.ts`, `packages/mcp/test/ui.test.ts`
- Modify: `packages/mcp/src/{names.ts,createServer.ts}`, `packages/mcp/package.json`, `packages/mcp/test/{tools.test.ts,plugin.test.ts}`
- Modify: `plugin/skills/specmock/SKILL.md`
- Modify: `packages/ui-server/src/{server.ts,app.ts}` (`workspaceDir`, 결정 13)

- [ ] **Step 1: 실패하는 테스트**

`packages/cli/test/ui.test.ts`: `cli.test.ts`처럼 `tsx packages/cli/src/cli.ts`를 자식 프로세스로 띄운다.

```ts
it("specmock ui --no-open: URL을 찍고, /api/env가 응답하고, SIGINT로 끝난다", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, "ui", "--no-open"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (b: Buffer) => { const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(String(b)); if (m) resolve(m[0]); });
    child.once("exit", (c) => reject(new Error(`exit ${c}`)));
  });
  const env = await (await fetch(new URL("/api/env", url))).json();
  expect(env.data.root).toBe(dir);
  child.kill("SIGINT");
  expect(await new Promise((r) => child.once("exit", r))).toBe(0);
});
it("--workspace를 따른다", async () => { /* --workspace state 로 띄우고 ingest 후 dir/state/petstore 존재 확인 */ });
it("열기 명령: darwin=open, linux=xdg-open, win32=cmd /c start", () => {
  expect(openCommand("darwin", "http://x/")).toEqual(["open", ["http://x/"]]);
  expect(openCommand("linux", "http://x/")).toEqual(["xdg-open", ["http://x/"]]);
  expect(openCommand("win32", "http://x/")).toEqual(["cmd", ["/c", "start", "", "http://x/"]]);
});
```

`cli.test.ts`가 CLI를 띄우는 방식(실행기 경로, `tsx` 사용법)은 그 파일의 helper를 그대로 따른다. 위 `spawn` 인자는 예시다. `dir`은 `await realpath(await mkdtemp(...))`로 만든다. darwin에서는 `process.cwd()`가 `/private/var/...`를 돌려주므로, 그대로 두면 `env.data.root`와 비교할 때 어긋난다(MCP 테스트와 같은 처리).

`packages/mcp/test/ui.test.ts`:

```ts
it("open_ui는 http://127.0.0.1:<port>/ URL을 돌려주고 두 번 불러도 같다", async () => {
  const a = await s.ok("open_ui", {});
  const b = await s.ok("open_ui", {});
  expect(a.structuredContent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(b.structuredContent.url).toBe(a.structuredContent.url);
  const env = await (await fetch(new URL("/api/env", a.structuredContent.url))).json();
  expect(env.data.root).toBe(dir);
});
it("stdin이 닫히면 화면 서버가 떠 있어도 MCP 프로세스가 끝난다", async () => {
  /* dist/server.js를 직접 spawn → initialize + open_ui 호출 → child.stdin.end() → 5초 안에 exit */
});
```

`helpers.ts`의 `connect`, `s.ok`의 반환 모양은 기존 테스트에 맞춘다. 두 번째 테스트는 빌드된 `packages/mcp/dist/server.js`를 쓴다. 루트 `test`가 먼저 빌드하므로 있다.

기존 테스트를 고친다(사전 확인 사실).
- `tools.test.ts:20,23`의 이름·개수를 `11 tools`, `toHaveLength(11)`로 바꾼다. `:205,211`의 `listTools().tools.length).toBe(10)`도 11로 맞춘다.
- `plugin.test.ts:24`는 스킬 문서에서 백틱 도구 이름을 접미사 정규식 `(?:spec|chunk|extraction|extractions|features?|mock)`으로 모아 TOOL_NAMES와 비교한다. 이 접미사 그룹에 `|ui`를 더한다. 그러지 않으면 `open_ui`가 문서에서 수집되지 않아 집합이 달라진다.

```bash
pnpm vitest run packages/cli/test/ui.test.ts packages/mcp
```

기대 결과: `unknown command 'ui'`, `Tool open_ui not found`, `expected 10 to be 11`로 실패한다.

- [ ] **Step 2: 구현 — CLI**

`packages/cli/package.json` dependencies에 `"@specmock/ui-server": "workspace:*"`를 더한다.

`commands/ui.ts`:

```ts
import { spawn } from "node:child_process";
import path from "node:path";
import { startUiServer } from "@specmock/ui-server";
import type { Command } from "commander";

export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description("브라우저 화면으로 등록부터 검증까지 진행한다 (127.0.0.1에서만 열림)")
    .option("--port <n>", "포트 (생략하면 자동)", (v) => Number.parseInt(v, 10))
    .option("--no-open", "브라우저를 열지 않는다")
    .action(async (opts: { port?: number; open: boolean }, cmd: Command) => {
      const workspace = cmd.optsWithGlobals<{ workspace: string }>().workspace;
      const ui = await startUiServer({ root: process.cwd(), workspaceDir: path.resolve(workspace), port: opts.port });
      process.stdout.write(`specmock 화면: ${ui.url}\n끝내려면 Ctrl+C\n`);
      if (opts.open) {
        const [bin, args] = openCommand(process.platform, ui.url);
        spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => process.stderr.write(`브라우저를 열지 못했어요. 직접 여세요: ${ui.url}\n`)).unref();
      }
      const stop = () => { void ui.close().then(() => process.exit(0)); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
}
```

`cli.ts`에 `registerUi(program)`을 `registerRun` 다음에 더한다. `--workspace`는 `context.ts:10`과 같이 `cmd.optsWithGlobals()`로 읽는다(기본값 `.specmock`).

ui-server의 `StartUiServerOptions`·`AppOptions`에 `workspaceDir?: string`을 더하고, `.specmock` 경로를 모두 `opts.workspaceDir ?? path.join(opts.root, ".specmock")`로 바꾼다(결정 13).

- [ ] **Step 3: 구현 — MCP**

`packages/mcp/package.json` dependencies에 `"@specmock/ui-server": "workspace:*"`를 더한다. 루트 `build:mcp`(`@specmock/mcp...`)는 의존 패키지를 함께 빌드하지만 web은 의존 대상이 아니다. 결정 6에 따라 루트 `test`는 이미 `pnpm build`(전체)로 바뀌었다.

`names.ts`의 `TOOL_NAMES` 끝에 `"open_ui"`를 더한다.

`tools/ui.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { startUiServer, type UiServerHandle } from "@specmock/ui-server";
import { z } from "zod";
import { guard, ok } from "../result.js";

export function registerUiTools(server: McpServer, root: string): void {
  let running: Promise<UiServerHandle> | undefined;
  server.registerTool("open_ui", {
    title: "화면 열기",
    description: "기능 선택·생성·검증을 브라우저 화면에서 하고 싶을 때 쓴다. 이 대화와 같은 작업 공간을 쓰는 로컬 화면 서버(127.0.0.1)를 띄우고 URL을 돌려준다. URL을 사용자에게 보여 주고 열어 달라고 안내한다. 이미 떠 있으면 같은 URL을 돌려준다.",
    inputSchema: z.object({}),
    outputSchema: z.object({ url: z.string() }),
  }, guard(async () => {
    running ??= startUiServer({ root, unref: true }).catch((e) => { running = undefined; throw e; });
    const { url } = await running;
    return ok(`화면: ${url}`, { url });
  }));
}
```

`createServer.ts`에서 `registerUiTools(server, root)`를 부른다. `guard`·`ok`의 실제 시그니처는 `result.ts`에 맞춘다. 웹 빌드가 없으면 `startUiServer`의 "`pnpm build`를 먼저 실행하세요" 오류가 `guard`를 거쳐 도구 오류로 나간다.

- [ ] **Step 4: 스킬 안내**

`plugin/skills/specmock/SKILL.md`의 도구 표에 `| \`open_ui\` | 화면(브라우저)으로 기능을 고르고 생성·검증하고 싶을 때. URL을 돌려준다 |` 행을 더한다. 흐름 절에는 다음 한 줄을 더한다: "사용자가 '화면으로 고르고 싶다', '표로 보면서 체크하고 싶다'고 하면 `open_ui`를 부르고 URL을 안내한다. 화면에서 바꾼 선택은 같은 작업 공간에 저장되므로, 대화로 돌아오면 `list_features`로 다시 확인한다." `plugin.test.ts`는 SKILL.md와 `references/extraction.md`에서 백틱으로 언급한 도구 이름 집합이 TOOL_NAMES 11개와 같은지 본다. 그래서 `open_ui`를 백틱으로 한 번 이상 써야 한다.

- [ ] **Step 5: 통과 확인과 커밋**

```bash
pnpm vitest run packages/cli packages/mcp
pnpm test && pnpm typecheck
git add packages/cli packages/mcp packages/ui-server plugin pnpm-lock.yaml
git commit -m "feat: specmock ui 명령과 MCP open_ui(11번째 도구), 스킬 안내"
```

---

### Task 11: E2E(Playwright) + 문서

**Files:**
- Create: `playwright.config.ts`, `e2e/serve.ts`, `e2e/ui.spec.ts`
- Modify: 루트 `package.json`(devDependency `@playwright/test`, `test:e2e`), `.gitignore`(`e2e/.tmp/`), `tsconfig.scripts.json`(include에 e2e·playwright.config.ts)
- Modify: `README.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-11-04-specmock-design.md`

- [ ] **Step 1: 설치와 A5 확인**

```bash
pnpm add -Dw @playwright/test@1.64.1 "@specmock/ui-server@workspace:*"   # e2e/serve.ts가 import한다
pnpm exec playwright install chromium
pnpm exec playwright --version
```

기대 결과: `Version 1.64.1`. 1.65.0은 release-age에 막혀 있으므로 고정 버전을 쓴다(사전 확인). 브라우저 내려받기에 실패하면 이 Task를 멈추고 실행 기록에 남긴다.

- [ ] **Step 2: 서버 스크립트와 설정**

`e2e/serve.ts`:

```ts
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startUiServer } from "@specmock/ui-server";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "e2e", ".tmp");
await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
const ui = await startUiServer({ root: ROOT, port: 4517, claudeCommand: path.join(REPO, "packages", "core", "test", "bin", "claude") });
process.stdout.write(`ready ${ui.url}\n`);
process.once("SIGTERM", () => void ui.close().then(() => process.exit(0)));
```

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4517", browserName: "chromium" },
  webServer: { command: "node --import tsx e2e/serve.ts", url: "http://127.0.0.1:4517/api/env", reuseExistingServer: false, timeout: 60_000 },
});
```

webServer의 상태 확인 요청은 Host가 `127.0.0.1:4517`이므로 Host 검사를 통과한다.

루트 `package.json` scripts에 `"test:e2e": "pnpm build && playwright test"`를 더한다. `pnpm test`(vitest)는 `e2e/`를 줍지 않는다. 확장자가 `.spec.ts`이고 include가 `packages/*/test` 아래만 보기 때문이다.

- [ ] **Step 3: E2E 시나리오** `e2e/ui.spec.ts`

```ts
import { cp, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// 루트 package.json이 "type": "module"이라 __dirname이 없다.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "e2e", ".tmp");

test("OpenAPI: 등록 → 분석 → 선택 → 생성 → 검증을 화면만으로", async ({ page }) => {
  await page.goto("/new");
  await page.getByLabel("파일 경로 또는 URL").fill(path.join(REPO, "examples", "petstore", "petstore.yaml"));
  await expect(page.getByLabel("시스템 이름")).toHaveValue("petstore");
  await page.getByRole("button", { name: "등록" }).click();
  await expect(page.getByText("형식: OpenAPI")).toBeVisible();
  await page.getByRole("button", { name: "분석하기" }).click();
  await expect(page).toHaveURL(/\/systems\/petstore\/select$/);
  await page.getByRole("checkbox", { name: /^pets/ }).first().click();          // 그룹 하나 전체 선택
  await expect(page.getByText(/\d+개 선택 · mock 생성 →/)).toBeVisible();
  await page.waitForResponse((r) => r.url().endsWith("/selection") && r.request().method() === "POST");
  await page.getByRole("button", { name: /mock 생성 →/ }).click();
  await expect(page.getByLabel("출력 디렉터리")).toHaveValue(path.join(ROOT, "mock", "petstore"));
  await page.getByRole("button", { name: "생성" }).click();
  await expect(page.getByText("npm install")).toBeVisible();
  // npm install을 건너뛰도록 루트 node_modules를 링크한다(2A 테스트와 같은 방식).
  await symlink(path.join(REPO, "node_modules"), path.join(ROOT, "mock", "petstore", "node_modules"), "dir");
  await page.getByRole("button", { name: "⑤ 검증으로 →" }).click();
  await page.getByRole("button", { name: "검증 시작" }).click();
  await expect(page.getByText(/통과 \d+ · 실패 0/)).toBeVisible({ timeout: 90_000 });
});

test("문서: 가짜 claude로 추출 → 카탈로그", async ({ page }) => {
  const sample = path.join(ROOT, "docs-sample");
  await cp(path.join(REPO, "examples", "docs-sample"), sample, { recursive: true });
  await page.goto("/new");
  await page.getByLabel("파일 경로 또는 URL").fill(path.join(sample, "pets-api.md"));
  await page.getByRole("button", { name: "등록" }).click();
  await page.getByRole("button", { name: "분석하기" }).click();
  await page.getByRole("button", { name: "추출 시작" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "추출 시작" }).click();
  await expect(page).toHaveURL(/\/systems\/pets-api\/select$/, { timeout: 60_000 });
  await expect(page.getByText("/pets/")).toBeVisible();
});
```

- 문서 예제의 시스템 이름 제안은 basename 규칙에 따라 `pets-api`가 된다.
- 체크박스 접근 이름, 라벨 문구, 버튼 이름은 Task 7~9 구현의 실제 값에 맞춘다.
- 생성 결과에 `node_modules`가 이미 있는 경우는 생각하지 않는다. `e2e/.tmp`는 서버가 뜰 때마다 비운다.
- 가짜 `claude`가 프롬프트의 `GET /pets/{petId}`에 응답한다는 것은 사전 확인된 동작이다(`packages/core/test/bin/claude`).
- 추출 결과에 `incomplete`가 있으면 `/select`로 가지 않으므로 이 테스트가 실패한다. 이것이 의도한 확인이다.

```bash
pnpm test:e2e
```

기대 결과: 2 passed. 실패하면 `playwright test --trace on`의 trace로 원인을 찾는다. 같은 명령을 최대 3회 다시 돌려 흔들림(flaky)인지 본다.

- [ ] **Step 4: 문서**
- `README.md`
  - "Web UI" 절을 만든다. `specmock ui [--port N] [--no-open]`, 127.0.0.1 전용, 대화에서 `open_ui`, 화면에서 한 선택이 CLI·대화와 같은 `.specmock`에 저장된다는 점을 쓴다. 문서 추출은 `claude` CLI가 있을 때 화면에서, 없으면 대화로 한다.
  - MCP 도구 표에 `open_ui`를 더해 11개로 만든다. 개발 절에는 `pnpm test:e2e`(처음 한 번 `pnpm exec playwright install chromium`)를 쓴다.
  - 스크린샷은 넣지 않는다(범위 밖).
- `docs/architecture.md`
  - 패키지 관계 Mermaid에 `web`, `ui-server`를 더한다. 관계는 `cli → ui-server → core`, `mcp → ui-server`, `ui-server ⇢ web/dist (실행 중 읽기)`, `web ⇢ ui-server (타입만)`이다.
  - 데이터 흐름에 "화면 ↔ HTTP/SSE ↔ ui-server ↔ core ↔ .specmock(파일 잠금)"과 감시 이벤트를 더한다.
  - Mermaid 파싱 검증은 2A와 같은 방식으로 한다(`docs/architecture.md`에 쓰인 검증 방법 또는 2A 실행 기록을 따른다).
- `docs/superpowers/specs/2026-11-04-specmock-design.md`
  - §10 로드맵의 2B를 완료로 바꾼다.
  - 527행 부근의 도구 수·목록에 `open_ui`를 더한다.

```bash
pnpm test && pnpm typecheck && pnpm test:e2e
git status --short   # e2e/.tmp, mock/, dist/가 보이지 않아야 한다
git add playwright.config.ts e2e/serve.ts e2e/ui.spec.ts package.json pnpm-lock.yaml .gitignore tsconfig.scripts.json README.md docs
git commit -m "test(e2e): 화면 E2E(OpenAPI 전 과정, 가짜 claude 문서 추출) + 문서 갱신"
```

---

## 완료 기준 (설계 §7과 대응)

1. 새 clone에서 `pnpm install && pnpm build && pnpm test`가 통과한다. 확인: 임시 디렉터리에 `git clone`한 뒤 그대로 실행한다. E2E는 별도인 `pnpm test:e2e`다.
2. `specmock ui`로 OpenAPI 예제를 등록부터 검증까지 화면만으로 끝낸다. 확인: E2E 첫 시나리오와 손으로 한 번.
3. 대화에서 `open_ui`로 화면을 열고, 대화 중 제출한 추출 결과가 화면에 바로 반영된다. 확인: 감시 → SSE 테스트(Task 5), ② 화면의 `workspace-changed` 처리 테스트(Task 7), 손으로 한 번.
4. 화면 서버와 MCP 서버가 같은 작업 공간에 동시에 써도 데이터가 손상되지 않는다. 확인: Task 1의 자식 프로세스 6개 동시 submit, select·generate 잠금.
5. 화면이 §3.3 토큰과 기준 시안의 모양을 따른다. 확인: `tokens.css`와 설계 표를 대조하고, 기준 시안과 실제 화면을 나란히 놓고 본다(결정 11의 차이만 허용).
6. 저장소에 개발자 개인 도구의 흔적이 없다. 확인: 2A의 검사 테스트가 통과하고, 새 파일도 그 검사 범위 안에 있다.

---

## 실행 기록

| Task | 계획 대비 변경 | 리뷰 결과 | 후속 과제 |
|---|---|---|---|
| 1 core 동시성 | 출발점 40 files / 309 tests(계획의 308과 1 차이). 기존 `service.test.ts:139`가 알 수 없는 그룹의 예외를 기대해 "수정 없이 통과" 가정이 틀렸고, 새 동작(빈 rows)에 맞게 그 한 줄을 고침. 반복 5회 모두 통과 | | |
| 2 취소 신호 | 리뷰 FAIL 수정: 취소 시 프로세스 그룹 SIGKILL(detached), npm install 완료 마커(`node_modules/.specmock-installed`), 취소 경합 처리. 499 판정은 오류 이름 대신 ui-server의 `signal.aborted`로 확정(Task 5에서 반영) | | |
| 3 ui-server 골격 | A3 확인: `serve` 콜백 인자(`info.port`)와 `error` 이벤트(EADDRINUSE)가 계획대로 동작해 `createServer` 대체 불필요. 499는 `ContentfulStatusCode`에 없어 `app.onError`에서 캐스트(계획이 예고한 위치). `toApiError` 반환 타입에 405를 추가하고 405 가드는 `security.ts`의 `methodGuard`로 분리(`GET·HEAD·POST` 외 전부 405). 루트 `test`는 `pnpm build && vitest run`(소요 약 42초). 루트 devDependencies에 이미 있던 hono·node-server는 그대로 둠. 테스트 45 files / 359 tests | | |
| 4 API | 리뷰 FAIL 수정(별도 커밋): 등록 입력의 errno(ENOENT·EISDIR·ENOTDIR·EACCES)와 URL `요청 실패`는 400 invalid(`ingestInputError`), 없는 기능 id 상세는 404(`NotFound`), 상대 origin은 root 기준 절대 경로로 저장, 빈 `?group=`은 필터 없음, 작업 공간 파일 손상(`형식 오류`·`JSON 파싱 실패`)은 500 | | |
| 5 작업·SSE·감시 | A4 확인: `app.request`로 받은 SSE body를 조각 단위로 읽을 수 있음(소켓 불필요). `stream.aborted`·`onAbort` 이름은 hono 4.13 그대로. 계획과 다른 점: 작업 시작 라우트가 먼저 `assertRegistered`로 없는 시스템을 404로 막음(비동기 실패 방지), 본문 없는 POST 허용, `outDir`·`dir` 상대 경로는 root 기준, `EventBus.size` 추가, `createApp`에 `unref` 옵션, `fs.watch`는 macOS가 보내는 감시 루트 자신의 이벤트(`.specmock`)를 무시, 취소 시 `job-failed` 이벤트(state=cancelled) 발행 | | |
| 6 web 골격 | | | |
| 7 ① 등록 ② 분석 | 계획과 다른 점: App이 `env`·`jobs`(SSE job 이벤트와 `/api/jobs`로 갱신)를 들고 있고 분석 화면은 props로 받음. 등록은 결과 문구를 세팅한 직후 바로 ②로 이동(형식은 ②에도 표시). 끝난 작업은 이 화면이 running을 본 경우에만 ③으로 이동. `workspace-changed`는 `tick`으로 개요·청크 재조회. 추가 파일 `name.ts`·`format.ts` | | |
| 8 ③ 기능 선택 | | | |
| 9 ④ 생성 ⑤ 검증 | | | |
| 10 진입점 | | | |
| 11 E2E·문서 | | | |
| 최종 | | | |

---

## 후속 과제

- README 스크린샷: 스타일을 확정한 뒤 사용자가 찍는다.
- Windows 실측: 브라우저 열기 명령은 `cmd /c start`로 분기만 했고, 실제 환경에서는 확인하지 않았다. `fs.watch` recursive도 Windows에서는 따로 봐야 한다.
- 잠금 대기 화면 피드백: 현재는 15초를 넘기면 409 busy로 끝난다. 잠금을 기다리는 동안 "다른 곳에서 작업 중" 진행 표시를 줄지 검토한다.
- 3단계: 실행 중인 mock 서버 조작·요청 콘솔은 이 계획 밖이다. ui-server의 작업 관리(`JobManager`)와 SSE를 재사용할 수 있다.
- jsdom 30+로 올리기: Node 엔진 하한을 `^22.22.2`로 올릴 때 함께 한다.
- 2A 후속 과제 중 이 계획에서 뺀 나머지(프롬프트 재전송 비용 등)는 2A 계획의 후속 과제 절을 그대로 이어 간다.
