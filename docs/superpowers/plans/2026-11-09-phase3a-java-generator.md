# 3A Java 생성기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `specmock generate <system> --lang java`로 Petstore 같은 MockSpec에서 Java(Maven + Javalin) mock 서버를 만들고, 기존 `verify`가 런타임 계약(501·404 포함)까지 확인해 통과시킨다. 생성은 LLM이 하고(claude-code 루프 또는 세션 모드), 결과는 임시 디렉터리에서 검증한 뒤에만 반영한다.

**Architecture:**
- core `generate/`: `renderTsHono` 한 함수를 **언어 무관 골격**(`scaffold.ts`: fixtures·contracts·orphan·lock)과 **언어 생성기**(`LanguageGenerator`)로 나눈다. TS는 `TsHonoGenerator`(기존 eta 템플릿, 바이트 불변), Java는 `LlmGenerator(javaProfile)`. 언어는 `--lang` > lock.language > `ts` 순으로 정한다.
- LLM 생성: `generate/request.ts`가 지시서(`generate-request.json`, 프롬프트 8항목, zod → JSON Schema 출력 스키마)를 만들고, `generate/validateOutput.ts`가 응답 경로·개수·보호 경로를 검사한다. `LlmGenerator`는 임시 디렉터리에서 install → start → contract → 런타임 계약을 돌려 통과할 때까지 최대 `maxAttempts`번 재시도한다. 세션 모드는 같은 지시서를 쓰고 멈추며, `finalizeGeneration`이 대화 속 Claude가 쓴 파일을 확정한다.
- verify: install 단계를 lock에서 읽고(옛 lock은 npm install), 설치 마커를 outDir 루트로 옮기며, 계약 7(501)·8(404)을 별도 `runtime` 결과로 검사한다. 노출(CLI·MCP·ui-server·web·스킬)은 core 함수의 얇은 래퍼로 둔다.

**Tech Stack:** 기존 스택(Node ≥22.19, pnpm 12.9.1, TypeScript ^5.9.3, zod ^4.6.7, eta ^4.6, vitest ^5.1.0, ajv ^8.20.0)에 생성되는 mock 쪽 Java 스택이 더해진다. Node 쪽 새 npm 의존성은 없다.
- 생성되는 Java mock: JDK 17, Maven Wrapper 3.3.4(only-script) + Apache Maven 3.9.16, Javalin 6.7.0, jackson-databind 2.19.4, networknt json-schema-validator 1.5.9, slf4j-simple 2.0.20, maven-compiler-plugin 3.15.0, maven-shade-plugin 3.6.2.

**Spec:** docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md
**Branch:** feat/phase3a-java-generator (main에서 분기)

---

**사전 확인된 사실 (2026-11-09, 이 기기 macOS / Darwin 25.6, main 0b28529):**

빌드·테스트 명령:
- 루트 `package.json` 스크립트: `test: pnpm build && vitest run`, `typecheck: pnpm --filter "@specmock/ui-server..." build && pnpm -r typecheck && tsc -p tsconfig.scripts.json`, `llm:check: pnpm -s build:core && tsx scripts/live-llm-check.ts`, `build:core: pnpm --filter @specmock/core build`.
- 루트 `vitest.config.ts`: `testTimeout/hookTimeout 60_000`, 프로젝트 `node`(`packages/*/test/**/*.test.ts`, web 제외)와 `packages/web/vite.config.ts`.
- core의 `test`는 `vitest run --root ../.. packages/core`라서 `pnpm -F @specmock/core test -- generate`는 필터가 `packages/core` OR `generate`가 되어 core 전부를 돈다. **이 계획은 파일 하나를 돌릴 때 루트에서 `pnpm vitest run <파일 경로>`를 쓴다**(2B 계획과 같은 방식). core 테스트는 `src`를 직접 import하므로 빌드가 필요 없다. CLI·MCP·web 테스트는 빌드된 core(`dist`)를 쓰므로 `pnpm build` 뒤에 돈다.
- core `package.json`의 `files`는 `["dist", "templates"]`. 템플릿은 `import.meta.url` 기준으로 읽는다(`generate/tsHono.ts:9`). 그래서 런타임에 읽는 Java 정적 파일·참조 발췌는 **`packages/core/templates/java/` 아래**에 있어야 한다(`test/fixtures`는 배포되지 않는다).

생성기 현재 모양:
- `renderTsHono(spec, outDir, opts)`(`generate/tsHono.ts:86-188`)가 언어 종속 파일(:124-133: 고정 7개 + `src/routes/<group>.ts` + 라우트 정리)과 언어 무관 파일(:135-175: 기능마다 fixture → `contracts/<id>.json` 순서로 섞어 쓰기, contracts 정리, 고아 fixture)을 쓰고 lock(:177-186, `language:"ts"`, `start: npx tsx src/server.ts`)을 쓴다.
- `GenerateReport`(`tsHono.ts:11-19`)는 `{ outDir, written, preserved, orphaned }`. `core/src/index.ts:25`와 `service/run.ts:5`가 `./generate/tsHono.js`에서 이 타입을 import한다.
- `generate()`(`generate/index.ts:26-38`)는 `withSystemLock` 안에서 mockspec 읽기 → `assertSafeOutDir`(lock 없는 비어 있지 않은 디렉터리 거부) → `renderTsHono` → `generate.json` 기록.
- `LockSchema`(`generate/lock.ts:7-15`)의 `language`는 `z.enum(["ts"])`. `mockspecHash`는 기록만 하고 아무도 읽지 않는다. `writeLock`은 parse한 뒤 쓴다.
- **TS 출력 바이트 스냅샷 테스트는 없다.** golden 테스트는 카탈로그만 덮는다. 기존 generate 테스트는 파일 목록·보존·tsc 통과만 본다 → Task 1에서 스냅샷을 먼저 만든다.
- `mockspec.language`: `types.ts:128`(`z.enum(["ts"])`), `select/index.ts:13`(옵션), `:99`(`language: opts.language ?? "ts"`). 테스트 `coverage.test.ts:9`, `generate.test.ts:82`, `types.test.ts:40`이 이 필드를 넣는다.

verify 현재 모양:
- `ensureInstalled(dir, { onLog, signal })`(`verify/server.ts:70-93`)는 `npm install --no-audit --no-fund --loglevel=error`를 하드코딩하고 stdout을 버린다(`stdio: ["ignore","ignore","pipe"]`). 마커는 `node_modules/.specmock-installed`(:45, :58, :87). 설치 타임아웃은 없다.
- `startMock`(:105-140)은 `opts.timeoutMs ?? 30_000`.
- `verify(mockDir, opts)`(`verify/index.ts:82-99`)는 lock과 `contracts/*.json`만 읽는다. **mockspec을 모르므로 계약 7(501)을 하려면 `notMocked` 목록을 옵션으로 받아야 한다.** `verifyMock`(`service/verify.ts:24-31`)은 verify 뒤에 mockspec을 읽는다.
- `VerifyResult.total`은 contract 수다. 테스트가 `total).toBe(1)`(`e2e.test.ts`, getPet만 선택)과 `toBeGreaterThanOrEqual(6)`을 단정하므로 런타임 계약은 `total`에 섞지 않는다.
- verify 실패 → 종료 코드 2를 정하는 곳: `cli/src/commands/verify.ts:23`, `cli/src/commands/run.ts:51`. MCP `verify_mock`(`mcp/src/tools/mock.ts:83-98`)은 `failed`를 그대로 돌려준다.
- `core/test/cancel.test.ts:112-113`이 취소 뒤 `node_modules/.specmock-installed`가 없음을 단정한다. 마커를 옮기면 이 단정도 옮겨야 한다.

LLM 어댑터:
- `LlmAdapter { name; extract(req: ExtractRequest) }`(`llm/adapter.ts`), `ExtractRequest { prompt, schema, signal? }`.
- `ClaudeCodeAdapter.extract`(`llm/claudeCode.ts:32-85`)의 시간 제한은 `this.opts.timeoutMs ?? 180_000`(:39). 요청별 주입 수단이 없다.
- `extract` 호출부: `core/src/analyze/extract.ts:58`, `scripts/live-llm-check.ts:9`, 테스트 `core/test/llm.test.ts`(여러 곳), `core/test/service.test.ts:79,191,200`(가짜 어댑터 객체의 `extract` 메서드).
- JSON Schema 변환 관례: `types.ts:186-190`의 `extractionJsonSchema()`가 `z.toJSONSchema(schema, { io: "input", target: "draft-7" })` 뒤 `$schema`를 지운다.
- 가짜 claude: `core/test/bin/claude`(프롬프트 내용으로 분기해 고정 봉투 출력), 그 밖에 `claude-fail`·`claude-slow`·`claude-iserror` 등. 가짜 npm은 `core/test/bin/npm-tree`를 임시 `fakeBin/npm`으로 복사하고 `PATH` 앞에 붙인다(`cancel.test.ts`의 `withEnv`).

하드코딩된 실행 안내 `npm install && npm start`:
- `cli/src/commands/generate.ts:18`, `cli/src/commands/run.ts:41`, `mcp/src/tools/mock.ts:68`(결과 문구), `mcp/src/tools/mock.ts:73`(verify_mock 설명의 "npm install을 먼저 실행"), **`web/src/screens/Generate.tsx:76`**(설계 문서에 빠짐), `plugin/skills/specmock/SKILL.md:116`. 테스트 `web/test/Generate.test.tsx:90`이 `cd /r/mock/petstore && npm install && npm start`를 단정한다.

MCP·스킬:
- 도구 11개(`mcp/src/names.ts`의 `TOOL_NAMES`). 개수는 `mcp/test/tools.test.ts:20,23,205,211`과 SKILL.md "도구 11개"(:12)에 있다.
- `mcp/test/plugin.test.ts:24`가 SKILL.md·`references/extraction.md`의 백틱 토큰 중 `/`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock|ui))`/`에 맞는 것을 등록 도구와 양방향 비교한다. `finalize_generation`을 넣으려면 접미사에 `generation`을 추가해야 한다.
- `cli/test/plugin.test.ts:50-67`은 스킬 문서의 `specmock <cmd> … --opt`가 그 명령의 `--help`에 있는지 단방향으로 확인한다.
- `submit_extraction`(`mcp/src/tools/analysis.ts`)의 거부 관례: 예외가 아니라 `{ ok:false, reason, errors }`를 `ok(text, data)`로 돌려준다.

ui-server·web:
- `POST /api/systems/:s/generate`(`ui-server/src/app.ts:110-116`)는 `jobs.start(system, "generate", () => generate(ws, system, { outDir, force: b.force }), { outDir })`.
- `ui-server/src/jobs.ts:20` `CANCELLABLE = { extract: true, verify: true, generate: false }`. `jobs.test.ts:92`가 generate 취소 불가를 단정한다.
- `web/src/screens/Generate.tsx`는 지역 `GenerateReport` 인터페이스(:11)와 `api.generate(system, dir, force)`를 쓴다. `web/test/Generate.test.tsx`가 요청 본문 `{ outDir: "/tmp/out", force: false }`를 단정한다.

Java 환경 (2026-11-09 확인):
- 이 기기: OpenJDK 17.0.17, `mvn` 없음, Maven Central 접근 가능.
- Maven Central 최신: maven-wrapper 3.3.4, apache-maven 3.9.16, Javalin 6.7.0(6.x 최신), json-schema-validator 1.5.9, maven-shade-plugin 3.6.2, maven-compiler-plugin 3.15.0, jackson-databind 2.19.4, slf4j-simple 2.0.20.
- `org/apache/maven/wrapper/maven-wrapper-distribution/3.3.4/maven-wrapper-distribution-3.3.4-only-script.zip`을 풀면 `mvnw`(11790 B, sha256 `cae96cef89ebea3531221f4ae17c23cf8edf67d00eae8306d4186ae1bbed4d02`)와 `mvnw.cmd`(8481 B, sha256 `46eedb8419bd14fe70d5bb2916d7b6f51806e51b39d5b76a42610384ca929c1c`)가 나온다. 둘 다 텍스트라 그대로 커밋한다.
- 로컬 워크트리의 `node_modules`는 불완전해(예: `@mozilla/readability` 없음) tsx로 파이프라인을 직접 돌릴 수 없었다. 실행 전 `pnpm install`이 필요하다.

**설계 문서 대비 결정 사항:**

1. **MCP 도구는 12개다(설계 §4.2의 "11 → 13"은 오기).** 추가되는 도구는 `finalize_generation` 하나이고 `list_languages`는 두지 않는다고 같은 절에 적혀 있다. Task 18에서 설계 문서도 고친다.
2. **실행 안내 조합 함수는 `launchCommand(lock)`·`launchHint(outDir, lock)`(`generate/lock.ts`).** TS(`language === "ts"`)는 지금 문구 `npm install && npm start`를 그대로 돌려준다(package.json의 start 스크립트가 있으므로). 그 밖의 언어는 lock의 install·start argv를 이어 붙인다. `GenerateReport.launch`에 완성된 문구(`cd <outDir> && …`)를 실어 web이 그대로 보여 준다. 교체 대상은 5곳(설계가 놓친 `web/src/screens/Generate.tsx:76` 포함)과 SKILL.md.
3. **런타임 계약 결과는 `VerifyResult.runtime: RuntimeCheck[]`와 `runtimeFailed`로 따로 둔다.** `total/passed/failed`는 contract만 센다(기존 단정 유지). 계약 7은 `VerifyOptions.runtime.notMocked`를 받을 때만 돈다(`verifyMock`과 `LlmGenerator`가 넘긴다). 계약 8은 항상 돈다. 종료 코드는 core의 `verifyFailed(result)`(`failed > 0 || runtimeFailed > 0`)로 정한다.
4. **계약 7의 대상 고르기:** `notMocked`를 순서대로 보며 경로의 `{x}`를 `1`로 채운 요청이 **같은 method의 선택된 기능 경로 패턴과 겹치지 않는** 첫 항목을 쓴다(예: `GET /pets/{petId}`만 선택하고 `GET /pets/mine`이 notMocked면 라우터가 200을 낼 수 있다). 고를 항목이 없으면 `skipped: true`로 기록한다. 계약 8은 `GET /__specmock/unknown-<8자 hex>`에 404와 바디 `error === "unknown_path"`만 본다.
5. **설치 마커는 outDir 루트 `.specmock-installed`이고 내용은 설치 키**(`hashJson({ install, files })`, files는 lock.sourceFiles에 있는 파일의 **현재** 해시)다. 키가 다르면 다시 설치한다. 이유: Java의 install은 빌드(`package`)라서 소스가 바뀌면(증분 재생성·사용자 수정) `target/mock.jar`가 낡는다. 옛 TS mock은 마커가 없으므로 한 번 다시 설치한다(npm은 이미 있는 패키지를 확인만 해 빠르다).
6. **lock 필드:** 설계 §2.4에 `installTimeoutMs`(선택, 기본 600_000)를 더한다(프로필의 설치 타임아웃을 verify가 lock만 보고 알 수 있게). `install`은 `optional().nullable()` — 없음(undefined) = 옛 lock = npm install, `null` = 설치 단계 없음. `generator`는 기본 `"template"`, `sourceFiles`는 기본 `{}`. `language`는 설계대로 열린 문자열이고, 허용 여부는 사용자 입력 단계에서 프로필 등록표로 검사한다.
7. **테스트용 `fake` 프로필은 core 소스에 등록하지 않는다.** `core/test/fakeProfile.ts`에 두고 `generate(…, { profile })`(내부용 옵션)로 주입한다. lock의 `language`가 열린 문자열이라 `"fake"`를 그대로 기록할 수 있다.
8. **Java 참조 발췌(프롬프트 6항목)는 `packages/core/templates/java/reference/`에 둔다.** 설계 §5는 "`test/fixtures/java-petstore/`에서 읽는다"고 했지만 test 디렉터리는 배포되지 않는다. 참조 mock 전문은 `test/fixtures/java-petstore/`에 두고, 발췌 두 파일(`pom.xml`, `Main.java`)이 참조 mock과 같은지 테스트로 묶는다.
9. **세션 모드의 진행 표식 `.specmock-session.json`.** 세션 지시서를 쓸 때 outDir에는 lock 없이 mvnw 등이 생기므로, 다시 `generate --llm session`을 부르면 `assertSafeOutDir`가 거부한다. 지시서 작성 시 outDir에 `{ system, mockspecHash }`를 쓰고, `assertSafeOutDir`는 lock 또는 이 파일이 있으면 통과시킨다. 지시서에는 보호 경로 파일의 해시 `protectedHashes`를 함께 기록해 finalize가 변경을 판정한다.
10. **응답에서 빠진 기존 소스는 유지한다.** 설계는 "출력은 전체 파일 집합"을 규칙으로 요청한다. 모델이 기존 파일을 빠뜨리면 지우지 않고 sourceFiles에 남기며 notes에 "응답에 없어 유지: <경로>"를 더한다. 삭제는 `content: null`로만 한다.
11. **TS 생성기의 라우트 정리는 `LanguageOutput.prune`(`{ dir, ext }[]`)로 옮긴다.** 설계의 `LanguageOutput`에 없는 선택 필드다. 쓰지 않은 `src/routes/*.ts`를 지우는 지금 동작을 그대로 유지하려고 둔다.
12. **세션 지시서 함수는 `generate`와 분리한다:** `prepareGeneration(ws, system, opts)`(지시서 작성, `{ mode:"session", requestPath, outDir, nextSteps }`)과 `finalizeGeneration(ws, system, opts)`. `generate`는 항상 `GenerateReport`를 돌려준다.

**열린 가정 (실행 중 확인):**

- A1 (Task 14): Javalin 6.7의 `Javalin#addHttpHandler(HandlerType, String, Handler)`와 `app.error(404, …)`가 미매치 경로에 호출된다. 안 되면 `Javalin.create(config -> config.router.mount(r -> r.addHttpHandler(...)))`로 옮긴다.
- A2 (Task 14): networknt 1.5.9의 `JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V7).getSchema(String)`가 OpenAPI 유래 스키마의 모르는 `format`(`int64` 등)을 오류 없이 무시한다. 오류가 나면 `SchemaValidatorsConfig.builder().formatAssertionsEnabled(false).build()`를 두 번째 인자로 넘긴다.
- A3 (Task 13, Step 1에서 해소): mvnw 3.3.4 only-script는 `.zip` 배포본을 `unzip`으로 푼다. macOS·Linux 기본 환경에 `unzip`이 있다.
- A4 (Task 9): 가짜 claude가 `structured_output`에 수 KB 파일 내용을 담아도 `ClaudeCodeAdapter`의 파서가 그대로 읽는다(현재 파서는 크기 제한이 없다).

**지켜야 할 제약:**

- TS 생성 결과는 바이트 단위로 바뀌지 않는다(`specmock.lock.json` 제외). Task 1의 스냅샷이 기준이다.
- 사용자 입력 오류(모르는 언어, `--force` 없는 언어 변경)는 파이프라인 진입 전에 종료 코드 1로 끝난다.
- 실패한 LLM 시도는 outDir의 기존 내용을 바꾸지 않는다. 반영은 임시 디렉터리 검증을 통과한 뒤에만 한다.
- 새 Node 의존성을 추가하지 않는다. glob 매칭은 작은 자체 함수로 한다(`path.matchesGlob`은 Node 22에서 실험 기능).
- Java·네트워크가 필요한 테스트는 `java -version`이 실패하면 skip하고 이유를 출력한다. 기본 `pnpm test`는 JDK 없는 기기에서도 통과해야 한다.
- 각 Task는 실패 테스트를 먼저 돌려 실패 메시지를 확인한 뒤 구현한다. Task가 끝나면 `pnpm test`와 `pnpm typecheck`를 돌리고 커밋한다.
- 커밋 메시지 본문 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**이 계획에 없는 것:**

- Proxy/녹화, API 키 어댑터(3단계의 다른 두 작업).
- CI 워크플로(저장소에 `.github/`가 없다. 설계 §5).
- Java 외 언어 프로필. 등록표 구조만 열어 둔다.
- Windows 실제 실행 확인(분기 코드와 단위 테스트만. 설계 §7 열린 질문).
- web 화면의 세션 모드(설계 §4.3).
- ui-server에서 java 생성 작업 취소(현재 generate는 취소 불가. 후속 과제로 남긴다).

## 파일 구조

| 파일 | 상태 | 책임 |
|---|---|---|
| `packages/core/src/generate/generator.ts` | Create | `LanguageGenerator`·`GenerateContext`·`LanguageOutput`·`GenerateProgress`·`GenerateReport` 타입 |
| `packages/core/src/generate/scaffold.ts` | Create | 언어 무관 쓰기: 언어 파일 쓰기·정리, fixtures 보존, contracts, 고아 fixture, lock 조립 |
| `packages/core/src/generate/tsHono.ts` | Modify | `TsHonoGenerator`(템플릿 렌더만). 쓰기는 scaffold로 |
| `packages/core/src/generate/index.ts` | Modify | 언어 결정·안전검사·생성기 선택·증분·건너뛰기·`generate.json` |
| `packages/core/src/generate/lock.ts` | Modify | lock 확장, `resolveInstall`, `launchCommand`·`launchHint` |
| `packages/core/src/generate/glob.ts` | Create | `matchGlob(pattern, rel)` |
| `packages/core/src/generate/profiles/types.ts` | Create | `LanguageProfile` |
| `packages/core/src/generate/profiles/java.ts` | Create | Java 프로필 |
| `packages/core/src/generate/profiles/index.ts` | Create | 등록표 `SUPPORTED_LANGUAGES`, `getProfile`, `assertLanguage` |
| `packages/core/src/generate/request.ts` | Create | 지시서·프롬프트 8항목·출력 스키마·재시도 절 |
| `packages/core/src/generate/validateOutput.ts` | Create | 응답 검증(경로 탈출·sourceGlobs·보호 경로·개수) |
| `packages/core/src/generate/llm.ts` | Create | `LlmGenerator`: 시도 루프·임시 검증·환경 오류·attempt 보존 |
| `packages/core/src/generate/session.ts` | Create | `prepareGeneration`·`finalizeGeneration` |
| `packages/core/src/generate/errors.ts` | Create | `GenerationFailedError`(exit 5)·`EnvironmentError` |
| `packages/core/src/verify/server.ts` | Modify | install을 lock에서, 마커 이동·설치 키, 설치·기동 타임아웃 |
| `packages/core/src/verify/runtime.ts` | Create | 계약 7·8 |
| `packages/core/src/verify/index.ts` | Modify | `runtime` 옵션·결과, `verifyFailed` |
| `packages/core/src/verify/coverage.ts` | Modify | "## 런타임 계약" 절, notes 절 |
| `packages/core/src/llm/adapter.ts`·`claudeCode.ts`·`session.ts`·`index.ts` | Modify | `extract` → `complete`, `timeoutMs` |
| `packages/core/src/analyze/extract.ts:58` | Modify | `complete` 호출 |
| `packages/core/src/types.ts:128`, `select/index.ts:13,99` | Modify | `mockspec.language` 제거 |
| `packages/core/src/service/verify.ts`·`run.ts`·`generate.ts`·`index.ts`, `src/index.ts` | Modify/Create | 서비스 노출 |
| `packages/core/templates/java/mvnw`·`mvnw.cmd`·`.mvn/wrapper/maven-wrapper.properties` | Create | Maven Wrapper only-script 정적 파일 |
| `packages/core/templates/java/reference/pom.xml`·`Main.java` | Create | 프롬프트 6항목 참조 발췌 |
| `packages/core/test/fixtures/java-petstore/**` | Create | Petstore Java 참조 mock 전문 |
| `packages/core/test/bin/claude-gen` | Create | 생성용 가짜 claude(차례대로 준비된 응답) |
| `packages/core/test/fakeProfile.ts` | Create | 테스트용 `fake` 프로필과 Node 서버 응답 생성기 |
| `packages/core/test/{snapshot,lock,runtime,request,validateOutput,llmGenerate,session,javaProfile,java}.test.ts` | Create | 새 테스트 |
| `packages/cli/src/commands/{generate,run,verify}.ts`, `cli/src/context.ts` | Modify | 옵션·종료 코드 5·안내 문구 |
| `packages/mcp/src/tools/mock.ts`, `mcp/src/names.ts` | Modify | `generate_mock(language)`, `finalize_generation` |
| `packages/ui-server/src/app.ts` | Modify | body `language`, 진행 이벤트 |
| `packages/web/src/screens/Generate.tsx`, `web/src/api.ts` | Modify | 언어 선택·진행·안내 문구 |
| `plugin/skills/specmock/SKILL.md`, `README.md`, `docs/architecture.md`, 설계 문서 | Modify | 문서 |
| `scripts/live-llm-check.ts` | Modify | Java 케이스 |

---

### Task 0: 브랜치 생성과 설계·계획 문서 커밋

**Files:**
- Create: `docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md`(이미 작성됨, 미추적)
- Create: `docs/superpowers/plans/2026-11-09-phase3a-java-generator.md`(이 문서, 미추적)

- [ ] **Step 1: main이 깨끗한지 확인하고 분기한다**

```bash
git status --short          # 기대: 위 두 문서만 ?? 로 보인다
git switch -c feat/phase3a-java-generator
```

- [ ] **Step 2: 의존성 설치와 기준선 확인**

```bash
pnpm install
pnpm test
```
기대 출력(마지막 줄 근처): `Test Files  NN passed` (실패 0).

- [ ] **Step 3: 두 문서를 커밋한다**

```bash
git add docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md docs/superpowers/plans/2026-11-09-phase3a-java-generator.md
git commit -m "docs: 3A Java 생성기 설계와 구현 계획

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: TS 생성 결과 바이트 스냅샷

리팩터링 전에 지금 TS 출력의 파일별 sha256을 고정한다. lock은 `generatedAt`이 바뀌므로 뺀다.

**Files:**
- Create: `packages/core/test/snapshot.test.ts`
- Create(자동): `packages/core/test/__snapshots__/snapshot.test.ts.snap`

- [ ] **Step 1: 스냅샷 테스트 작성**

```ts
// packages/core/test/snapshot.test.ts
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

/** dir 아래 모든 파일의 상대 경로 → sha256. lock은 generatedAt 때문에 뺀다. */
async function treeHashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(rel: string): Promise<void> {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (r !== "specmock.lock.json") out[r] = createHash("sha256").update(await readFile(path.join(dir, r))).digest("hex");
    }
  }
  await walk("");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-snap-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("TS 생성 결과 바이트 불변", () => {
  it("일부 선택(getPet, createPet, deletePet)", async () => {
    await select(ws, "petstore", ["getPet", "createPet", "deletePet"]);
    const out = path.join(dir, "mock", "petstore");
    await generate(ws, "petstore", { outDir: out });
    expect(await treeHashes(out)).toMatchSnapshot();
  });

  it("전체 선택", async () => {
    await select(ws, "petstore", ["all"]);
    const out = path.join(dir, "mock", "petstore");
    await generate(ws, "petstore", { outDir: out });
    expect(await treeHashes(out)).toMatchSnapshot();
  });
});
```

`ingest`·`analyze`·`select`의 import 경로는 `generate.test.ts` 머리의 import를 그대로 따른다(같은 디렉터리에서 같은 모듈을 쓴다). 다르면 그쪽에 맞춘다.

- [ ] **Step 2: 실행해 스냅샷을 만든다**

```bash
pnpm vitest run packages/core/test/snapshot.test.ts
```
기대: `Snapshots  2 written` 그리고 `2 passed`.

- [ ] **Step 3: 다시 실행해 고정됐는지 확인**

```bash
pnpm vitest run packages/core/test/snapshot.test.ts
```
기대: `2 passed`, `written` 없음.

- [ ] **Step 4: 커밋**

```bash
git add packages/core/test/snapshot.test.ts packages/core/test/__snapshots__/snapshot.test.ts.snap
git commit -m "test(core): TS 생성 결과 파일별 해시 스냅샷

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 언어 생성기 타입, scaffold 분리, TsHonoGenerator

동작은 바꾸지 않는다. `renderTsHono`를 "템플릿 렌더(언어 종속)"와 "쓰기·fixture·contract·lock(언어 무관)"으로 나눈다.

**Files:**
- Create: `packages/core/src/generate/generator.ts`
- Create: `packages/core/src/generate/scaffold.ts`
- Modify: `packages/core/src/generate/tsHono.ts:1-188`(전체 재구성)
- Modify: `packages/core/src/generate/index.ts:1-38`
- Modify: `packages/core/src/index.ts:25`, `packages/core/src/service/run.ts:5`
- Test: `packages/core/test/snapshot.test.ts`(기존 스냅샷), `packages/core/test/generate.test.ts`(기존)

- [ ] **Step 1: 실패 테스트 — TsHonoGenerator가 파일을 쓰지 않고 목록만 돌려준다**

`packages/core/test/generate.test.ts` 끝에 추가:

```ts
import { TsHonoGenerator } from "../src/generate/tsHono.js";
import { MockSpecSchema } from "../src/types.js";

describe("TsHonoGenerator", () => {
  it("언어 종속 파일만 돌려주고 디스크에 쓰지 않는다", async () => {
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const output = await new TsHonoGenerator().generate({ spec, outDir: out, existing: null });
    expect(output.files.map((f) => f.path)).toEqual([
      "package.json", "tsconfig.json", "README.md", "src/server.ts", "src/notMocked.ts", "src/fixtures.ts", "src/validate.ts", "src/routes/pets.ts",
    ]);
    expect(output.start).toEqual({ command: "npx", args: ["tsx", "src/server.ts"] });
    expect(output.healthPath).toBe("/__specmock/health");
    expect(output.prune).toEqual([{ dir: "src/routes", ext: ".ts" }]);
    expect(await exists(out)).toBe(false);
  });
});
```

(`ws`, `out`, `exists`는 이 파일의 기존 `beforeEach`·헬퍼다. beforeEach가 getPet·createPet·deletePet을 선택하므로 그룹은 `pets` 하나다.)

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/generate.test.ts -t TsHonoGenerator
```
기대: `SyntaxError: The requested module '../src/generate/tsHono.js' does not provide an export named 'TsHonoGenerator'` 계열로 실패.

- [ ] **Step 3: 타입 파일 작성**

```ts
// packages/core/src/generate/generator.ts
import type { MockSpec } from "../types.js";

export interface Command { command: string; args: string[] }

/** 증분 생성 입력: 기존 언어 종속 파일과 사용자 수정 여부. */
export interface ExistingSources {
  files: { path: string; content: string; userModified: boolean }[];
}

/** 진행 단계. ui-server가 SSE로, CLI가 stderr로 흘린다. */
export interface GenerateProgress {
  stage: "generating" | "building" | "verifying";
  attempt: number;
  maxAttempts: number;
  message: string;
}

export interface GenerateContext {
  spec: MockSpec;
  outDir: string;
  existing: ExistingSources | null;
  signal?: AbortSignal;
  onProgress?: (e: GenerateProgress) => void;
}

export interface LanguageOutput {
  /** 언어 종속 파일만. outDir 상대 경로. content가 null이면 삭제(LLM 증분). */
  files: { path: string; content: string | null }[];
  install: Command | null;
  start: Command;
  healthPath: string;
  startTimeoutMs?: number;
  installTimeoutMs?: number;
  /** 모델의 가정·경고 → coverage.md. 템플릿 생성기는 빈 배열. */
  notes: string[];
  /** 이 디렉터리에서 이번에 쓰지 않은 `ext` 파일을 지운다(TS의 src/routes). */
  prune?: { dir: string; ext: string }[];
  /** LLM 생성기의 시도 횟수. 템플릿은 0. */
  attempts?: number;
}

export interface LanguageGenerator {
  readonly language: string;
  readonly generator: "llm" | "template";
  generate(ctx: GenerateContext): Promise<LanguageOutput>;
}

export interface GenerateReport {
  outDir: string;
  language: string;
  /** 이번 실행에서 쓴 파일 (outDir 기준 상대 경로). */
  written: string[];
  /** 사용자가 수정해 덮어쓰지 않은 fixture. */
  preserved: string[];
  /** 더 이상 선택되지 않은 기능의 fixture 중 사용자가 수정해 남겨둔 것. */
  orphaned: string[];
  /** 실행 안내: `cd <outDir> && <install> && <start>`. */
  launch: string;
  attempts: number;
  notes: string[];
  /** 사용자가 고쳤는데 이번 생성이 다시 쓴 언어 종속 파일. */
  userModified: string[];
  /** mockspec이 바뀌지 않아 LLM을 부르지 않았다. */
  skipped: boolean;
}
```

- [ ] **Step 4: scaffold 작성 — tsHono.ts:71-84, :135-175의 쓰기 코드를 그대로 옮긴다**

```ts
// packages/core/src/generate/scaffold.ts
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Contract, MockFeature, MockSpec } from "../types.js";
import { hashText } from "../util/hash.js";
import type { LanguageOutput } from "./generator.js";
import type { Lock } from "./lock.js";

export async function writeOut(outDir: string, rel: string, text: string, written: string[]): Promise<void> {
  const file = path.join(outDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  written.push(rel);
}

/** dir 안에서 stale(name)이 참인 항목을 지운다. dir이 없으면 아무 일도 하지 않는다. */
export async function removeStale(dir: string, stale: (name: string) => boolean): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (stale(name)) await rm(path.join(dir, name), { recursive: true, force: true });
  }
}

export function lowest2xxStatus(f: MockFeature): number {
  return f.fixtures.filter((x) => x.status >= 200 && x.status < 300).map((x) => x.status).sort((a, b) => a - b)[0] ?? 200;
}

/** 언어 종속 파일을 순서대로 쓰고(null은 삭제), prune 규칙으로 생성기 소유 디렉터리를 정리한다. */
export async function writeLanguageFiles(outDir: string, output: LanguageOutput, written: string[]): Promise<void> {
  for (const f of output.files) {
    if (f.content === null) await rm(path.join(outDir, f.path), { force: true });
    else await writeOut(outDir, f.path, f.content, written);
  }
  for (const p of output.prune ?? []) {
    const keep = new Set(output.files.filter((f) => f.content !== null && path.posix.dirname(f.path) === p.dir).map((f) => path.posix.basename(f.path)));
    await removeStale(path.join(outDir, p.dir), (name) => name.endsWith(p.ext) && !keep.has(name));
  }
}

export interface ScaffoldResult {
  fixtureHashes: Record<string, string>;
  preserved: string[];
  orphaned: string[];
}

/** fixtures(보존 규칙)·contracts·고아 fixture. 기존 renderTsHono의 쓰기 순서(기능마다 fixture → contract)를 그대로 지킨다. */
export async function writeScaffold(spec: MockSpec, outDir: string, previous: Lock | null, opts: { force?: boolean }, written: string[]): Promise<ScaffoldResult> {
  const preserved: string[] = [];
  const orphaned: string[] = [];
  // lock의 fixtureHashes에는 "생성기가 썼을 내용"의 해시를 기록한다.
  // 사용자가 수정한 파일을 보존할 때도 생성 텍스트의 해시를 남겨야 다음 재생성에서 다시 수정으로 인식한다.
  // 라우트는 가장 낮은 2xx 하나만 서빙하므로 그 fixture만 파일로 쓴다. 나머지(4xx 등)는 mockspec에만 남아 coverage 집계에 쓰인다.
  const fixtureHashes: Record<string, string> = {};
  for (const f of spec.features) {
    const served = lowest2xxStatus(f);
    for (const fx of f.fixtures) {
      if (fx.status !== served) continue;
      const rel = `fixtures/${f.id}/${fx.status}.json`;
      const text = JSON.stringify(fx.body, null, 2) + "\n";
      const file = path.join(outDir, rel);
      const current = await readFile(file, "utf8").catch(() => null);
      const recorded = previous?.fixtureHashes[rel];
      const userEdited = current !== null && recorded !== undefined && hashText(current) !== recorded;
      fixtureHashes[rel] = hashText(text);
      if (userEdited && !opts.force) {
        preserved.push(rel);
        continue;
      }
      await writeOut(outDir, rel, text, written);
    }
    const contracts: Contract[] = spec.contracts.filter((c) => c.featureId === f.id);
    await writeOut(outDir, `contracts/${f.id}.json`, JSON.stringify(contracts, null, 2) + "\n", written);
  }
  // 선택에서 빠진 기능의 contract를 지운다. verify는 contracts/*.json을 모두 읽으므로 남겨두면 실패한다.
  const featureIds = new Set(spec.features.map((f) => f.id));
  await removeStale(path.join(outDir, "contracts"), (name) => name.endsWith(".json") && !featureIds.has(name.slice(0, -".json".length)));

  // 선택에서 빠진 기능의 fixture: 수정하지 않았으면 지우고, 수정했으면 남겨두고 보고한다.
  for (const [rel, recorded] of Object.entries(previous?.fixtureHashes ?? {})) {
    if (rel in fixtureHashes) continue;
    const file = path.join(outDir, rel);
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === null) continue;
    if (hashText(current) === recorded) {
      await rm(file, { force: true });
      await rmdir(path.dirname(file)).catch(() => undefined); // 비어 있을 때만 지워진다.
    } else {
      orphaned.push(rel);
    }
  }
  return { fixtureHashes, preserved, orphaned };
}
```

- [ ] **Step 5: tsHono.ts를 렌더 전용으로 바꾼다**

`tsHono.ts`에서 `GenerateReport`(:11-19), `writeOut`(:71-76), `removeStale`(:79-84), `lowest2xxStatus`(:47-49), `renderTsHono`(:86-188)를 지우고 아래로 바꾼다. `safeName`·`NameRegistry`·`honoPath`·`paramsSchema`·`validationSchema`는 그대로 둔다.

```ts
// packages/core/src/generate/tsHono.ts 머리 import 교체
import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import type { MockFeature, MockSpec } from "../types.js";
import type { GenerateContext, LanguageGenerator, LanguageOutput } from "./generator.js";
import { lowest2xxStatus } from "./scaffold.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/ts-hono/", import.meta.url));
```

```ts
// packages/core/src/generate/tsHono.ts 끝(기존 renderTsHono 자리)
export const TS_FIXED_FILES = ["package.json", "tsconfig.json", "README.md", "src/server.ts", "src/notMocked.ts", "src/fixtures.ts", "src/validate.ts"];

/** 기존 eta 템플릿으로 TS(Hono) 파일을 렌더한다. 디스크에 쓰지 않는다. */
export function renderTsHonoFiles(spec: MockSpec): { path: string; content: string }[] {
  const eta = new Eta({ views: TEMPLATES, autoEscape: false, autoTrim: false });
  const groupNames = new NameRegistry();
  const featureNames = new NameRegistry();
  const groups = [...new Set(spec.features.map((f) => f.group))].sort().map((name) => ({
    name,
    safe: groupNames.claim(name),
    features: spec.features
      .filter((f) => f.group === name)
      .map((f: MockFeature) => ({
        id: f.id,
        safe: featureNames.claim(f.id),
        title: f.title,
        method: f.method,
        honoPath: honoPath(f.path),
        hasBody: Boolean(f.request.body),
        status: lowest2xxStatus(f),
        validation: validationSchema(f),
      })),
  }));
  const view = {
    system: spec.system,
    featureCount: spec.features.length,
    groups,
    notMocked: spec.notMocked,
    allFeatures: spec.features.map((f) => ({
      id: f.id, method: f.method, path: f.path,
      fixtureSource: f.fixtures.find((x) => x.status === lowest2xxStatus(f))?.source ?? "empty",
    })),
  };
  // Eta는 이름에 확장자가 이미 있으면 .eta를 붙이지 않으므로 명시한다.
  const render = (name: string, data: object = view) => eta.render(`${name}.eta`, data);
  const files = TS_FIXED_FILES.map((name) => ({ path: name, content: render(name) }));
  for (const g of groups) {
    files.push({ path: `src/routes/${g.safe}.ts`, content: render("src/route.ts", { ...view, group: g.name, features: g.features }) });
  }
  return files;
}

export class TsHonoGenerator implements LanguageGenerator {
  readonly language = "ts";
  readonly generator = "template" as const;
  async generate(ctx: GenerateContext): Promise<LanguageOutput> {
    return {
      files: renderTsHonoFiles(ctx.spec),
      install: null,
      start: { command: "npx", args: ["tsx", "src/server.ts"] },
      healthPath: "/__specmock/health",
      notes: [],
      prune: [{ dir: "src/routes", ext: ".ts" }],
      attempts: 0,
    };
  }
}
```

- [ ] **Step 6: generate/index.ts가 생성기 + scaffold를 조합하게 한다**

```ts
// packages/core/src/generate/index.ts 전체
import { readdir } from "node:fs/promises";
import path from "node:path";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { GenerateReport } from "./generator.js";
import { LOCK_FILE, readLock, writeLock } from "./lock.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { TsHonoGenerator } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
}

export function defaultMockDir(system: string): string {
  return path.resolve("mock", system);
}

/** 비어 있지 않고 specmock이 만든 흔적(lock)이 없는 디렉터리는 force 없이 덮어쓰지 않는다. */
async function assertSafeOutDir(outDir: string): Promise<void> {
  const names = await readdir(outDir).catch(() => [] as string[]);
  if (names.length > 0 && !names.includes(LOCK_FILE)) {
    throw new Error(`${outDir}은(는) specmock이 만든 디렉터리가 아닙니다(${LOCK_FILE} 없음). 덮어쓰려면 --force`);
  }
}

export async function generate(ws: Workspace, system: string, opts: GenerateOptions = {}): Promise<GenerateReport> {
  return withSystemLock(ws, system, () => generateUnlocked(ws, system, opts));
}

async function generateUnlocked(ws: Workspace, system: string, opts: GenerateOptions): Promise<GenerateReport> {
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
  if (!opts.force) await assertSafeOutDir(outDir);
  const previous = await readLock(outDir);
  const output = await new TsHonoGenerator().generate({ spec, outDir, existing: null });
  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  await writeLock(outDir, {
    system: spec.system,
    language: "ts",
    mockspecHash: hashJson(spec),
    generatedAt: new Date().toISOString(),
    start: output.start,
    healthPath: output.healthPath,
    fixtureHashes: s.fixtureHashes,
  });
  // verify가 --dir 없이도 마지막 생성 위치를 찾을 수 있도록 기록한다.
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString() });
  return {
    outDir, language: "ts", written, preserved: s.preserved, orphaned: s.orphaned,
    launch: `cd ${outDir} && npm install && npm start`,
    attempts: 0, notes: [], userModified: [], skipped: false,
  };
}
```

- [ ] **Step 7: GenerateReport import 경로를 고친다**

```ts
// packages/core/src/index.ts:25
export type { GenerateReport, GenerateProgress, LanguageOutput } from "./generate/generator.js";
```

```ts
// packages/core/src/service/run.ts:5
import type { GenerateReport } from "../generate/generator.js";
```

`grep -rn "renderTsHono\|generate/tsHono.js" packages/*/src packages/*/test`로 남은 참조를 찾아 같은 방식으로 바꾼다(테스트가 `renderTsHono`를 직접 부르면 `generate()` 호출로 바꾼다).

- [ ] **Step 8: 통과 확인 — 새 테스트, 기존 generate 테스트, 바이트 스냅샷**

```bash
pnpm vitest run packages/core/test/generate.test.ts packages/core/test/snapshot.test.ts packages/core/test/e2e.test.ts
```
기대: 모두 passed, `Snapshots  … passed`(written 0, failed 0).

- [ ] **Step 9: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core
git commit -m "refactor(core): renderTsHono를 scaffold와 TsHonoGenerator로 분리

TS 출력은 바이트 불변(스냅샷). GenerateReport는 generator.ts로 옮기고
language·launch·attempts·notes·userModified·skipped를 더한다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: lock 확장·옛 lock 호환, 언어 결정 순서, mockspec.language 제거

**Files:**
- Modify: `packages/core/src/generate/lock.ts:1-37`(전체)
- Create: `packages/core/src/generate/profiles/index.ts`
- Modify: `packages/core/src/generate/index.ts`(generate 함수 전체)
- Modify: `packages/core/src/generate/tsHono.ts`(`TsHonoGenerator.generate`의 `install`)
- Modify: `packages/core/src/types.ts:128`, `packages/core/src/select/index.ts:13,99`
- Modify: `packages/core/test/coverage.test.ts:9`, `packages/core/test/types.test.ts:40`
- Test: `packages/core/test/lock.test.ts`(새 파일), `packages/core/test/generate.test.ts`

- [ ] **Step 1: 실패 테스트 — lock 호환과 언어 결정**

```ts
// packages/core/test/lock.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { NPM_INSTALL, readLock, resolveInstall } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let ws: Workspace;
let out: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-lock-"));
  ws = new Workspace(path.join(dir, ".specmock"));
  out = path.join(dir, "mock", "petstore");
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const OLD_LOCK = {
  system: "petstore", language: "ts", mockspecHash: "x", generatedAt: "2026-11-01T00:00:00.000Z",
  start: { command: "npx", args: ["tsx", "src/server.ts"] }, healthPath: "/__specmock/health", fixtureHashes: {},
};

describe("lock 호환", () => {
  it("2단계 lock(install·generator·sourceFiles 없음)을 읽고 install을 npm install로 해석한다", async () => {
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "specmock.lock.json"), JSON.stringify(OLD_LOCK));
    const lock = await readLock(out);
    expect(lock).toMatchObject({ generator: "template", sourceFiles: {} });
    expect(lock!.install).toBeUndefined();
    expect(resolveInstall(lock!)).toEqual(NPM_INSTALL);
    expect(resolveInstall({ ...lock!, install: null })).toBeNull();
  });

  it("새 TS lock은 install을 명시하고 generator template을 기록한다", async () => {
    await generate(ws, "petstore", { outDir: out });
    const lock = await readLock(out);
    expect(lock).toMatchObject({ language: "ts", generator: "template", install: NPM_INSTALL, sourceFiles: {} });
  });
});

describe("언어 결정", () => {
  it("모르는 언어는 지원 언어 목록과 함께 거부하고 아무것도 쓰지 않는다", async () => {
    await expect(generate(ws, "petstore", { outDir: out, language: "cobol" })).rejects.toThrow("'cobol' 언어는 지원하지 않습니다. 지원 언어: ts");
    expect(await readLock(out)).toBeNull();
  });

  it("lock의 언어와 다른 언어를 force 없이 요청하면 거부한다", async () => {
    await generate(ws, "petstore", { outDir: out });
    const lockPath = path.join(out, "specmock.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, language: "java" }));
    await expect(generate(ws, "petstore", { outDir: out, language: "ts" })).rejects.toThrow(
      "이 디렉터리는 java로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요",
    );
  });

  it("언어를 주지 않으면 lock의 언어를 쓴다(없으면 ts)", async () => {
    const r = await generate(ws, "petstore", { outDir: out });
    expect(r.language).toBe("ts");
  });

  it("force로 언어를 바꾸면 fixtures·contracts 밖의 파일을 지운다", async () => {
    await generate(ws, "petstore", { outDir: out });
    await writeFile(path.join(out, "stray.txt"), "x");
    const lockPath = path.join(out, "specmock.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, language: "java" }));
    await generate(ws, "petstore", { outDir: out, language: "ts", force: true });
    await expect(readFile(path.join(out, "stray.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLock(out))!.language).toBe("ts");
  });
});

describe("mockspec.language 제거", () => {
  it("select가 language를 쓰지 않고, 옛 mockspec의 language는 버려진다", async () => {
    const raw = JSON.parse(await readFile(path.join(dir, ".specmock", "petstore", "mockspec.json"), "utf8"));
    expect(raw).not.toHaveProperty("language");
    expect(MockSpecSchema.parse({ ...raw, language: "ts" })).not.toHaveProperty("language");
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/lock.test.ts
```
기대: `does not provide an export named 'NPM_INSTALL'`로 파일 전체 실패.

- [ ] **Step 3: lock.ts 전체 교체**

```ts
// packages/core/src/generate/lock.ts
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const LOCK_FILE = "specmock.lock.json";

const CommandSchema = z.object({ command: z.string(), args: z.array(z.string()) });

export const LockSchema = z.object({
  system: z.string(),
  /** 열린 문자열. 허용 여부는 사용자 입력 단계에서 프로필 등록표로 검사한다. */
  language: z.string().min(1),
  generator: z.enum(["llm", "template"]).default("template"),
  mockspecHash: z.string(),
  generatedAt: z.string(),
  /** 없음(undefined) = 2단계 lock = npm install. null = 설치 단계 없음. */
  install: CommandSchema.nullable().optional(),
  start: CommandSchema,
  healthPath: z.string(),
  startTimeoutMs: z.number().int().positive().optional(),
  installTimeoutMs: z.number().int().positive().optional(),
  fixtureHashes: z.record(z.string(), z.string()),
  /** 언어 종속 파일의 생성 시 해시. 증분 생성의 userModified 판정과 설치 키에 쓴다. */
  sourceFiles: z.record(z.string(), z.string()).default({}),
});
export type Lock = z.infer<typeof LockSchema>;
export type LockInput = z.input<typeof LockSchema>;

export const NPM_INSTALL = { command: "npm", args: ["install", "--no-audit", "--no-fund", "--loglevel=error"] };

/** lock의 설치 명령. 옛 lock(install 필드 없음)은 npm install. */
export function resolveInstall(lock: Lock): { command: string; args: string[] } | null {
  return lock.install === undefined ? NPM_INSTALL : lock.install;
}

/** lock 파일을 읽는다. 없으면 null, 있는데 손상됐으면 던진다(조용히 무시하면 보존 판단이 틀어진다). */
export async function readLock(dir: string): Promise<Lock | null> {
  const file = path.join(dir, LOCK_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return LockSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${file}: specmock.lock.json이 손상되었습니다. 파일을 삭제하고 specmock generate <system> --force 로 다시 생성하세요.`);
  }
}

export async function writeLock(dir: string, lock: LockInput): Promise<void> {
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify(LockSchema.parse(lock), null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: 언어 등록표**

```ts
// packages/core/src/generate/profiles/index.ts
/** 사용자에게 허용하는 언어. 각 언어는 실제 기동·검증 테스트가 있어야 등록한다. */
export const SUPPORTED_LANGUAGES: string[] = ["ts"];

export function assertLanguage(language: string): void {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`'${language}' 언어는 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
}
```

- [ ] **Step 5: TS 생성기가 install을 명시한다**

`packages/core/src/generate/tsHono.ts`의 `TsHonoGenerator.generate` 반환값에서:

```ts
      install: NPM_INSTALL,
```

그리고 머리에 `import { NPM_INSTALL } from "./lock.js";`를 더한다.

- [ ] **Step 6: generate/index.ts — 언어 결정·force 정리·lock 필드**

`GenerateOptions`와 `generateUnlocked`를 바꾼다(`defaultMockDir`, `assertSafeOutDir`, `generate`는 그대로).

```ts
import { readdir, rm } from "node:fs/promises";
// …기존 import…
import { assertLanguage } from "./profiles/index.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
  /** 명시 언어. 없으면 lock.language, 그것도 없으면 "ts". */
  language?: string;
}

/** --force로 언어를 바꿀 때: fixtures/·contracts/만 남기고 지운다(fixture 보존 규칙은 lock 해시로 계속 동작). */
async function clearForLanguageChange(outDir: string): Promise<void> {
  for (const name of await readdir(outDir).catch(() => [] as string[])) {
    if (name === "fixtures" || name === "contracts" || name === LOCK_FILE) continue;
    await rm(path.join(outDir, name), { recursive: true, force: true });
  }
}

async function generateUnlocked(ws: Workspace, system: string, opts: GenerateOptions): Promise<GenerateReport> {
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
  if (opts.language !== undefined) assertLanguage(opts.language);
  if (!opts.force) await assertSafeOutDir(outDir);
  const previous = await readLock(outDir);
  const language = opts.language ?? previous?.language ?? "ts";
  if (previous && previous.language !== language) {
    if (!opts.force) throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요`);
    await clearForLanguageChange(outDir);
  }
  const output = await new TsHonoGenerator().generate({ spec, outDir, existing: null });
  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  await writeLock(outDir, {
    system: spec.system,
    language,
    generator: "template",
    mockspecHash: hashJson(spec),
    generatedAt: new Date().toISOString(),
    install: output.install,
    start: output.start,
    healthPath: output.healthPath,
    fixtureHashes: s.fixtureHashes,
    sourceFiles: {},
  });
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString() });
  return {
    outDir, language, written, preserved: s.preserved, orphaned: s.orphaned,
    launch: `cd ${outDir} && npm install && npm start`,
    attempts: 0, notes: [], userModified: [], skipped: false,
  };
}
```

TS 템플릿 생성기의 lock은 `sourceFiles: {}`로 둔다. 이유: TS는 설치가 소스와 무관(npm install)하고 증분 생성도 없다. 그래서 설치 키에 소스 해시를 넣지 않아도 된다.

- [ ] **Step 7: mockspec.language 제거**

```ts
// packages/core/src/types.ts:125-133 MockSpecSchema에서 language 줄 삭제
export const MockSpecSchema = z.object({
  system: z.string().min(1),
  baseUrl: z.string(),
  features: z.array(MockFeatureSchema),
  notMocked: z.array(z.object({ id: z.string(), method: HttpMethod, path: z.string() })),
  contracts: z.array(ContractSchema),
  assumptions: z.array(z.string()),
});
```

`packages/core/src/select/index.ts:13`의 `language?: MockSpec["language"];` 줄을 지우고, `:99`를 아래로 바꾼다.

```ts
    system, baseUrl: "/", features, notMocked, contracts, assumptions,
```

`packages/core/test/coverage.test.ts:9`의 `  language: "ts",` 줄과 `packages/core/test/types.test.ts:40`의 `language: "ts", `를 지운다. `grep -rn 'language' packages/*/src packages/*/test | grep -v lock`으로 다른 쓰임이 없는지 확인한다(`select(..., { language })`를 넘기는 곳이 있으면 인자를 지운다).

- [ ] **Step 8: 통과 확인**

```bash
pnpm vitest run packages/core/test/lock.test.ts packages/core/test/generate.test.ts packages/core/test/snapshot.test.ts packages/core/test/types.test.ts packages/core/test/coverage.test.ts
```
기대: 모두 passed. 스냅샷은 lock을 빼므로 그대로다.

- [ ] **Step 9: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core
git commit -m "feat(core): lock에 install·generator·sourceFiles를 더하고 언어 결정 순서를 둔다

옛 lock은 install 없음 = npm install로 읽는다. --lang > lock.language > ts,
force 없는 언어 변경은 거부한다. mockspec.language는 쓰는 곳이 없어 제거한다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: verify의 install을 lock에서 읽고 마커를 outDir 루트로 옮긴다

**Files:**
- Modify: `packages/core/src/verify/server.ts:12-18`(StartMockOptions), `:45-93`(마커·ensureInstalled), `:105-133`(startMock)
- Modify: `packages/core/src/index.ts:27`
- Modify: `packages/core/test/cancel.test.ts:113`
- Modify: `packages/core/test/e2e.test.ts:29-31`, `packages/core/test/service.test.ts:176`, `packages/mcp/test/tools.test.ts:142-144`
- Test: `packages/core/test/install.test.ts`(새 파일)

배경: 지금 마커는 `node_modules/.specmock-installed`이고, 테스트는 루트 `node_modules`를 symlink로 연결하므로 마커가 루트에 한 번 생기면 모든 테스트가 설치를 건너뛴다. 마커를 outDir 루트로 옮기면 테스트마다 실제 `npm install`이 돈다. 그래서 테스트용으로 `markInstalled(dir, lock)`를 내보내고 symlink 헬퍼에서 부른다.

- [ ] **Step 1: 실패 테스트**

```ts
// packages/core/test/install.test.ts
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockSchema, type Lock } from "../src/generate/lock.js";
import { ensureInstalled, installKey, markInstalled } from "../src/verify/server.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-inst-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** 호출될 때마다 log에 한 줄 쓰는 설치 스크립트. FAIL_OUT이 있으면 stdout에 쓰고 exit 3. */
async function fakeInstaller(): Promise<{ command: string; args: string[]; log: string }> {
  const log = path.join(dir, "install.log");
  const script = path.join(dir, "inst.mjs");
  await writeFile(script, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "run\\n");
if (process.env.FAIL_OUT) { process.stdout.write("[ERROR] COMPILATION ERROR : Main.java:[3,1] ';' expected\\n"); process.exit(3); }
`);
  return { command: process.execPath, args: [script], log };
}

function lockWith(install: Lock["install"], sourceFiles: Record<string, string> = {}): Lock {
  return LockSchema.parse({
    system: "s", language: "fake", mockspecHash: "h", generatedAt: "t", install,
    start: { command: "true", args: [] }, healthPath: "/h", fixtureHashes: {}, sourceFiles,
  });
}

describe("ensureInstalled(lock)", () => {
  it("lock의 install을 실행하고, 같은 설치 키면 다시 실행하지 않는다", async () => {
    const inst = await fakeInstaller();
    const lock = lockWith({ command: inst.command, args: inst.args });
    await ensureInstalled(dir, { lock });
    await ensureInstalled(dir, { lock });
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await readFile(path.join(dir, ".specmock-installed"), "utf8")).toBe(await installKey(dir, lock));
  });

  it("sourceFiles에 있는 파일이 바뀌면 다시 설치한다", async () => {
    const inst = await fakeInstaller();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "Main.java"), "a");
    const lock = lockWith({ command: inst.command, args: inst.args }, { "src/Main.java": "whatever" });
    await ensureInstalled(dir, { lock });
    await writeFile(path.join(dir, "src", "Main.java"), "b");
    await ensureInstalled(dir, { lock });
    expect((await readFile(inst.log, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("install이 null이면 아무것도 실행하지 않는다", async () => {
    await ensureInstalled(dir, { lock: lockWith(null) });
    await expect(readFile(path.join(dir, ".specmock-installed"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("실패하면 stdout까지 오류에 담는다(Maven은 컴파일 오류를 stdout에 쓴다)", async () => {
    const inst = await fakeInstaller();
    process.env.FAIL_OUT = "1";
    try {
      await expect(ensureInstalled(dir, { lock: lockWith({ command: inst.command, args: inst.args }) })).rejects.toThrow(/설치 실패 \(exit 3\)[\s\S]*COMPILATION ERROR/);
    } finally { delete process.env.FAIL_OUT; }
  });

  it("installTimeoutMs를 넘기면 프로세스 그룹을 죽이고 시간 초과로 거부한다", async () => {
    const script = path.join(dir, "slow.mjs");
    await writeFile(script, "setTimeout(() => {}, 60_000);\n");
    const lock = lockWith({ command: process.execPath, args: [script] });
    await expect(ensureInstalled(dir, { lock, timeoutMs: 300 })).rejects.toThrow("설치가 300ms 안에 끝나지 않았습니다");
  });

  it("markInstalled는 같은 키를 써서 설치를 건너뛰게 한다", async () => {
    const inst = await fakeInstaller();
    const lock = lockWith({ command: inst.command, args: inst.args });
    await markInstalled(dir, lock);
    await ensureInstalled(dir, { lock });
    await expect(readFile(inst.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

(`chmod` import는 쓰지 않으면 지운다.)

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/install.test.ts
```
기대: `does not provide an export named 'installKey'`.

- [ ] **Step 3: server.ts 구현**

`server.ts:1`의 import를 바꾼다.

```ts
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import getPort from "get-port";
import { resolveInstall, type Lock } from "../generate/lock.js";
import { hashJson, hashText } from "../util/hash.js";
import { killGroup, spawnGroup } from "../util/procGroup.js";
```

`StartMockOptions`(:12-18)는 그대로 둔다. `INSTALLED_MARKER`(:45)부터 `ensureInstalled` 끝(:93)까지를 아래로 바꾼다(`sleepAbortable`은 그대로 남긴다).

```ts
const INSTALLED_MARKER = ".specmock-installed";
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

/** 설치 키: install 명령 + lock.sourceFiles에 적힌 파일의 현재 내용 해시. 소스가 바뀌면(Java 빌드) 다시 설치한다. */
export async function installKey(dir: string, lock: Lock): Promise<string> {
  const files: Record<string, string | null> = {};
  for (const rel of Object.keys(lock.sourceFiles).sort()) {
    files[rel] = await readFile(path.join(dir, rel), "utf8").then(hashText, () => null);
  }
  return hashJson({ install: resolveInstall(lock), files });
}

/** 테스트·symlink된 node_modules용: 설치를 한 것으로 표시한다. */
export async function markInstalled(dir: string, lock: Lock): Promise<void> {
  await writeFile(path.join(dir, INSTALLED_MARKER), await installKey(dir, lock));
}

/** 설치 완료는 성공 뒤에 쓰는 마커(내용 = 설치 키)로 판정한다. 2단계의 node_modules 안 마커는 보지 않는다(한 번 다시 설치). */
async function isInstalled(dir: string, key: string): Promise<boolean> {
  return (await readFile(path.join(dir, INSTALLED_MARKER), "utf8").catch(() => null)) === key;
}

export interface EnsureInstalledOptions {
  /** 설치 명령의 출처. 없으면 2단계 동작(npm install). */
  lock?: Lock;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const LEGACY_LOCK = (): Lock => ({
  system: "", language: "ts", generator: "template", mockspecHash: "", generatedAt: "",
  start: { command: "", args: [] }, healthPath: "", fixtureHashes: {}, sourceFiles: {},
});

/**
 * 마커의 키가 다르면 lock의 install을 cwd=dir에서 실행한다(셸 없음). TS에서는 npm install이 없으면 `npx tsx`가 설치 여부를 묻다가 멈춘다.
 * 취소·실패해도 산출물(node_modules, target)은 지우지 않는다. 마커가 없으니 다음 호출이 다시 설치한다.
 */
export async function ensureInstalled(dir: string, opts: EnsureInstalledOptions = {}): Promise<void> {
  opts.signal?.throwIfAborted();
  const lock = opts.lock ?? LEGACY_LOCK();
  const install = resolveInstall(lock);
  if (!install) return;
  const key = await installKey(dir, lock);
  if (await isInstalled(dir, key)) return;
  const label = install.command === "npm" ? "npm install" : [install.command, ...install.args.slice(0, 1)].join(" ");
  const timeoutMs = opts.timeoutMs ?? lock.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  opts.onLog?.(`의존성 설치 중 (${label})...`);
  let onAbort = () => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnGroup(install.command, install.args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const keep = (d: unknown) => { out = (out + String(d)).slice(-20_000); };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      onAbort = () => { killGroup(child, "SIGKILL"); reject(abortReason(opts.signal!)); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();   // 리스너를 달기 전에 이미 취소된 경우
      timer = setTimeout(() => { killGroup(child, "SIGKILL"); reject(new Error(`${label} 설치가 ${timeoutMs}ms 안에 끝나지 않았습니다.\n${out}`)); }, timeoutMs);
      child.once("error", (e) => reject(new Error(`${label}을(를) 실행할 수 없습니다: ${e.message}`)));
      child.once("exit", (code) => (opts.signal?.aborted ? undefined : code === 0 ? resolve() : reject(new Error(`${label} 설치 실패 (exit ${code}).\n${out}`))));
    });
    opts.signal?.throwIfAborted();
    await writeFile(path.join(dir, INSTALLED_MARKER), key);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
```

오류 문구의 앞부분이 `npm install 설치 실패 (exit 1)`·`npm install을(를) 실행할 수 없습니다`가 되어 `cancel.test.ts:206`의 `/npm install/`은 계속 맞는다. 테스트의 시간 초과 문구 단정은 label 앞부분을 빼고 `"설치가 300ms 안에 끝나지 않았습니다"`만 본다.

`startMock`(:105)의 첫 줄과 기동 타임아웃을 바꾼다.

```ts
export async function startMock(dir: string, lock: Lock, opts: StartMockOptions = {}): Promise<RunningMock> {
  await ensureInstalled(dir, { lock, onLog: opts.onLog, signal: opts.signal });
```

```ts
      opts.timeoutMs ?? lock.startTimeoutMs ?? 30_000,
```

`packages/core/src/index.ts:27`:

```ts
export { startMock, ensureInstalled, installKey, markInstalled, type RunningMock, type StartMockOptions, type EnsureInstalledOptions } from "./verify/server.js";
```

- [ ] **Step 4: 테스트들의 마커 위치를 옮긴다**

`packages/core/test/cancel.test.ts:113`:

```ts
    await expect(access(path.join(out, ".specmock-installed"))).rejects.toMatchObject({ code: "ENOENT" });
```

`packages/core/test/e2e.test.ts:29-31`(import에 `markInstalled`(`../src/verify/server.js`)를 더한다):

```ts
async function linkNodeModules() {
  await symlink(ROOT_NODE_MODULES, path.join(out, "node_modules"), "dir");
  // 루트 node_modules를 쓰므로 npm install을 건너뛴다(마커는 outDir마다 따로 생긴다).
  await markInstalled(out, (await readLock(out))!);
}
```

`packages/core/test/service.test.ts:176`의 symlink 줄 다음에:

```ts
    await markInstalled(out, (await readLock(out))!);
```

(이 파일 머리에 `import { readLock } from "../src/generate/lock.js";`와 `import { markInstalled } from "../src/verify/server.js";`를 더한다.)

`packages/mcp/test/tools.test.ts:142-144`(import에 `markInstalled, readLock`을 `@specmock/core`에서 더한다. `readLock`이 core index에서 내보내지는지 `grep -n readLock packages/core/src/index.ts`로 확인하고, 없으면 `export { readLock } from "./generate/lock.js";`를 core index에 더한다):

```ts
async function linkNodeModules(outDir: string) {
  await symlink(ROOT_NODE_MODULES, path.join(outDir, "node_modules"), "dir");
  await markInstalled(outDir, (await readLock(outDir))!);
}
```

`grep -rn "symlink(ROOT_NODE_MODULES" packages/*/test`로 verify까지 가는 다른 곳을 찾아 같은 두 줄을 더한다(`generate.test.ts:170`은 tsc만 돌리므로 그대로).

- [ ] **Step 5: 통과 확인**

```bash
pnpm vitest run packages/core/test/install.test.ts packages/core/test/cancel.test.ts packages/core/test/e2e.test.ts packages/core/test/service.test.ts
```
기대: 모두 passed.

- [ ] **Step 6: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core packages/mcp/test
git commit -m "feat(core): verify가 lock의 install을 실행하고 설치 마커를 outDir 루트로 옮긴다

마커 내용은 install 명령과 sourceFiles 현재 해시의 키라서 소스가 바뀌면 다시 빌드한다.
설치 출력은 stdout까지 모으고 installTimeoutMs(기본 600s)·startTimeoutMs를 따른다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 런타임 계약 7(501)·8(404), coverage 절, verifyFailed

**Files:**
- Create: `packages/core/src/verify/runtime.ts`
- Modify: `packages/core/src/verify/index.ts:17-23`(VerifyResult), `:75-99`(VerifyOptions·verify)
- Modify: `packages/core/src/verify/coverage.ts:60-61`(선택되지 않은 기능 앞)
- Modify: `packages/core/src/service/verify.ts:24-31`
- Modify: `packages/core/src/index.ts`(verify export 줄)
- Modify: `packages/cli/src/context.ts:32-37`, `packages/cli/src/commands/verify.ts:23`, `packages/cli/src/commands/run.ts:51`
- Modify: `packages/mcp/src/tools/mock.ts:75-98`(verify_mock)
- Test: `packages/core/test/runtime.test.ts`(새 파일), `packages/core/test/e2e.test.ts`

- [ ] **Step 1: 실패 테스트 — 대상 고르기와 검사**

```ts
// packages/core/test/runtime.test.ts
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { pickNotMocked, runRuntimeChecks } from "../src/verify/runtime.js";

let server: Server | undefined;
afterEach(async () => { await new Promise((r) => server ? server.close(r) : r(undefined)); server = undefined; });

/** 501·404를 status로 흉내 내는 서버. handler가 경로별 응답을 정한다. */
async function serve(handler: (method: string, path: string) => [number, unknown]): Promise<string> {
  server = createServer((req, res) => {
    const [status, body] = handler(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

describe("pickNotMocked", () => {
  it("선택된 같은 method 경로와 겹치는 항목은 건너뛴다", () => {
    const rt = {
      features: [{ method: "GET" as const, path: "/pets/{petId}" }],
      notMocked: [
        { id: "mine", method: "GET" as const, path: "/pets/mine" },
        { id: "listPets", method: "GET" as const, path: "/pets" },
      ],
    };
    expect(pickNotMocked(rt)?.id).toBe("listPets");
  });
  it("고를 항목이 없으면 null", () => {
    expect(pickNotMocked({ features: [], notMocked: [] })).toBeNull();
  });
});

describe("runRuntimeChecks", () => {
  const rt = { features: [{ method: "GET" as const, path: "/pets/{petId}" }], notMocked: [{ id: "listPets", method: "GET" as const, path: "/pets" }] };

  it("501 not_mocked와 404 unknown_path를 확인한다", async () => {
    const base = await serve((_m, p) => (p === "/pets" ? [501, { error: "not_mocked", feature: "listPets", hint: "x" }] : [404, { error: "unknown_path" }]));
    const checks = await runRuntimeChecks(base, rt);
    expect(checks.map((c) => [c.id, c.passed, c.skipped])).toEqual([["not_mocked", true, false], ["unknown_path", true, false]]);
  });

  it("미선택 경로가 404면 계약 7 실패, 모르는 경로가 200이면 계약 8 실패", async () => {
    const base = await serve(() => [200, {}]);
    const checks = await runRuntimeChecks(base, rt);
    expect(checks.every((c) => !c.passed)).toBe(true);
    expect(checks[0].errors[0]).toBe("status: expected 501, got 200");
  });

  it("runtime 정보가 없으면 계약 8만, notMocked가 비면 계약 7은 skipped", async () => {
    const base = await serve(() => [404, { error: "unknown_path" }]);
    expect((await runRuntimeChecks(base, undefined)).map((c) => c.id)).toEqual(["unknown_path"]);
    const both = await runRuntimeChecks(base, { features: [], notMocked: [] });
    expect(both[0]).toMatchObject({ id: "not_mocked", skipped: true, passed: true });
  });
});
```

`packages/core/test/e2e.test.ts`의 "getPet만 선택" 테스트(`total).toBe(1)`을 단정하는 곳) 끝에 추가한다. 이 테스트가 `verify(out)`을 직접 부르면 아래처럼 runtime을 넘기는 호출을 하나 더 둔다.

```ts
    const spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
    const rt = await verify(out, { runtime: { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) } });
    expect(rt.runtime.map((c) => [c.id, c.passed]), JSON.stringify(rt.runtime, null, 2)).toEqual([["not_mocked", true], ["unknown_path", true]]);
    expect(rt.runtimeFailed).toBe(0);
    expect(rt.total).toBe(1);
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/runtime.test.ts
```
기대: `Failed to load url ../src/verify/runtime.js` 계열로 실패.

- [ ] **Step 3: runtime.ts 구현**

```ts
// packages/core/src/verify/runtime.ts
import { randomBytes } from "node:crypto";
import type { HttpMethod } from "../types.js";

export interface RuntimeSpec {
  notMocked: { id: string; method: HttpMethod; path: string }[];
  features: { method: HttpMethod; path: string }[];
}

export interface RuntimeCheck {
  id: "not_mocked" | "unknown_path";
  /** coverage.md·CLI에 보이는 이름. */
  name: string;
  passed: boolean;
  skipped: boolean;
  /** "GET /pets" 형태. skipped면 null. */
  request: string | null;
  expectedStatus: number;
  actualStatus: number | null;
  errors: string[];
}

/** TS 템플릿 notMocked.ts의 toRegex와 같은 규칙: {x} → 한 세그먼트, 끝 슬래시 허용. */
function toRegex(p: string): RegExp {
  return new RegExp("^" + p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "/?$");
}
const fill = (p: string) => p.replace(/\{[^}]+\}/g, "1");

/** 요청 경로가 선택된 같은 method 기능과 겹치지 않는 첫 notMocked 항목. HEAD(바디 없음)·OPTIONS(프레임워크가 가로챌 수 있음)는 제외한다. */
export function pickNotMocked(rt: RuntimeSpec): RuntimeSpec["notMocked"][number] | null {
  for (const n of rt.notMocked) {
    if (n.method === "HEAD" || n.method === "OPTIONS") continue;
    const url = fill(n.path);
    if (!rt.features.some((f) => f.method === n.method && toRegex(f.path).test(url))) return n;
  }
  return null;
}

async function probe(base: string, method: string, p: string, expected: number, check: (body: Record<string, unknown>) => string[]): Promise<Pick<RuntimeCheck, "passed" | "actualStatus" | "errors">> {
  const errors: string[] = [];
  let actualStatus: number | null = null;
  try {
    const res = await fetch(new URL(p, base), { method, signal: AbortSignal.timeout(10_000) });
    actualStatus = res.status;
    const text = await res.text();
    if (res.status !== expected) errors.push(`status: expected ${expected}, got ${res.status}`);
    else {
      let body: unknown;
      try { body = JSON.parse(text); } catch { errors.push(`body is not JSON: ${text.slice(0, 200)}`); }
      if (body !== undefined) errors.push(...check((body ?? {}) as Record<string, unknown>));
    }
  } catch (e) {
    errors.push(`request failed: ${(e as Error).message}`);
  }
  return { passed: errors.length === 0, actualStatus, errors };
}

/** 계약 7(선택 안 된 기능 → 501)과 8(모르는 경로 → 404). rt가 없으면 8만 본다. */
export async function runRuntimeChecks(base: string, rt: RuntimeSpec | undefined): Promise<RuntimeCheck[]> {
  const out: RuntimeCheck[] = [];
  if (rt) {
    const n = pickNotMocked(rt);
    if (!n) {
      out.push({ id: "not_mocked", name: "선택 안 된 기능 → 501", passed: true, skipped: true, request: null, expectedStatus: 501, actualStatus: null, errors: [] });
    } else {
      const p = fill(n.path);
      const r = await probe(base, n.method, p, 501, (b) => [
        ...(b.error === "not_mocked" ? [] : [`body.error: expected "not_mocked", got ${JSON.stringify(b.error)}`]),
        ...(b.feature === n.id ? [] : [`body.feature: expected "${n.id}", got ${JSON.stringify(b.feature)}`]),
      ]);
      out.push({ id: "not_mocked", name: "선택 안 된 기능 → 501", skipped: false, request: `${n.method} ${p}`, expectedStatus: 501, ...r });
    }
  }
  const p = `/__specmock/unknown-${randomBytes(4).toString("hex")}`;
  const r = await probe(base, "GET", p, 404, (b) => (b.error === "unknown_path" ? [] : [`body.error: expected "unknown_path", got ${JSON.stringify(b.error)}`]));
  out.push({ id: "unknown_path", name: "모르는 경로 → 404", skipped: false, request: `GET ${p}`, expectedStatus: 404, ...r });
  return out;
}
```

- [ ] **Step 4: verify에 runtime 옵션과 결과**

`packages/core/src/verify/index.ts`의 import에 `import { runRuntimeChecks, type RuntimeCheck, type RuntimeSpec } from "./runtime.js";`를 더하고, `VerifyResult`(:17-23)·`VerifyOptions`·`verify`를 바꾼다.

```ts
export interface VerifyResult {
  mockDir: string;
  /** contract 수. 런타임 계약은 세지 않는다. */
  total: number;
  passed: number;
  failed: number;
  results: ContractResult[];
  /** 계약 7·8. */
  runtime: RuntimeCheck[];
  runtimeFailed: number;
}

/** verify 실패(종료 코드 2) 판정. contract 실패 또는 런타임 계약 실패. */
export function verifyFailed(r: VerifyResult): boolean {
  return r.failed > 0 || r.runtimeFailed > 0;
}
```

```ts
export interface VerifyOptions {
  /** 오래 걸리는 단계(설치 등)를 알려주는 콜백. */
  onLog?: (message: string) => void;
  /** 취소. abort되면 mock을 정리하고 AbortError로 거부한다. */
  signal?: AbortSignal;
  /** mockspec의 notMocked·선택 기능. 있으면 계약 7(501)도 검사한다. */
  runtime?: RuntimeSpec;
}

export async function verify(mockDir: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const lock = await readLock(mockDir);
  if (!lock) throw new Error(`${mockDir}에 specmock.lock.json이 없습니다. 먼저 specmock generate를 실행하세요.`);
  const contracts = await loadContracts(mockDir);
  const server = await startMock(mockDir, lock, { onLog: opts.onLog, signal: opts.signal });
  const ajv = makeAjv();
  const results: ContractResult[] = [];
  let runtime: RuntimeCheck[] = [];
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const c of contracts) {
      opts.signal?.throwIfAborted();
      results.push(await runContract(base, ajv, c));
    }
    opts.signal?.throwIfAborted();
    runtime = await runRuntimeChecks(base, opts.runtime);
  } finally {
    await server.stop();
  }
  const passed = results.filter((r) => r.passed).length;
  return { mockDir, total: results.length, passed, failed: results.length - passed, results, runtime, runtimeFailed: runtime.filter((c) => !c.passed).length };
}
```

`packages/core/src/index.ts:26`(지금: `export { verify, loadContracts, type VerifyOptions, type VerifyResult, type ContractResult } from "./verify/index.js";`)을 두 줄로 바꾼다.

```ts
export { verify, verifyFailed, loadContracts, type VerifyOptions, type VerifyResult, type ContractResult } from "./verify/index.js";
export type { RuntimeCheck, RuntimeSpec } from "./verify/runtime.js";
```

- [ ] **Step 5: verifyMock이 spec을 먼저 읽고 runtime을 넘긴다**

```ts
// packages/core/src/service/verify.ts:24-31
export async function verifyMock(ws: Workspace, system: string, opts: { dir?: string; onEvent?: OnEvent; signal?: AbortSignal } = {}): Promise<VerifyMockResult> {
  const dir = await resolveMockDir(ws, system, opts.dir);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const runtime = { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) };
  const result = await verify(dir, { onLog: (message) => opts.onEvent?.({ stage: "verify", message }), signal: opts.signal, runtime });
  const coverageMarkdown = renderCoverage(spec, result);
  const coverageFile = await ws.writeText(system, "coverage.md", coverageMarkdown);
  return { dir, result, coverageFile, coverageMarkdown };
}
```

- [ ] **Step 6: coverage.md "## 런타임 계약" 절**

`packages/core/src/verify/coverage.ts:60`의 `lines.push("");` 다음, `## 선택되지 않은 기능` 앞에 넣는다.

```ts
  lines.push("## 런타임 계약");
  lines.push("");
  if (!result) {
    lines.push("실행하지 않음 (`specmock verify` 로 실행)");
  } else {
    lines.push("| 계약 | 요청 | 기대 | 실제 | 결과 |");
    lines.push("|---|---|---|---|---|");
    for (const c of result.runtime) {
      const verdict = c.skipped ? "건너뜀 (대상 없음)" : c.passed ? "통과" : `실패: ${c.errors.join("; ")}`;
      lines.push(`| ${cell(c.name)} | ${cell(c.request ?? "-")} | ${c.expectedStatus} | ${c.actualStatus ?? "-"} | ${cell(verdict)} |`);
    }
  }
  lines.push("");
```

`packages/core/test/coverage.test.ts`가 `renderCoverage(spec, result)`에 넘기는 `VerifyResult` 객체 리터럴에 `runtime: [], runtimeFailed: 0`을 더한다(`grep -n "failed:" packages/core/test/coverage.test.ts`로 위치 확인). web의 `parseCoverage`는 `## ` 제목 앞부분으로 절을 찾으므로 새 절이 끼어도 영향이 없다.

- [ ] **Step 7: CLI·MCP의 실패 판정과 출력**

```ts
// packages/cli/src/context.ts:32-37
export function formatVerify(result: VerifyResult, coveragePath: string): string {
  const lines = [`contract: 통과 ${result.passed} / 실패 ${result.failed} / 전체 ${result.total}`];
  for (const r of result.results.filter((x) => !x.passed)) lines.push(`  ✗ ${r.featureId} [${r.name}] ${r.errors.join("; ")}`);
  for (const c of result.runtime.filter((x) => !x.passed)) lines.push(`  ✗ runtime [${c.name}] ${c.request ?? ""} ${c.errors.join("; ")}`);
  lines.push(`coverage: ${coveragePath}`);
  return lines.join("\n");
}
```

```ts
// packages/cli/src/commands/verify.ts:23 (import에 verifyFailed 추가)
      if (verifyFailed(v.result)) process.exitCode = 2;
```

```ts
// packages/cli/src/commands/run.ts:51 (import에 verifyFailed 추가)
      if (r.extractFailed || (r.verify && verifyFailed(r.verify))) process.exitCode = 2;
```

`r.verify`는 `RunPipelineResult.verify: VerifyResult | null`(`service/run.ts:41`)이라 그대로 넘긴다.

```ts
// packages/mcp/src/tools/mock.ts verify_mock — outputSchema에 runtime 추가
    outputSchema: z.object({
      total: z.number(), passed: z.number(), failed: z.number(),
      failures: z.array(z.object({ featureId: z.string(), name: z.string(), expectedStatus: z.number(), actualStatus: z.number().nullable(), errors: z.array(z.string()) })),
      runtime: z.array(z.object({ id: z.string(), name: z.string(), passed: z.boolean(), skipped: z.boolean(), request: z.string().nullable(), errors: z.array(z.string()) })),
      coverageFile: z.string(), coverageSummary: z.string(),
    }),
```

```ts
    const runtime = v.result.runtime.map((c) => ({ id: c.id, name: c.name, passed: c.passed, skipped: c.skipped, request: c.request, errors: c.errors }));
    const data = { total: v.result.total, passed: v.result.passed, failed: v.result.failed, failures, runtime, coverageFile: absPath(ws.dir(system), v.coverageFile), coverageSummary: coverageSummary(v.coverageMarkdown) };
    return ok(`contract: 통과 ${data.passed} / 실패 ${data.failed}, 런타임 계약 실패 ${v.result.runtimeFailed}. 커버리지: ${data.coverageFile}`, data);
```

- [ ] **Step 8: 통과 확인**

```bash
pnpm vitest run packages/core/test/runtime.test.ts packages/core/test/e2e.test.ts packages/core/test/coverage.test.ts packages/core/test/service.test.ts
```
기대: 모두 passed.

- [ ] **Step 9: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core packages/cli packages/mcp
git commit -m "feat(core): verify가 런타임 계약 7(501)·8(404)을 검사한다

결과는 VerifyResult.runtime으로 따로 두고 total은 contract 수를 유지한다.
coverage.md에 런타임 계약 절을 더하고 종료 코드 판정은 verifyFailed로 모은다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 실행 안내 조합 함수와 하드코딩 5곳 교체

**Files:**
- Modify: `packages/core/src/generate/lock.ts`(함수 추가)
- Modify: `packages/core/src/generate/index.ts`(`launch` 필드)
- Modify: `packages/cli/src/commands/generate.ts:18`, `packages/cli/src/commands/run.ts:41`
- Modify: `packages/mcp/src/tools/mock.ts:68`(결과 문구), `:73`(verify_mock 설명)
- Modify: `packages/web/src/screens/Generate.tsx:11`(지역 GenerateReport), `:76`
- Modify: `packages/web/test/Generate.test.tsx`(가짜 응답에 `launch`)
- Modify: `plugin/skills/specmock/SKILL.md:116`
- Test: `packages/core/test/lock.test.ts`

- [ ] **Step 1: 실패 테스트**

`packages/core/test/lock.test.ts` 끝에 추가(import에 `launchCommand, launchHint`를 더한다):

```ts
describe("실행 안내", () => {
  const base = { system: "s", generator: "template" as const, mockspecHash: "h", generatedAt: "t", healthPath: "/h", fixtureHashes: {}, sourceFiles: {} };
  it("ts는 package.json 스크립트 문구를 쓴다", () => {
    const lock = { ...base, language: "ts", install: NPM_INSTALL, start: { command: "npx", args: ["tsx", "src/server.ts"] } };
    expect(launchCommand(lock)).toBe("npm install && npm start");
    expect(launchHint("/r/mock/s", lock)).toBe("cd /r/mock/s && npm install && npm start");
  });
  it("그 밖의 언어는 install·start argv를 잇는다", () => {
    const lock = { ...base, language: "java", install: { command: "./mvnw", args: ["-q", "-DskipTests", "package"] }, start: { command: "java", args: ["-jar", "target/mock.jar"] } };
    expect(launchHint("mock/petstore", lock)).toBe("cd mock/petstore && ./mvnw -q -DskipTests package && java -jar target/mock.jar");
  });
  it("install이 null이면 start만", () => {
    expect(launchCommand({ ...base, language: "fake", install: null, start: { command: "node", args: ["server.mjs"] } })).toBe("node server.mjs");
  });
  it("generate 결과의 launch는 lock에서 조합한다", async () => {
    const r = await generate(ws, "petstore", { outDir: out });
    expect(r.launch).toBe(`cd ${out} && npm install && npm start`);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/lock.test.ts -t 실행
```
기대: `does not provide an export named 'launchCommand'`.

- [ ] **Step 3: lock.ts에 조합 함수**

```ts
// packages/core/src/generate/lock.ts 끝에 추가
const quoteArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const joinCommand = (c: { command: string; args: string[] }) => [c.command, ...c.args].map(quoteArg).join(" ");

/** 사용자가 mock을 직접 띄우는 명령. ts는 package.json 스크립트가 있으므로 지금 문구 그대로. */
export function launchCommand(lock: Pick<Lock, "language" | "install" | "start">): string {
  if (lock.language === "ts") return "npm install && npm start";
  const install = lock.install === undefined ? NPM_INSTALL : lock.install;
  return [install ? joinCommand(install) : null, joinCommand(lock.start)].filter(Boolean).join(" && ");
}

export function launchHint(outDir: string, lock: Pick<Lock, "language" | "install" | "start">): string {
  return `cd ${outDir} && ${launchCommand(lock)}`;
}
```

`packages/core/src/index.ts:24`:

```ts
export { readLock, launchCommand, launchHint, type Lock } from "./generate/lock.js";
```

`packages/core/src/generate/index.ts`의 반환값에서 `launch`를 바꾼다(import에 `launchHint` 추가).

```ts
    launch: launchHint(outDir, { language, install: output.install, start: output.start }),
```

- [ ] **Step 4: 하드코딩 5곳 교체**

```ts
// packages/cli/src/commands/generate.ts:17-19
      printJsonOr(opts.json, report, () =>
        `${formatGenerate(report)}\n실행: ${report.launch}\n검증: specmock verify ${system}`,
      );
```

```ts
// packages/cli/src/commands/run.ts:41
            if (!opts.verify) out(`verify 생략. 실행: ${s.report.launch}\n`);
```

```ts
// packages/mcp/src/tools/mock.ts:67-68 (generate_mock 결과)
    const r = await generate(ws, system, { outDir, force });
    return ok(`생성: ${r.outDir} (파일 ${r.written.length}개, 보존 ${r.preserved.length}, 남겨진 fixture ${r.orphaned.length}). 실행: ${r.launch}. 다음: verify_mock`, { outDir: r.outDir, written: r.written, preserved: r.preserved, orphaned: r.orphaned });
```

```ts
// packages/mcp/src/tools/mock.ts:73 (verify_mock 설명)
    description: "mock 서버를 띄워 contract test와 런타임 계약(501·404)을 실행하고 .specmock/<system>/coverage.md를 쓴다. 대상은 dir → 마지막 generate_mock 위치 → ./mock/<system>. 의존성이 없으면 lock의 설치 명령(TS는 npm install, Java는 ./mvnw package)을 먼저 실행하므로 처음엔 오래 걸릴 수 있다.",
```

```tsx
// packages/web/src/screens/Generate.tsx:11
interface GenerateReport { outDir: string; written: string[]; preserved: string[]; orphaned: string[]; launch?: string }
```

```tsx
// packages/web/src/screens/Generate.tsx:76 (launch가 없는 옛 작업 결과는 기존 문구)
          <pre className="cmd">{done.launch ?? `cd ${done.outDir} && npm install && npm start`}</pre>
```

`packages/web/test/Generate.test.tsx:86`의 결과 객체에 `launch`를 더해 새 경로를 덮는다. :117·:132는 `launch` 없이 두어 대체 문구 경로를 덮는다.

```ts
// packages/web/test/Generate.test.tsx:86
  emit("job-done", job({ state: "done", result: { outDir: "/r/mock/petstore", written: ["package.json", "src/server.ts"], preserved: ["fixtures/a.json"], orphaned: [], launch: "cd /r/mock/petstore && npm install && npm start" } }));
```

```markdown
<!-- plugin/skills/specmock/SKILL.md:116 -->
- 실행법: generate 출력의 `실행:` 줄을 그대로 보여 준다. TS는 `cd mock/<system> && npm install && npm start`, Java는 `cd mock/<system> && ./mvnw -q -DskipTests package && java -jar target/mock.jar` (기본 포트 4010).
```

- [ ] **Step 5: 남은 하드코딩이 없는지 확인**

```bash
grep -rn "npm install && npm start" packages/*/src plugin
```
기대: 세 줄 — `packages/core/src/generate/lock.ts`(`launchCommand`), `packages/web/src/screens/Generate.tsx`(대체 문구), `plugin/skills/specmock/SKILL.md`(TS 예시).

- [ ] **Step 6: 통과 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages plugin
git commit -m "feat: 실행 안내를 lock에서 조합하는 launchHint로 바꾼다

CLI generate·run, MCP generate_mock·verify_mock 설명, web Generate 화면, 스킬 문서의
npm install && npm start 하드코딩을 GenerateReport.launch로 교체한다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 7: `LlmAdapter.extract` → `complete`, 요청별 `timeoutMs`

**Files:**
- Modify: `packages/core/src/llm/adapter.ts`(전체), `packages/core/src/llm/claudeCode.ts:6,32,39`, `packages/core/src/llm/session.ts:1,10`, `packages/core/src/llm/index.ts:5`
- Modify: `packages/core/src/analyze/extract.ts:58`, `packages/core/src/index.ts:31`, `scripts/live-llm-check.ts:9`
- Test: `packages/core/test/llm.test.ts`, `packages/core/test/extract.test.ts:26,36,124,131`, `packages/core/test/service.test.ts:79,191,200`, `packages/core/test/cancel.test.ts:227`

- [ ] **Step 1: 실패 테스트 — 요청별 시간 제한이 생성자 값보다 우선한다**

`packages/core/test/llm.test.ts`의 `"times out"` 테스트 아래에 추가한다.

```ts
  it("요청의 timeoutMs가 생성자 timeoutMs보다 우선한다", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-slow"), timeoutMs: 60_000 });
    await expect(adapter.complete({ prompt: "x", schema, timeoutMs: 200 })).rejects.toThrow("claude 호출 시간 초과 (200ms)");
  }, 5_000);
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/llm.test.ts -t 우선한다
```
기대: `TypeError: adapter.complete is not a function`.

- [ ] **Step 3: 어댑터 인터페이스**

```ts
// packages/core/src/llm/adapter.ts 전체
export interface CompleteRequest {
  /** 완성 프롬프트(지시문 + 본문). */
  prompt: string;
  /** 출력이 따라야 하는 JSON Schema. */
  schema: Record<string, unknown>;
  /** 취소. abort되면 진행 중인 호출을 끝내고 AbortError로 거부한다. */
  signal?: AbortSignal;
  /** 이 호출의 시간 제한. 없으면 어댑터 기본값(claude-code 180_000). 추출은 기본값, 생성은 600_000. */
  timeoutMs?: number;
}

/** @deprecated CompleteRequest를 쓴다. 2단계 이름 호환용. */
export type ExtractRequest = CompleteRequest;

export interface LlmAdapter {
  readonly name: "claude-code" | "session" | "api";
  /** 스키마를 만족하는 JSON 값을 돌려준다. 검증은 호출자가 다시 한다. */
  complete(req: CompleteRequest): Promise<unknown>;
}

export type AdapterName = LlmAdapter["name"];
```

- [ ] **Step 4: 구현 교체**

```ts
// packages/core/src/llm/claudeCode.ts:6
import type { CompleteRequest, LlmAdapter } from "./adapter.js";
```

```ts
// packages/core/src/llm/claudeCode.ts:32
  async complete(req: CompleteRequest): Promise<unknown> {
```

```ts
// packages/core/src/llm/claudeCode.ts:39
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs ?? 180_000;
```

```ts
// packages/core/src/llm/session.ts:1, :10
import type { CompleteRequest, LlmAdapter } from "./adapter.js";
// …
  async complete(_req: CompleteRequest): Promise<unknown> {
```

```ts
// packages/core/src/llm/index.ts:5
export type { AdapterName, CompleteRequest, ExtractRequest, LlmAdapter } from "./adapter.js";
```

```ts
// packages/core/src/index.ts:31
export { createAdapter, ADAPTER_NAMES, ClaudeCodeAdapter, SessionAdapter, type AdapterName, type LlmAdapter, type CompleteRequest, type ExtractRequest, type ClaudeCodeOptions } from "./llm/index.js";
```

```ts
// packages/core/src/analyze/extract.ts:58
      const raw = await adapter.complete({ prompt: buildChunkPrompt(body), schema: request.schema, signal: opts.signal });
```

```ts
// scripts/live-llm-check.ts:9
const out = await adapter.complete({ prompt: buildChunkPrompt(chunk), schema: extractionJsonSchema() });
```

- [ ] **Step 5: 테스트 호출부 교체**

가짜 어댑터 객체의 메서드 이름과 `adapter.extract(` 호출을 기계적으로 바꾼다.

```bash
sed -i '' -e 's/async extract(/async complete(/g' packages/core/test/extract.test.ts packages/core/test/service.test.ts
sed -i '' -e 's/\.extract({/.complete({/g' packages/core/test/llm.test.ts packages/core/test/cancel.test.ts
grep -rn "extract(" packages/core/test/llm.test.ts packages/core/test/cancel.test.ts packages/core/test/extract.test.ts packages/core/test/service.test.ts | grep -v "Extraction\|extracted\|clearExtract\|it(\"extract"
```
기대: 마지막 grep 출력 없음. (macOS `sed -i ''`. Linux면 `sed -i`.)

- [ ] **Step 6: 통과 확인과 커밋**

```bash
pnpm vitest run packages/core/test/llm.test.ts packages/core/test/extract.test.ts packages/core/test/service.test.ts packages/core/test/cancel.test.ts
```
기대: 모두 passed.

```bash
pnpm typecheck && pnpm test
git add -A packages/core scripts/live-llm-check.ts
git commit -m "refactor(core): LlmAdapter.extract를 complete로 일반화하고 요청별 timeoutMs를 받는다

추출은 기본 180초를 그대로 쓰고, 생성은 호출마다 600초를 넘길 수 있다.
ExtractRequest는 CompleteRequest의 별칭으로 남긴다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 언어 프로필 타입, glob, 지시서 작성기, 응답 검증, 테스트용 fake 프로필

**Files:**
- Create: `packages/core/src/generate/glob.ts`, `packages/core/src/generate/profiles/types.ts`, `packages/core/src/generate/request.ts`, `packages/core/src/generate/validateOutput.ts`
- Create: `packages/core/test/fakeProfile.ts`
- Modify: `packages/core/src/generate/profiles/index.ts`(`getProfile`)
- Test: `packages/core/test/request.test.ts`, `packages/core/test/validateOutput.test.ts`(새 파일)

- [ ] **Step 1: 실패 테스트 — glob과 응답 검증**

```ts
// packages/core/test/validateOutput.test.ts
import { describe, expect, it } from "vitest";
import { matchGlob } from "../src/generate/glob.js";
import { validateOutput } from "../src/generate/validateOutput.js";
import { fakeProfile } from "./fakeProfile.js";

describe("matchGlob", () => {
  it.each([
    ["src/**", "src/a/b/C.java", true],
    ["src/**", "srcx/a", false],
    ["pom.xml", "pom.xml", true],
    ["mvnw*", "mvnw.cmd", true],
    [".mvn/**", ".mvn/wrapper/maven-wrapper.properties", true],
    ["fixtures/**", "fixtures", true],
    ["*.mjs", "lib/a.mjs", false],
  ])("%s ~ %s → %s", (pattern, rel, expected) => {
    expect(matchGlob(pattern, rel)).toBe(expected);
  });
});

describe("validateOutput", () => {
  const ok = { files: [{ path: "server.mjs", content: "x" }], notes: [] };
  it("통과하면 정규화된 files·notes를 돌려준다", () => {
    expect(validateOutput(ok, fakeProfile)).toEqual({ ok: true, files: [{ path: "server.mjs", content: "x" }], notes: [] });
  });
  it("스키마 위반", () => {
    const r = validateOutput({ files: "x" }, fakeProfile);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/^응답 형식:/);
  });
  it.each([
    ["../evil.mjs", "경로가 outDir을 벗어납니다: ../evil.mjs"],
    ["/etc/passwd", "절대 경로는 쓸 수 없습니다: /etc/passwd"],
    ["fixtures/getPet/200.json", "보호 경로입니다: fixtures/getPet/200.json"],
    ["notes.txt", "sourceGlobs 밖입니다: notes.txt (허용: server.mjs, lib/**)"],
  ])("경로 %s 거부", (p, msg) => {
    const r = validateOutput({ files: [{ path: p, content: "x" }], notes: [] }, fakeProfile);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toContain(msg);
  });
  it("중복 경로와 maxFiles 초과", () => {
    const dup = validateOutput({ files: [{ path: "server.mjs", content: "a" }, { path: "server.mjs", content: "b" }], notes: [] }, fakeProfile);
    expect(!dup.ok && dup.errors).toContain("같은 경로가 두 번 나옵니다: server.mjs");
    const many = validateOutput({ files: Array.from({ length: 6 }, (_, i) => ({ path: `lib/${i}.mjs`, content: "" })), notes: [] }, fakeProfile);
    expect(!many.ok && many.errors).toContain("파일이 너무 많습니다: 6개 (최대 5)");
  });
  it("content:null은 삭제 표시로 통과한다", () => {
    expect(validateOutput({ files: [{ path: "lib/old.mjs", content: null }], notes: ["x"] }, fakeProfile)).toMatchObject({ ok: true, notes: ["x"] });
  });
});
```

- [ ] **Step 2: 테스트용 fake 프로필**

`fake` 프로필의 서버는 Node 내장 `http`만 쓰는 `server.mjs` 하나다. `fakeServerSource(spec)`가 Petstore용 정답 서버를 만든다(가짜 claude가 이 내용을 응답으로 돌려준다).

```ts
// packages/core/test/fakeProfile.ts
import type { LanguageProfile } from "../src/generate/profiles/types.js";
import type { MockSpec } from "../src/types.js";

/** 테스트 전용 언어. install 없음, node로 server.mjs 실행, 정적 파일 없음. */
export const fakeProfile: LanguageProfile = {
  language: "fake",
  displayName: "Fake (Node http)",
  rules: ["Node 내장 http만 쓴다.", "server.mjs 하나에 모든 라우트를 둔다."],
  staticFiles: [],
  install: () => null,
  start: { command: "node", args: ["server.mjs"] },
  healthPath: "/__specmock/health",
  startTimeoutMs: 10_000,
  installTimeoutMs: 10_000,
  sourceGlobs: ["server.mjs", "lib/**"],
  protectedPaths: ["fixtures/**", "contracts/**", "specmock.lock.json", ".specmock-installed"],
  maxFiles: 5,
  requires: "Node 22",
  referenceFiles: [],
};

/**
 * 런타임 계약을 모두 지키는 server.mjs. 선택 기능은 fixtures/<id>/<status>.json을 요청마다 읽고,
 * 필수 query·body 누락은 400, notMocked는 501, 그 밖은 404. 헬스는 TS 템플릿과 같은 {ok:true, system, features}.
 * opts.omit501 = true면 notMocked도 404를 낸다(계약 7 실패 재현용).
 */
export function fakeServerSource(spec: MockSpec, opts: { omit501?: boolean } = {}): string {
  const routes = spec.features.map((f) => {
    const ok = f.fixtures.map((x) => x.status).filter((s) => s >= 200 && s < 300).sort((a, b) => a - b)[0] ?? 200;
    const required = Object.entries(f.request.query).filter(([, p]) => p.required).map(([k]) => k);
    return { id: f.id, method: f.method, path: f.path, status: ok, required, hasBody: Boolean(f.request.body) };
  });
  const notMocked = opts.omit501 ? [] : spec.notMocked;
  return `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = ${JSON.stringify(routes)};
const notMocked = ${JSON.stringify(notMocked)};
const re = (p) => new RegExp("^" + p.replace(/\\{[^}]+\\}/g, "[^/]+") + "/?$");
const send = (res, status, body) => { res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__specmock/health") return send(res, 200, { ok: true, system: ${JSON.stringify(spec.system)}, features: routes.length });
  const r = routes.find((x) => x.method === req.method && re(x.path).test(url.pathname));
  if (r) {
    const missing = r.required.filter((k) => !url.searchParams.has(k));
    if (missing.length) return send(res, 400, { error: "validation_failed", details: missing.map((k) => "query." + k + " is required") });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (r.hasBody) {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (parsed === null || typeof parsed !== "object") return send(res, 400, { error: "validation_failed", details: ["body is required"] });
    }
    if (r.status === 204 || r.status === 205) return send(res, r.status);
    const body = JSON.parse(await readFile(new URL("./fixtures/" + r.id + "/" + r.status + ".json", import.meta.url), "utf8"));
    return send(res, r.status, body);
  }
  const n = notMocked.find((x) => x.method === req.method && re(x.path).test(url.pathname));
  if (n) return send(res, 501, { error: "not_mocked", feature: n.id, hint: "specmock select " + ${JSON.stringify(spec.system)} + " --add " + n.id + " && specmock generate " + ${JSON.stringify(spec.system)} });
  send(res, 404, { error: "unknown_path", method: req.method, path: url.pathname });
});
server.listen(Number(process.env.PORT ?? 4010), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}
```

- [ ] **Step 3: 실패 확인**

```bash
pnpm vitest run packages/core/test/validateOutput.test.ts
```
기대: `Failed to load url ../src/generate/glob.js` 계열로 실패.

- [ ] **Step 4: glob·프로필 타입·응답 검증 구현**

```ts
// packages/core/src/generate/glob.ts
/**
 * 아주 작은 glob. `**`(여러 세그먼트, 0개 포함), `*`(한 세그먼트 안), 나머지는 글자 그대로.
 * `dir/**`는 `dir` 자체와도 맞는다. 경로 구분자는 `/`만 쓴다.
 */
export function matchGlob(pattern: string, rel: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i - 1] === "/" && re.endsWith("/")) re = re.slice(0, -1) + "(?:/.*)?";
      else re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(rel);
}

export const matchesAny = (patterns: string[], rel: string) => patterns.some((p) => matchGlob(p, rel));
```

```ts
// packages/core/src/generate/profiles/types.ts
import type { Command } from "../generator.js";

export interface LanguageProfile {
  language: string;
  displayName: string;
  /** 프롬프트 5항목. 한 줄에 규칙 하나. */
  rules: string[];
  /** core의 templates/<언어>/ 아래 상대 경로. outDir에 같은 상대 경로로 복사한다. mode는 실행 권한(mvnw). */
  staticFiles: { path: string; mode?: number }[];
  /** 플랫폼별 설치 명령. null이면 설치 단계 없음. */
  install: (platform: NodeJS.Platform) => Command | null;
  start: Command;
  healthPath: string;
  startTimeoutMs: number;
  installTimeoutMs: number;
  /** 모델이 쓸 수 있는 곳이자 증분 생성 때 기존 소스로 읽는 범위. */
  sourceGlobs: string[];
  /** 모델이 쓰면 안 되는 곳. */
  protectedPaths: string[];
  maxFiles: number;
  /** 사용자 안내용 환경 요구. */
  requires: string;
  /** 프롬프트 6항목: templates/<언어>/ 아래 참조 발췌 파일. */
  referenceFiles: string[];
  /** 빌드 로그에 보이면 재시도하지 않는 환경 오류 패턴. */
  environmentErrors?: RegExp[];
}
```

```ts
// packages/core/src/generate/validateOutput.ts
import path from "node:path";
import { z } from "zod";
import { matchesAny } from "./glob.js";
import type { LanguageProfile } from "./profiles/types.js";

export const GeneratedOutputSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), content: z.string().nullable() })),
  notes: z.array(z.string()).default([]),
});
export type GeneratedOutput = z.infer<typeof GeneratedOutputSchema>;

export type ValidateResult =
  | { ok: true; files: GeneratedOutput["files"]; notes: string[] }
  | { ok: false; errors: string[] };

/** 모델 응답의 형식·경로·개수를 검사한다. 내용(컴파일 가능 여부)은 보지 않는다. */
export function validateOutput(raw: unknown, profile: LanguageProfile): ValidateResult {
  const parsed = GeneratedOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: [`응답 형식: ${z.prettifyError(parsed.error)}`] };
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of parsed.data.files) {
    const p = f.path.replace(/\\/g, "/");
    if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) { errors.push(`절대 경로는 쓸 수 없습니다: ${f.path}`); continue; }
    const norm = path.posix.normalize(p);
    if (norm === ".." || norm.startsWith("../")) { errors.push(`경로가 outDir을 벗어납니다: ${f.path}`); continue; }
    if (seen.has(norm)) errors.push(`같은 경로가 두 번 나옵니다: ${norm}`);
    seen.add(norm);
    if (matchesAny(profile.protectedPaths, norm)) errors.push(`보호 경로입니다: ${norm}`);
    else if (!matchesAny(profile.sourceGlobs, norm)) errors.push(`sourceGlobs 밖입니다: ${norm} (허용: ${profile.sourceGlobs.join(", ")})`);
  }
  if (parsed.data.files.length > profile.maxFiles) errors.push(`파일이 너무 많습니다: ${parsed.data.files.length}개 (최대 ${profile.maxFiles})`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, files: parsed.data.files.map((f) => ({ path: path.posix.normalize(f.path.replace(/\\/g, "/")), content: f.content })), notes: parsed.data.notes };
}

/** `claude --json-schema`에 넘길 출력 스키마. analyze의 extractionJsonSchema와 같은 변환. */
export function generatedOutputJsonSchema(): Record<string, unknown> {
  const js = z.toJSONSchema(GeneratedOutputSchema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
```

- [ ] **Step 5: 검증 통과 확인**

```bash
pnpm vitest run packages/core/test/validateOutput.test.ts
```
기대: 13 passed.

- [ ] **Step 6: 실패 테스트 — 지시서**

```ts
// packages/core/test/request.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { buildGenerateRequest, retrySection } from "../src/generate/request.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let spec: MockSpec;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-req-"));
  const ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
  spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("buildGenerateRequest", () => {
  it("프롬프트 8항목을 순서대로 담고 fixture 바디는 넣지 않는다", async () => {
    const req = await buildGenerateRequest({ spec, profile: fakeProfile, outDir: "/abs/mock/petstore", existing: null });
    const heads = [...req.prompt.matchAll(/^## (\d)\. /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual([1, 2, 3, 4, 5, 6, 8]);   // 7(증분)은 existing이 있을 때만
    expect(req.prompt).toContain("GET /pets/{petId}");
    expect(req.prompt).toContain("listPets");                 // notMocked
    expect(req.prompt).toContain("### src/server.ts");        // TS 참조
    expect(req.prompt).not.toContain('"source": "spec-example"');
    expect(req.reference.files.map((f) => f.path)).toContain("src/routes/pets.ts");
    expect(req.runtimeContract).toHaveLength(9);
    expect(req.outputSchema).toMatchObject({ type: "object", required: ["files"] });
    expect(req).toMatchObject({ system: "petstore", language: "fake", outDir: "/abs/mock/petstore", sourceGlobs: ["server.mjs", "lib/**"] });
  });

  it("증분이면 7항목과 existingSources·userModified를 넣는다", async () => {
    const req = await buildGenerateRequest({
      spec, profile: fakeProfile, outDir: "/o",
      existing: { files: [{ path: "server.mjs", content: "// old", userModified: true }] },
    });
    expect(req.prompt).toMatch(/^## 7\. 증분 생성/m);
    expect(req.prompt).toContain("### server.mjs (사용자 수정)");
    expect(req.existingSources).toEqual([{ path: "server.mjs", content: "// old", userModified: true }]);
  });
});

describe("retrySection", () => {
  it("실패 단계·오류 최대 50줄·실패 contract를 적는다", () => {
    const log = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const s = retrySection({ attempt: 1, stage: "build", errors: [log], contracts: [{ featureId: "getPet", name: "200", expectedStatus: 200, actualStatus: 500, errors: ["status: expected 200, got 500"] }], runtime: [] });
    expect(s).toMatch(/^## 이전 시도 결과 \(1번째\)/);
    expect(s).toContain("실패 단계: 빌드");
    expect(s).toContain("line 79");
    expect(s).not.toContain("line 29\n");
    expect(s).toContain("- getPet [200] 기대 200, 실제 500: status: expected 200, got 500");
  });
});
```

- [ ] **Step 7: 실패 확인**

```bash
pnpm vitest run packages/core/test/request.test.ts
```
기대: `Failed to load url ../src/generate/request.js`.

- [ ] **Step 8: 지시서 작성기 구현**

```ts
// packages/core/src/generate/request.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ContractResult } from "../verify/index.js";
import type { RuntimeCheck } from "../verify/runtime.js";
import type { MockSpec } from "../types.js";
import type { ExistingSources } from "./generator.js";
import type { LanguageProfile } from "./profiles/types.js";
import { renderTsHonoFiles } from "./tsHono.js";
import { generatedOutputJsonSchema } from "./validateOutput.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));

export const GenerateRequestSchema = z.object({
  system: z.string(),
  language: z.string(),
  createdAt: z.string(),
  mockspecHash: z.string(),
  outDir: z.string(),
  prompt: z.string(),
  rules: z.array(z.string()),
  runtimeContract: z.array(z.string()),
  reference: z.object({ language: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) }),
  existingSources: z.array(z.object({ path: z.string(), content: z.string(), userModified: z.boolean() })).default([]),
  protectedPaths: z.array(z.string()),
  sourceGlobs: z.array(z.string()),
  outputSchema: z.record(z.string(), z.unknown()),
  /** 세션 모드: 지시서 작성 시점의 보호 경로 파일 해시. finalize가 변경을 판정한다. */
  protectedHashes: z.record(z.string(), z.string()).default({}),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const RUNTIME_CONTRACT = [
  "1. specmock.lock.json은 specmock이 쓴다. 건드리지 않는다.",
  "2. install 명령(있으면)이 outDir에서 성공해야 한다.",
  "3. start 명령을 셸 없이 argv로 실행한다. cwd는 outDir, 포트는 PORT 환경변수(기본 4010).",
  "4. 127.0.0.1:<PORT>에 바인딩하고 healthPath에 200 {ok:true, system, features:<선택된 기능 수>}를 낸다.",
  "5. 선택된 기능마다 contract의 status를 내고, 2xx 바디는 fixtures/<id>/<status>.json을 요청마다 읽어 그대로 낸다(응답 스키마 통과).",
  "6. 필수 path·query·body가 없거나 스키마에 맞지 않으면 400 {error:\"validation_failed\", details}.",
  "7. notMocked 기능의 method+path는 501 {error:\"not_mocked\", feature:<id>, hint:\"specmock select <system> --add <id> && specmock generate <system>\"}.",
  "8. 그 밖의 경로는 404 {error:\"unknown_path\", method, path}.",
  "9. SIGTERM을 받으면 3초 안에 종료한다.",
];

const lowest2xx = (f: MockSpec["features"][number]) =>
  f.fixtures.map((x) => x.status).filter((s) => s >= 200 && s < 300).sort((a, b) => a - b)[0] ?? 200;

/** 2항목: fixture 바디 없이 기능 요약. */
function specSummary(spec: MockSpec): string {
  const features = spec.features.map((f) => ({
    id: f.id, method: f.method, path: f.path, status: lowest2xx(f),
    request: { params: f.request.params, query: f.request.query, body: f.request.body },
    responseSchema: f.responses[String(lowest2xx(f))]?.schema ?? null,
    fixture: `fixtures/${f.id}/${lowest2xx(f)}.json`,
  }));
  return [
    "선택된 기능:", "```json", JSON.stringify(features, null, 2), "```",
    "선택되지 않은 기능(501로 응답):", "```json", JSON.stringify(spec.notMocked, null, 2), "```",
    "verify가 보내는 contract:", "```json", JSON.stringify(spec.contracts, null, 2), "```",
  ].join("\n");
}

const fileBlock = (p: string, content: string, label = "") => `### ${p}${label}\n\n\`\`\`\n${content}\n\`\`\``;

export async function buildGenerateRequest(input: {
  spec: MockSpec; profile: LanguageProfile; outDir: string; existing: ExistingSources | null; mockspecHash?: string;
}): Promise<GenerateRequest> {
  const { spec, profile, outDir, existing } = input;
  const reference = renderTsHonoFiles(spec);
  const javaRefs = await Promise.all(profile.referenceFiles.map(async (p) => ({ path: p, content: await readFile(`${TEMPLATES}${profile.language}/${p}`, "utf8") })));
  const sections = [
    `## 1. 역할과 목표\n\n이 MockSpec의 mock 서버를 ${profile.displayName}로 작성한다. 아래 런타임 계약을 지키면 specmock verify가 통과한다. 시스템 이름: ${spec.system}`,
    `## 2. MockSpec 요약\n\n${specSummary(spec)}`,
    `## 3. 런타임 계약\n\n${RUNTIME_CONTRACT.join("\n")}`,
    `## 4. TypeScript 참조 구현\n\n같은 MockSpec으로 specmock이 만든 TS(Hono) 서버다. 구조·라우트 등록·검증 흐름·501/404·헬스 바디를 이와 같게 만든다.\n\n${reference.map((f) => fileBlock(f.path, f.content)).join("\n\n")}`,
    `## 5. ${profile.displayName} 규칙\n\n${profile.rules.map((r) => `- ${r}`).join("\n")}\n- 파일은 다음 범위에만 쓴다: ${profile.sourceGlobs.join(", ")}\n- 다음 경로는 쓰지 않는다: ${profile.protectedPaths.join(", ")}\n- 파일은 최대 ${profile.maxFiles}개.`,
    `## 6. ${profile.displayName} 참조 예시\n\n${javaRefs.length ? javaRefs.map((f) => fileBlock(f.path, f.content)).join("\n\n") : "(없음)"}`,
  ];
  if (existing) {
    sections.push(`## 7. 증분 생성\n\n기존 코드를 유지하고 추가·삭제된 기능만 반영한다. "(사용자 수정)" 파일은 라우트 추가·삭제 외에 바꾸지 않는다. 출력은 전체 파일 집합이다(바뀌지 않은 파일도 그대로 포함). 삭제할 파일은 content: null.\n\n${existing.files.map((f) => fileBlock(f.path, f.content, f.userModified ? " (사용자 수정)" : "")).join("\n\n")}`);
  }
  sections.push(`## 8. 출력 형식\n\n{"files":[{"path":"<outDir 기준 상대 경로>","content":"<파일 전체>"}],"notes":["가정이나 지키지 못한 규칙"]} 형식의 JSON 하나만 낸다. 출력 스키마는 --json-schema로 주어진다.`);
  return {
    system: spec.system,
    language: profile.language,
    createdAt: new Date().toISOString(),
    mockspecHash: input.mockspecHash ?? "",
    outDir,
    prompt: sections.join("\n\n"),
    rules: profile.rules,
    runtimeContract: RUNTIME_CONTRACT,
    reference: { language: "ts", files: reference },
    existingSources: existing?.files ?? [],
    protectedPaths: profile.protectedPaths,
    sourceGlobs: profile.sourceGlobs,
    outputSchema: generatedOutputJsonSchema(),
    protectedHashes: {},
  };
}

export interface AttemptFailure {
  attempt: number;
  stage: "response" | "build" | "start" | "contract";
  errors: string[];
  contracts: ContractResult[];
  runtime: RuntimeCheck[];
}

const STAGE_LABEL: Record<AttemptFailure["stage"], string> = { response: "응답 검증", build: "빌드", start: "기동", contract: "contract" };

/** 재시도 프롬프트 끝에 붙이는 절. 오류 텍스트는 마지막 50줄만. */
export function retrySection(f: AttemptFailure): string {
  const lines = f.errors.join("\n").split("\n");
  const tail = lines.slice(-50).join("\n");
  const failed = f.contracts.filter((c) => !c.passed).map((c) => `- ${c.featureId} [${c.name}] 기대 ${c.expectedStatus}, 실제 ${c.actualStatus ?? "응답 없음"}: ${c.errors.join("; ")}`);
  const rt = f.runtime.filter((c) => !c.passed).map((c) => `- ${c.name} ${c.request ?? ""}: ${c.errors.join("; ")}`);
  return [
    `## 이전 시도 결과 (${f.attempt}번째)`,
    "",
    `실패 단계: ${STAGE_LABEL[f.stage]}`,
    ...(tail.trim() ? ["", "```", tail, "```"] : []),
    ...(failed.length ? ["", "실패한 contract:", ...failed] : []),
    ...(rt.length ? ["", "실패한 런타임 계약:", ...rt] : []),
    "",
    "위 오류를 고친 전체 파일 집합을 다시 낸다.",
  ].join("\n");
}
```

`packages/core/src/generate/profiles/index.ts`에 등록표 조회를 더한다(파일 전체).

```ts
// packages/core/src/generate/profiles/index.ts
import type { LanguageProfile } from "./types.js";

/** LLM으로 생성하는 언어의 프로필. 비어 있으면 ts만 지원한다. */
const PROFILES: Record<string, LanguageProfile> = {};

/** 사용자에게 허용하는 언어. 각 언어는 실제 기동·검증 테스트가 있어야 등록한다. */
export const SUPPORTED_LANGUAGES: string[] = ["ts", ...Object.keys(PROFILES)];

export function assertLanguage(language: string): void {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`'${language}' 언어는 지원하지 않습니다. 지원 언어: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
}

export function getProfile(language: string): LanguageProfile | null {
  return PROFILES[language] ?? null;
}

export type { LanguageProfile } from "./types.js";
```

- [ ] **Step 9: 통과 확인과 커밋**

```bash
pnpm vitest run packages/core/test/request.test.ts packages/core/test/validateOutput.test.ts packages/core/test/lock.test.ts
```
기대: 모두 passed.

```bash
pnpm typecheck && pnpm test
git add -A packages/core
git commit -m "feat(core): 생성 지시서 작성기와 응답 검증, 언어 프로필 타입을 더한다

지시서는 프롬프트 8항목(fixture 바디 제외)과 zod 유래 출력 스키마를 담는다.
응답 검증은 경로 탈출·보호 경로·sourceGlobs·개수를 본다. 테스트용 fake 프로필을 둔다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: LlmGenerator — claude-code 시도 루프, 임시 디렉터리 검증, 환경 오류, attempt 보존

**Files:**
- Create: `packages/core/src/generate/errors.ts`, `packages/core/src/generate/llm.ts`
- Create: `packages/core/test/bin/claude-gen`(실행 권한)
- Modify: `packages/core/src/generate/generator.ts`(`LanguageOutput.files`에 `mode`), `packages/core/src/generate/scaffold.ts`(`writeLanguageFiles`의 chmod)
- Modify: `packages/core/src/index.ts`(export 추가)
- Test: `packages/core/test/llmGenerate.test.ts`(새 파일)

이 Task는 `generate()`에 연결하지 않는다. 생성기 하나만 단위로 검증한다.

- [ ] **Step 1: 생성용 가짜 claude**

기존 `packages/core/test/bin/claude`는 아래와 같다(프롬프트를 보고 고정 응답을 고른다).

```bash
#!/usr/bin/env bash
# 테스트용 가짜 claude. 실제 CLI와 같은 JSON 봉투를 출력한다. python3 등 외부 도구는 쓰지 않는다.
set -euo pipefail
if [ -n "${ARGS_LOG:-}" ]; then printf '%s\n' "$@" > "$ARGS_LOG"; fi
input=$(cat)
if [[ $input == *'/pets/{petId}'* ]]; then
  so='{"endpoints":[{"method":"GET","path":"/pets/{petId}","title":"Get a pet","responses":[{"status":200,"example":{"id":1}}],"evidence":["`GET /pets/{petId}` returns one pet."],"confidence":0.9}]}'
else
  so='{"endpoints":[]}'
fi
# result는 사람이 읽는 요약 문자열일 뿐이라 고정 리터럴로 둔다.
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","structured_output":%s}\n' "$so"
```

생성 테스트는 시도마다 다른 응답이 필요하다. 변형: 응답을 프롬프트로 고르지 않고 `$GEN_DIR/<n>.json`(호출 순번 n)에서 읽고, 받은 프롬프트를 `$GEN_DIR/prompt-<n>.txt`로 남긴다.

```bash
#!/usr/bin/env bash
# 생성 테스트용 가짜 claude. 호출마다 $GEN_DIR/<n>.json을 structured_output으로 낸다(n은 1부터). 프롬프트는 $GEN_DIR/prompt-<n>.txt에 남긴다.
set -euo pipefail
input=$(cat)
n=$(( $(cat "$GEN_DIR/count" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$n" > "$GEN_DIR/count"
printf '%s' "$input" > "$GEN_DIR/prompt-$n.txt"
so=$(cat "$GEN_DIR/$n.json")
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","structured_output":%s}\n' "$so"
```

```bash
chmod +x packages/core/test/bin/claude-gen
```

- [ ] **Step 2: 실패 테스트**

```ts
// packages/core/test/llmGenerate.test.ts
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { EnvironmentError, GenerationFailedError } from "../src/generate/errors.js";
import { ATTEMPT_DIR, LlmGenerator } from "../src/generate/llm.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema, type MockSpec } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");

let dir: string;
let genDir: string;
let out: string;
let spec: MockSpec;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-llmgen-"));
  genDir = path.join(dir, "gen");
  out = path.join(dir, "mock");
  await mkdir(genDir);
  const ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
  spec = await ws.read("petstore", "mockspec.json", MockSpecSchema);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const adapter = () => new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
const respond = (n: number, body: unknown) => writeFile(path.join(genDir, `${n}.json`), JSON.stringify(body));
const good = () => ({ files: [{ path: "server.mjs", content: fakeServerSource(spec) }], notes: ["가정: 페이지네이션 없음"] });
const calls = async () => Number(await readFile(path.join(genDir, "count"), "utf8"));

describe("LlmGenerator", () => {
  it("첫 시도에 통과하면 모델 파일과 notes·attempts를 돌려준다", async () => {
    await respond(1, good());
    const progress: string[] = [];
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing: null, onProgress: (e) => progress.push(`${e.stage} ${e.attempt}/${e.maxAttempts}`) });
    expect(r.attempts).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(["server.mjs"]);
    expect(r.notes).toEqual(["가정: 페이지네이션 없음"]);
    expect(r).toMatchObject({ install: null, start: { command: "node", args: ["server.mjs"] }, healthPath: "/__specmock/health" });
    expect(progress).toEqual(["generating 1/3", "building 1/3", "verifying 1/3"]);
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });   // outDir에는 아무것도 쓰지 않는다
  }, 30_000);

  it("계약 7 실패면 오류 요약을 붙여 다시 시도한다", async () => {
    await respond(1, { files: [{ path: "server.mjs", content: fakeServerSource(spec, { omit501: true }) }], notes: [] });
    await respond(2, good());
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing: null });
    expect(r.attempts).toBe(2);
    const prompt2 = await readFile(path.join(genDir, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("## 이전 시도 결과 (1번째)");
    expect(prompt2).toContain("실패 단계: contract");
    expect(prompt2).toContain("선택 안 된 기능 → 501");
  }, 30_000);

  it("응답 경로가 거부되면 응답 검증 단계로 다시 시도한다", async () => {
    await respond(1, { files: [{ path: "../evil.mjs", content: "x" }], notes: [] });
    await respond(2, good());
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing: null });
    expect(r.attempts).toBe(2);
    const prompt2 = await readFile(path.join(genDir, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("실패 단계: 응답 검증");
    expect(prompt2).toContain("경로가 outDir을 벗어납니다: ../evil.mjs");
  }, 30_000);

  it("maxAttempts를 다 쓰면 exit 5 오류와 .specmock-attempt/를 남긴다", async () => {
    const bad = { files: [{ path: "server.mjs", content: fakeServerSource(spec, { omit501: true }) }], notes: [] };
    await respond(1, bad);
    await respond(2, bad);
    const p = new LlmGenerator(fakeProfile, adapter(), { maxAttempts: 2 }).generate({ spec, outDir: out, existing: null });
    await expect(p).rejects.toBeInstanceOf(GenerationFailedError);
    await expect(p).rejects.toMatchObject({ exitCode: 5, attempts: 2, attemptDir: path.join(out, ATTEMPT_DIR) });
    expect(await readFile(path.join(out, ATTEMPT_DIR, "server.mjs"), "utf8")).toContain("createServer");
    expect(await readFile(path.join(out, ATTEMPT_DIR, "errors.md"), "utf8")).toContain("실패 단계: contract");
    expect(await calls()).toBe(2);
  }, 30_000);

  it("환경 오류(start 명령을 실행할 수 없음)는 재시도하지 않는다", async () => {
    await respond(1, good());
    await respond(2, good());
    const profile = { ...fakeProfile, start: { command: "no-such-cmd-xyz", args: [] } };
    const p = new LlmGenerator(profile, adapter()).generate({ spec, outDir: out, existing: null });
    await expect(p).rejects.toBeInstanceOf(EnvironmentError);
    await expect(p).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/^Node 22가 필요합니다: /) });
    expect(await calls()).toBe(1);
  }, 30_000);

  it("빌드 로그가 프로필의 환경 오류 패턴에 맞으면 재시도하지 않는다", async () => {
    await respond(1, good());
    const install = { command: process.execPath, args: ["-e", "console.error('Error: JAVA_HOME is not defined correctly'); process.exit(1)"] };
    const profile = { ...fakeProfile, install: () => install, environmentErrors: [/JAVA_HOME/] };
    await expect(new LlmGenerator(profile, adapter()).generate({ spec, outDir: out, existing: null })).rejects.toBeInstanceOf(EnvironmentError);
    expect(await calls()).toBe(1);
  }, 30_000);

  it("증분: 응답에 없는 기존 파일은 유지하고 notes에 적는다", async () => {
    await respond(1, good());
    const existing = { files: [{ path: "lib/util.mjs", content: "export const x = 1;\n", userModified: false }] };
    const r = await new LlmGenerator(fakeProfile, adapter()).generate({ spec, outDir: out, existing });
    expect(r.files.map((f) => f.path).sort()).toEqual(["lib/util.mjs", "server.mjs"]);
    expect(r.notes).toContain("응답에 없어 유지: lib/util.mjs");
    expect(await readFile(path.join(genDir, "prompt-1.txt"), "utf8")).toContain("## 7. 증분 생성");
  }, 30_000);
});
```

- [ ] **Step 3: 실패 확인**

```bash
pnpm vitest run packages/core/test/llmGenerate.test.ts
```
기대: `Failed to load url ../src/generate/errors.js`.

- [ ] **Step 4: 오류 타입**

```ts
// packages/core/src/generate/errors.ts
/** LLM 생성이 maxAttempts 안에 검증을 통과하지 못했다. CLI 종료 코드 5. */
export class GenerationFailedError extends Error {
  readonly exitCode = 5;
  constructor(readonly attempts: number, readonly attemptDir: string, readonly lastErrors: string[]) {
    super(`${attempts}번 시도했지만 검증을 통과하는 mock을 만들지 못했습니다. 마지막 시도: ${attemptDir} (errors.md 참고)`);
    this.name = "GenerationFailedError";
  }
}

/** 재시도해도 소용없는 환경 문제(JDK·네트워크·claude CLI 없음). CLI 종료 코드 1. */
export class EnvironmentError extends Error {
  readonly exitCode = 1;
  constructor(readonly requires: string, readonly detail: string) {
    super(`${requires}가 필요합니다: ${detail}`);
    this.name = "EnvironmentError";
  }
}
```

- [ ] **Step 5: 정적 파일의 실행 권한**

`packages/core/src/generate/generator.ts`의 `LanguageOutput.files` 줄을 바꾼다.

```ts
  /** 언어 종속 파일만. outDir 상대 경로. content가 null이면 삭제(LLM 증분). mode는 실행 권한(mvnw = 0o755). */
  files: { path: string; content: string | null; mode?: number }[];
```

`packages/core/src/generate/scaffold.ts`의 import에 `chmod`를 더하고 `writeLanguageFiles`를 바꾼다.

```ts
import { chmod, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
```

```ts
/** 언어 종속 파일을 순서대로 쓰고(null은 삭제), prune 규칙으로 생성기 소유 디렉터리를 정리한다. */
export async function writeLanguageFiles(outDir: string, output: LanguageOutput, written: string[]): Promise<void> {
  for (const f of output.files) {
    if (f.content === null) await rm(path.join(outDir, f.path), { force: true });
    else {
      await writeOut(outDir, f.path, f.content, written);
      if (f.mode !== undefined) await chmod(path.join(outDir, f.path), f.mode);
    }
  }
  for (const p of output.prune ?? []) {
    const keep = new Set(output.files.filter((f) => f.content !== null && path.posix.dirname(f.path) === p.dir).map((f) => path.posix.basename(f.path)));
    await removeStale(path.join(outDir, p.dir), (name) => name.endsWith(p.ext) && !keep.has(name));
  }
}
```

- [ ] **Step 6: LlmGenerator**

```ts
// packages/core/src/generate/llm.ts
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmAdapter } from "../llm/adapter.js";
import type { MockSpec } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import { verify, verifyFailed, type ContractResult } from "../verify/index.js";
import type { RuntimeCheck } from "../verify/runtime.js";
import { ensureInstalled } from "../verify/server.js";
import { EnvironmentError, GenerationFailedError } from "./errors.js";
import type { GenerateContext, LanguageGenerator, LanguageOutput } from "./generator.js";
import { readLock, writeLock } from "./lock.js";
import type { LanguageProfile } from "./profiles/types.js";
import { buildGenerateRequest, retrySection, type AttemptFailure } from "./request.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { validateOutput } from "./validateOutput.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));

/** 마지막 실패 시도를 남기는 outDir 안 디렉터리. 다음 generate가 지운다. */
export const ATTEMPT_DIR = ".specmock-attempt";

export interface LlmGeneratorOptions {
  maxAttempts?: number;
  /** claude 호출 한 번의 시간 제한. */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

type FileOut = LanguageOutput["files"][number];

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
const SPAWN_FAILURE = /실행할 수 없습니다|시작할 수 없습니다/;

/** 정적 파일(mvnw 등)을 templates/<언어>/에서 읽는다. */
export async function readStaticFiles(profile: LanguageProfile): Promise<FileOut[]> {
  return Promise.all(profile.staticFiles.map(async (s) => ({
    path: s.path,
    content: await readFile(`${TEMPLATES}${profile.language}/${s.path}`, "utf8"),
    ...(s.mode !== undefined ? { mode: s.mode } : {}),
  })));
}

/** 응답 파일 + 응답에 빠진 기존 파일(유지) → 최종 언어 종속 파일 집합. */
function mergeWithExisting(files: FileOut[], ctx: GenerateContext, notes: string[]): FileOut[] {
  const merged = [...files];
  const named = new Set(files.map((f) => f.path));
  for (const e of ctx.existing?.files ?? []) {
    if (named.has(e.path)) continue;
    merged.push({ path: e.path, content: e.content });
    notes.push(`응답에 없어 유지: ${e.path}`);
  }
  return merged;
}

/**
 * 프로필 기반 LLM 생성기. 시도마다: 지시서(+재시도 절) → 모델 호출 → 응답 검증 → 임시 디렉터리에 전체 프로젝트 →
 * install(빌드) → verify(contract + 런타임 계약 7·8). 통과한 파일 집합을 돌려주고 outDir에는 쓰지 않는다(쓰기는 generate가 한다).
 */
export class LlmGenerator implements LanguageGenerator {
  readonly generator = "llm" as const;
  readonly language: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly profile: LanguageProfile, private readonly adapter: LlmAdapter, opts: LlmGeneratorOptions = {}) {
    this.language = profile.language;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.platform = opts.platform ?? process.platform;
  }

  async generate(ctx: GenerateContext): Promise<LanguageOutput> {
    const { profile } = this;
    const request = await buildGenerateRequest({ spec: ctx.spec, profile, outDir: ctx.outDir, existing: ctx.existing });
    const staticFiles = await readStaticFiles(profile);
    const install = profile.install(this.platform);
    const progress = (stage: "generating" | "building" | "verifying", attempt: number, message: string) =>
      ctx.onProgress?.({ stage, attempt, maxAttempts: this.maxAttempts, message });

    let failure: AttemptFailure | null = null;
    let lastFiles: FileOut[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      ctx.signal?.throwIfAborted();
      progress("generating", attempt, `코드 생성 중 (${attempt}/${this.maxAttempts})`);
      const prompt = failure ? `${request.prompt}\n\n${retrySection(failure)}` : request.prompt;
      let raw: unknown;
      try {
        raw = await this.adapter.complete({ prompt, schema: request.outputSchema, signal: ctx.signal, timeoutMs: this.timeoutMs });
      } catch (e) {
        if (isAbort(e)) throw e;
        const message = (e as Error).message;
        if (SPAWN_FAILURE.test(message)) throw new EnvironmentError("Claude Code(claude CLI)", message);
        failure = { attempt, stage: "response", errors: [message], contracts: [], runtime: [] };
        continue;
      }
      const checked = validateOutput(raw, profile);
      if (!checked.ok) {
        failure = { attempt, stage: "response", errors: checked.errors, contracts: [], runtime: [] };
        continue;
      }
      const notes = [...checked.notes];
      const files = mergeWithExisting(checked.files, ctx, notes);
      lastFiles = files;
      const output: LanguageOutput = {
        files: [...files, ...staticFiles],
        install,
        start: profile.start,
        healthPath: profile.healthPath,
        startTimeoutMs: profile.startTimeoutMs,
        installTimeoutMs: profile.installTimeoutMs,
        notes,
        attempts: attempt,
      };
      const result = await this.tryInTemp(ctx.spec, ctx, output, attempt, progress);
      if (result === null) return output;
      failure = result;
    }
    await this.keepAttempt(ctx.outDir, lastFiles, failure!);
    throw new GenerationFailedError(this.maxAttempts, path.join(ctx.outDir, ATTEMPT_DIR), failure!.errors);
  }

  /** 임시 디렉터리에서 빌드·기동·검증. 통과하면 null, 실패하면 다음 시도에 넘길 요약. 환경 오류는 던진다. */
  private async tryInTemp(
    spec: MockSpec, ctx: GenerateContext, output: LanguageOutput, attempt: number,
    progress: (stage: "generating" | "building" | "verifying", attempt: number, message: string) => void,
  ): Promise<AttemptFailure | null> {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "specmock-attempt-"));
    try {
      const sourceFiles: Record<string, string> = {};
      for (const f of output.files) if (f.content !== null) sourceFiles[f.path] = hashText(f.content);
      await writeLanguageFiles(tmp, output, []);
      const s = await writeScaffold(spec, tmp, null, {}, []);
      // 증분이면 사용자의 fixture(수정본 포함)로 검증한다.
      await cp(path.join(ctx.outDir, "fixtures"), path.join(tmp, "fixtures"), { recursive: true, force: true }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      await writeLock(tmp, {
        system: spec.system, language: this.profile.language, generator: "llm",
        mockspecHash: hashJson(spec), generatedAt: new Date().toISOString(),
        install: output.install, start: output.start, healthPath: output.healthPath,
        startTimeoutMs: output.startTimeoutMs, installTimeoutMs: output.installTimeoutMs,
        fixtureHashes: s.fixtureHashes, sourceFiles,
      });
      const lock = (await readLock(tmp))!;

      progress("building", attempt, `빌드 중 (${attempt}/${this.maxAttempts})`);
      try {
        await ensureInstalled(tmp, { lock, signal: ctx.signal });
      } catch (e) {
        if (isAbort(e)) throw e;
        this.throwIfEnvironment((e as Error).message);
        return { attempt, stage: "build", errors: [(e as Error).message], contracts: [], runtime: [] };
      }

      progress("verifying", attempt, `검증 중 (${attempt}/${this.maxAttempts})`);
      const runtime = { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) };
      let result;
      try {
        result = await verify(tmp, { signal: ctx.signal, runtime });
      } catch (e) {
        if (isAbort(e)) throw e;
        this.throwIfEnvironment((e as Error).message);
        return { attempt, stage: "start", errors: [(e as Error).message], contracts: [], runtime: [] };
      }
      if (!verifyFailed(result)) return null;
      const contracts: ContractResult[] = result.results.filter((r) => !r.passed);
      const rt: RuntimeCheck[] = result.runtime.filter((c) => !c.passed);
      return { attempt, stage: "contract", errors: [], contracts, runtime: rt };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private throwIfEnvironment(message: string): void {
    if (SPAWN_FAILURE.test(message) || (this.profile.environmentErrors ?? []).some((re) => re.test(message))) {
      throw new EnvironmentError(this.profile.requires, message);
    }
  }

  /** 마지막 시도의 모델 파일과 오류 요약을 outDir/.specmock-attempt/에 남긴다. */
  private async keepAttempt(outDir: string, files: FileOut[], failure: AttemptFailure): Promise<void> {
    const dir = path.join(outDir, ATTEMPT_DIR);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeLanguageFiles(dir, { files, install: null, start: this.profile.start, healthPath: this.profile.healthPath, notes: [] }, []);
    await writeFile(path.join(dir, "errors.md"), retrySection(failure) + "\n", "utf8");
  }
}
```

`retrySection`은 contract 실패가 없고 errors가 비어도 "실패 단계: contract"와 런타임 계약 줄을 적는다(`request.ts`의 `retrySection` 구현). `verify`는 `startMock`을 거쳐 `ensureInstalled`를 한 번 더 부르지만 앞 단계가 마커를 썼으므로 바로 돌아온다.

- [ ] **Step 7: export**

`packages/core/src/index.ts`의 generate 관련 export 다음에 더한다.

```ts
export { LlmGenerator, ATTEMPT_DIR, type LlmGeneratorOptions } from "./generate/llm.js";
export { GenerationFailedError, EnvironmentError } from "./generate/errors.js";
```

- [ ] **Step 8: 통과 확인**

```bash
pnpm vitest run packages/core/test/llmGenerate.test.ts
```
기대: 7 passed.

- [ ] **Step 9: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core
git commit -m "feat(core): 프로필 기반 LLM 생성기와 시도 루프를 더한다

시도마다 응답 검증 → 임시 디렉터리 빌드 → verify(contract·런타임 계약)를 거치고,
실패 요약을 다음 프롬프트에 붙인다. 환경 오류는 즉시 중단하고 마지막 실패는
.specmock-attempt/에 남긴 뒤 GenerationFailedError(exit 5)를 던진다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: generate()에 LLM 생성기 연결 — 증분·건너뛰기·userModified·attempt 정리·생성 메모

**Files:**
- Modify: `packages/core/src/generate/index.ts`(파일 전체)
- Modify: `packages/core/src/types.ts:136-141`(`GenerateInfoSchema`)
- Modify: `packages/core/src/verify/coverage.ts:9`(시그니처), `:66-68`(끝에 "## 생성 메모")
- Modify: `packages/core/src/service/verify.ts:24-31`(`verifyMock`)
- Modify: `packages/core/src/service/run.ts:65`(language 전달), `RunPipelineOptions`
- Test: `packages/core/test/generateLlm.test.ts`(새 파일)

- [ ] **Step 1: 실패 테스트**

테스트는 `GenerateOptions.profile`로 fake 프로필을 주입한다(등록표에 없는 언어라 `assertLanguage`를 거치지 않는다). 가짜 claude는 `packages/core/test/bin/claude-gen`(`$GEN_DIR/<n>.json`을 차례로 응답)을 쓴다.

```ts
// packages/core/test/generateLlm.test.ts
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { readLock } from "../src/generate/lock.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { verifyMock } from "../src/service/verify.js";
import { GenerateInfoSchema, MockSpecSchema, type MockSpec } from "../src/types.js";
import { hashText } from "../src/util/hash.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");

let dir: string;
let genDir: string;
let out: string;
let ws: Workspace;
const specNow = () => ws.read("petstore", "mockspec.json", MockSpecSchema);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-genllm-"));
  genDir = path.join(dir, "gen");
  out = path.join(dir, "mock");
  await mkdir(genDir);
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const adapter = () => new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
const respond = (n: number, body: unknown) => writeFile(path.join(genDir, `${n}.json`), JSON.stringify(body));
const calls = async () => Number(await readFile(path.join(genDir, "count"), "utf8"));
const opts = () => ({ outDir: out, profile: fakeProfile, adapter: adapter() });
const answer = (spec: MockSpec, extra: { path: string; content: string | null }[] = []) => ({ files: [{ path: "server.mjs", content: fakeServerSource(spec) }, ...extra], notes: ["가정: 인증 없음"] });

describe("generate (LLM 생성기)", () => {
  it("파일·scaffold·lock·generate.json을 쓰고 verify가 통과한다", async () => {
    await respond(1, answer(await specNow()));
    const r = await generate(ws, "petstore", opts());
    expect(r).toMatchObject({ language: "fake", attempts: 1, notes: ["가정: 인증 없음"], skipped: false, userModified: [] });
    expect(r.written).toEqual(expect.arrayContaining(["server.mjs", "fixtures/getPet/200.json", "contracts/getPet.json"]));
    expect(r.launch).toBe(`cd ${out} && node server.mjs`);
    const lock = (await readLock(out))!;
    expect(lock).toMatchObject({ language: "fake", generator: "llm", install: null, startTimeoutMs: 10_000, installTimeoutMs: 10_000 });
    expect(lock.sourceFiles).toEqual({ "server.mjs": hashText(await readFile(path.join(out, "server.mjs"), "utf8")) });
    expect(await ws.read("petstore", "generate.json", GenerateInfoSchema)).toMatchObject({ outDir: out, language: "fake", notes: ["가정: 인증 없음"], attempts: 1 });
    const v = await verifyMock(ws, "petstore");
    expect(v.result.failed + v.result.runtimeFailed).toBe(0);
    expect(v.coverageMarkdown).toContain("## 생성 메모\n\n- 가정: 인증 없음");
  }, 60_000);

  it("mockspec이 같으면 LLM을 부르지 않는다(skipped)", async () => {
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    const r = await generate(ws, "petstore", opts());
    expect(r).toMatchObject({ skipped: true, written: [], attempts: 0, launch: `cd ${out} && node server.mjs` });
    expect(await calls()).toBe(1);
  }, 60_000);

  it("--force면 같은 mockspec이어도 다시 생성한다", async () => {
    const spec = await specNow();
    await respond(1, answer(spec));
    await respond(2, answer(spec));
    await generate(ws, "petstore", opts());
    const r = await generate(ws, "petstore", { ...opts(), force: true });
    expect(r.skipped).toBe(false);
    expect(await calls()).toBe(2);
  }, 60_000);

  it("증분: 기존 소스·사용자 수정을 지시서에 넣고 content:null은 지운다", async () => {
    await respond(1, answer(await specNow(), [{ path: "lib/old.mjs", content: "export {};\n" }]));
    await generate(ws, "petstore", opts());
    await appendFile(path.join(out, "server.mjs"), "// 사용자 메모\n");
    await select(ws, "petstore", ["getPet", "createPet", "listPets"]);
    await respond(2, answer(await specNow(), [{ path: "lib/old.mjs", content: null }]));
    const r = await generate(ws, "petstore", opts());
    const prompt2 = await readFile(path.join(genDir, "prompt-2.txt"), "utf8");
    expect(prompt2).toContain("## 7. 증분 생성");
    expect(prompt2).toContain("### server.mjs (사용자 수정)");
    expect(prompt2).toContain("### lib/old.mjs");
    await expect(access(path.join(out, "lib/old.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(r.userModified).toEqual(["server.mjs"]);
    expect(Object.keys((await readLock(out))!.sourceFiles)).toEqual(["server.mjs"]);
  }, 60_000);

  it(".specmock-attempt/만 있는 디렉터리는 specmock 디렉터리로 보고, 시작할 때 지운다", async () => {
    await mkdir(path.join(out, ".specmock-attempt"), { recursive: true });
    await writeFile(path.join(out, ".specmock-attempt", "errors.md"), "x");
    await respond(1, answer(await specNow()));
    await generate(ws, "petstore", opts());
    await expect(access(path.join(out, ".specmock-attempt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/generateLlm.test.ts
```
기대: 5 failed. 첫 실패는 `expected { language: 'ts', … } to match object { language: 'fake', … }` 계열(아직 `profile` 옵션을 무시하고 TS를 생성한다).

- [ ] **Step 3: GenerateInfoSchema 확장**

```ts
// packages/core/src/types.ts:136-141
/** `.specmock/<system>/generate.json` — 마지막 generate의 출력 위치. verify가 `--dir` 없이 찾을 때 쓴다. */
export const GenerateInfoSchema = z.object({
  outDir: z.string().min(1),
  generatedAt: z.string(),
  /** 3A부터 기록. 옛 파일에는 없다. */
  language: z.string().optional(),
  /** LLM 생성기의 notes. coverage.md "## 생성 메모"에 옮긴다. */
  notes: z.array(z.string()).optional(),
  attempts: z.number().int().nonnegative().optional(),
});
```

- [ ] **Step 4: generate/index.ts 전체**

```ts
// packages/core/src/generate/index.ts
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { LlmAdapter } from "../llm/adapter.js";
import { ClaudeCodeAdapter } from "../llm/claudeCode.js";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import type { ExistingSources, GenerateProgress, GenerateReport, LanguageGenerator } from "./generator.js";
import { matchesAny } from "./glob.js";
import { ATTEMPT_DIR, LlmGenerator } from "./llm.js";
import { launchHint, LOCK_FILE, readLock, writeLock, type Lock } from "./lock.js";
import { assertLanguage, getProfile, type LanguageProfile } from "./profiles/index.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";
import { TsHonoGenerator } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  /** 사용자 수정 fixture 덮어쓰기, 비 specmock 디렉터리 덮어쓰기, 언어 변경, 같은 mockspec 재생성. */
  force?: boolean;
  /** 명시 언어. 없으면 lock.language, 그것도 없으면 "ts". */
  language?: string;
  /** ts가 아닌 언어의 LLM 경로. 기본 claude-code. */
  llm?: "claude-code";
  /** claude-code 모델(--model). adapter를 주면 무시. */
  model?: string;
  /** 테스트·호출자가 어댑터를 직접 줄 때. */
  adapter?: LlmAdapter;
  maxAttempts?: number;
  onProgress?: (e: GenerateProgress) => void;
  signal?: AbortSignal;
  /** 테스트 전용: 등록표 대신 이 프로필로 생성한다(language는 profile.language). */
  profile?: LanguageProfile;
}

export function defaultMockDir(system: string): string {
  return path.resolve("mock", system);
}

/** 비어 있지 않고 specmock이 만든 흔적(lock)이 없는 디렉터리는 force 없이 덮어쓰지 않는다. 실패 시도 디렉터리만 있으면 specmock 것으로 본다. */
async function assertSafeOutDir(outDir: string): Promise<void> {
  const names = (await readdir(outDir).catch(() => [] as string[])).filter((n) => n !== ATTEMPT_DIR);
  if (names.length > 0 && !names.includes(LOCK_FILE)) {
    throw new Error(`${outDir}은(는) specmock이 만든 디렉터리가 아닙니다(${LOCK_FILE} 없음). 덮어쓰려면 --force`);
  }
}

/** --force로 언어를 바꿀 때: fixtures/·contracts/만 남기고 지운다(fixture 보존 규칙은 lock 해시로 계속 동작). */
async function clearForLanguageChange(outDir: string): Promise<void> {
  for (const name of await readdir(outDir).catch(() => [] as string[])) {
    if (name === "fixtures" || name === "contracts" || name === LOCK_FILE) continue;
    await rm(path.join(outDir, name), { recursive: true, force: true });
  }
}

const SKIP_DIRS = new Set(["node_modules", "target", ".git", ATTEMPT_DIR]);

/** outDir 아래 파일의 상대 경로(`/` 구분). 빌드 산출물 디렉터리는 건너뛴다. */
async function listFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...(await listFiles(root, r))); }
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** 증분 입력: sourceGlobs 안·보호 경로 밖·정적 파일 아닌 기존 파일. lock.sourceFiles 해시와 다르면 userModified. */
async function readExisting(outDir: string, profile: LanguageProfile, previous: Lock): Promise<ExistingSources> {
  const statics = new Set(profile.staticFiles.map((s) => s.path));
  const files: ExistingSources["files"] = [];
  for (const rel of await listFiles(outDir)) {
    if (statics.has(rel) || !matchesAny(profile.sourceGlobs, rel) || matchesAny(profile.protectedPaths, rel)) continue;
    const content = await readFile(path.join(outDir, rel), "utf8");
    const recorded = previous.sourceFiles[rel];
    files.push({ path: rel, content, userModified: recorded !== undefined && hashText(content) !== recorded });
  }
  return { files };
}

export async function generate(ws: Workspace, system: string, opts: GenerateOptions = {}): Promise<GenerateReport> {
  return withSystemLock(ws, system, () => generateUnlocked(ws, system, opts));
}

async function generateUnlocked(ws: Workspace, system: string, opts: GenerateOptions): Promise<GenerateReport> {
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
  if (opts.language !== undefined && !opts.profile) assertLanguage(opts.language);
  if (!opts.force) await assertSafeOutDir(outDir);
  const previous = await readLock(outDir);
  const language = opts.profile?.language ?? opts.language ?? previous?.language ?? "ts";
  if (previous && previous.language !== language) {
    if (!opts.force) throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요`);
    await clearForLanguageChange(outDir);
  }
  await rm(path.join(outDir, ATTEMPT_DIR), { recursive: true, force: true });

  const mockspecHash = hashJson(spec);
  const profile = language === "ts" ? null : (opts.profile ?? getProfile(language));
  if (language !== "ts" && !profile) throw new Error(`'${language}' 언어 프로필이 없습니다.`);
  const sameLanguage = previous !== null && previous.language === language;

  // LLM 생성은 비싸다: mockspec이 같으면 다시 부르지 않는다(--force로 강제).
  if (profile && sameLanguage && previous.generator === "llm" && previous.mockspecHash === mockspecHash && !opts.force) {
    await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language, notes: [], attempts: 0 });
    return {
      outDir, language, written: [], preserved: [], orphaned: [],
      launch: launchHint(outDir, previous), attempts: 0, notes: [], userModified: [], skipped: true,
    };
  }

  const existing = profile && sameLanguage && previous.generator === "llm" ? await readExisting(outDir, profile, previous) : null;
  const generator: LanguageGenerator = profile
    ? new LlmGenerator(profile, opts.adapter ?? new ClaudeCodeAdapter({ model: opts.model }), { maxAttempts: opts.maxAttempts })
    : new TsHonoGenerator();
  const output = await generator.generate({ spec, outDir, existing, signal: opts.signal, onProgress: opts.onProgress });

  const written: string[] = [];
  await writeLanguageFiles(outDir, output, written);
  const s = await writeScaffold(spec, outDir, previous, { force: opts.force }, written);
  const sourceFiles: Record<string, string> = {};
  if (profile) {
    const statics = new Set(profile.staticFiles.map((x) => x.path));
    for (const f of output.files) if (f.content !== null && !statics.has(f.path)) sourceFiles[f.path] = hashText(f.content);
  }
  await writeLock(outDir, {
    system: spec.system,
    language,
    generator: generator.generator,
    mockspecHash,
    generatedAt: new Date().toISOString(),
    install: output.install,
    start: output.start,
    healthPath: output.healthPath,
    startTimeoutMs: output.startTimeoutMs,
    installTimeoutMs: output.installTimeoutMs,
    fixtureHashes: s.fixtureHashes,
    sourceFiles,
  });
  const attempts = output.attempts ?? 0;
  // verify가 --dir 없이도 마지막 생성 위치를 찾을 수 있도록 기록한다.
  await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language, notes: output.notes, attempts });
  const userModified = (existing?.files ?? [])
    .filter((e) => e.userModified && output.files.some((o) => o.path === e.path && o.content !== e.content))
    .map((e) => e.path);
  return {
    outDir, language, written, preserved: s.preserved, orphaned: s.orphaned,
    launch: launchHint(outDir, { language, install: output.install, start: output.start }),
    attempts, notes: output.notes, userModified, skipped: false,
  };
}
```

TS 경로는 바뀌지 않는다: `profile`이 null이라 `TsHonoGenerator`, `existing: null`, `sourceFiles: {}`, `startTimeoutMs`·`installTimeoutMs`는 TS 출력에 없어 lock에서 빠진다(zod optional, `JSON.stringify`가 undefined 키를 버린다). `snapshot.test.ts`가 계속 통과해야 한다.

- [ ] **Step 5: coverage.md "## 생성 메모"**

```ts
// packages/core/src/verify/coverage.ts:9
export function renderCoverage(spec: MockSpec, result: VerifyResult | null, notes: string[] = []): string {
```

`return lines.join("\n");` 바로 앞에 넣는다.

```ts
  if (notes.length) {
    lines.push("## 생성 메모");
    lines.push("");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("");
  }
```

```ts
// packages/core/src/service/verify.ts:24-31
export async function verifyMock(ws: Workspace, system: string, opts: { dir?: string; onEvent?: OnEvent; signal?: AbortSignal } = {}): Promise<VerifyMockResult> {
  const dir = await resolveMockDir(ws, system, opts.dir);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const runtime = { notMocked: spec.notMocked, features: spec.features.map((f) => ({ method: f.method, path: f.path })) };
  const result = await verify(dir, { onLog: (message) => opts.onEvent?.({ stage: "verify", message }), signal: opts.signal, runtime });
  // 생성 메모는 마지막 generate가 같은 디렉터리일 때만 붙인다.
  const info = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
  const notes = info && path.resolve(info.outDir) === dir ? (info.notes ?? []) : [];
  const coverageMarkdown = renderCoverage(spec, result, notes);
  const coverageFile = await ws.writeText(system, "coverage.md", coverageMarkdown);
  return { dir, result, coverageFile, coverageMarkdown };
}
```

- [ ] **Step 6: runPipeline이 언어를 넘긴다**

`packages/core/src/service/run.ts`의 `RunPipelineOptions`에 필드를 더하고 :65를 바꾼다.

```ts
  /** 생성 언어. 없으면 lock → ts. */
  language?: string;
  /** ts가 아닌 언어의 claude 시도 횟수. */
  maxAttempts?: number;
  onProgress?: (e: GenerateProgress) => void;
```

```ts
// packages/core/src/service/run.ts:65 (import에 `type GenerateProgress`(../generate/generator.js) 추가)
  const report = await generate(ws, system, { outDir: opts.outDir, language: opts.language, model: opts.model, maxAttempts: opts.maxAttempts, onProgress: opts.onProgress });
```

`RunPipelineOptions.model`은 추출용으로 이미 있다(`grep -n "model" packages/core/src/service/run.ts`로 확인). 생성에도 같은 모델을 쓴다.

- [ ] **Step 7: 통과 확인**

```bash
pnpm vitest run packages/core/test/generateLlm.test.ts packages/core/test/generate.test.ts packages/core/test/snapshot.test.ts packages/core/test/coverage.test.ts
```
기대: 모두 passed.

- [ ] **Step 8: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core
git commit -m "feat(core): generate가 ts 밖의 언어를 LLM 생성기로 만든다

언어 프로필이 있으면 LlmGenerator를 쓰고, 같은 언어의 기존 소스를 증분 입력으로 넘긴다.
lock.sourceFiles로 사용자 수정을 판정하고, mockspec이 같으면 건너뛴다.
generate.json에 language·notes·attempts를 남겨 coverage.md 생성 메모로 옮긴다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 세션 모드 core — `prepareGeneration`·`finalizeGeneration`과 진행 표식

**Files:**
- Create: `packages/core/src/generate/session.ts`
- Modify: `packages/core/src/generate/index.ts`(`assertSafeOutDir`가 진행 표식을 인정, `listFiles`·`readExisting`·`assertSafeOutDir`를 export)
- Modify: `packages/core/src/index.ts`(export 추가)
- Test: `packages/core/test/session.test.ts`(새 파일)

- [ ] **Step 1: 실패 테스트**

```ts
// packages/core/test/session.test.ts
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { readLock } from "../src/generate/lock.js";
import { GenerateRequestSchema } from "../src/generate/request.js";
import { finalizeGeneration, prepareGeneration, SESSION_MARKER } from "../src/generate/session.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { verifyMock } from "../src/service/verify.js";
import { MockSpecSchema } from "../src/types.js";
import { hashJson, hashText } from "../src/util/hash.js";
import { Workspace } from "../src/workspace.js";
import { fakeProfile, fakeServerSource } from "./fakeProfile.js";
import { PETSTORE } from "./helpers.js";

let dir: string;
let out: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-session-"));
  out = path.join(dir, "mock");
  ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "petstore", [PETSTORE]);
  await analyze(ws, "petstore");
  await select(ws, "petstore", ["getPet", "createPet"]);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const prep = () => prepareGeneration(ws, "petstore", { outDir: out, profile: fakeProfile });
const fin = () => finalizeGeneration(ws, "petstore", { profile: fakeProfile });
const spec = () => ws.read("petstore", "mockspec.json", MockSpecSchema);
const put = async (rel: string, content: string) => { await mkdir(path.dirname(path.join(out, rel)), { recursive: true }); await writeFile(path.join(out, rel), content); };

describe("prepareGeneration", () => {
  it("지시서와 진행 표식을 쓰고 다음 할 일을 돌려준다", async () => {
    const r = await prep();
    expect(r).toMatchObject({ mode: "session", outDir: out, language: "fake", reused: false });
    expect(r.requestPath).toBe(ws.file("petstore", "generate-request.json"));
    expect(r.nextSteps.join("\n")).toContain("finalize");
    const req = await ws.read("petstore", "generate-request.json", GenerateRequestSchema);
    expect(req).toMatchObject({ language: "fake", outDir: out, mockspecHash: hashJson(await spec()), protectedHashes: {} });
    expect(JSON.parse(await readFile(path.join(out, SESSION_MARKER), "utf8"))).toEqual({ system: "petstore", language: "fake", mockspecHash: req.mockspecHash });
  });

  it("같은 mockspec이면 지시서를 다시 쓰지 않는다. 진행 표식이 있는 outDir은 force 없이 통과", async () => {
    await prep();
    const before = (await stat(ws.file("petstore", "generate-request.json"))).mtimeMs;
    await put("server.mjs", "// 작성 중\n");
    const r = await prep();
    expect(r.reused).toBe(true);
    expect((await stat(ws.file("petstore", "generate-request.json"))).mtimeMs).toBe(before);
  });
});

describe("finalizeGeneration", () => {
  it("지시서 없음 → no-request", async () => {
    expect(await fin()).toMatchObject({ ok: false, reason: "no-request" });
  });

  it("select가 바뀌면 stale-request", async () => {
    await prep();
    await select(ws, "petstore", ["getPet"]);
    expect(await fin()).toMatchObject({ ok: false, reason: "stale-request", errors: ["select가 바뀌었습니다. generate_mock을 다시 호출하세요"] });
  });

  it("보호 경로에 파일이 생기면 protected-path-modified", async () => {
    await prep();
    await put("server.mjs", fakeServerSource(await spec()));
    await put("fixtures/getPet/200.json", "{}");
    expect(await fin()).toMatchObject({ ok: false, reason: "protected-path-modified", errors: ["fixtures/getPet/200.json"] });
  });

  it("sourceGlobs 안에 파일이 없으면 no-sources", async () => {
    await prep();
    expect(await fin()).toMatchObject({ ok: false, reason: "no-sources" });
  });

  it("파일 수가 maxFiles를 넘으면 too-many-files", async () => {
    await prep();
    await put("server.mjs", "x");
    for (let i = 0; i < 5; i++) await put(`lib/m${i}.mjs`, "x");
    const r = await fin();
    expect(r).toMatchObject({ ok: false, reason: "too-many-files" });
    expect(r.ok === false && r.errors[0]).toBe("파일 6개 > 최대 5개");
  });

  it("성공: scaffold·lock(sourceFiles)을 쓰고 표식을 지우며 verify가 통과한다", async () => {
    await prep();
    const src = fakeServerSource(await spec());
    await put("server.mjs", src);
    const r = await fin();
    expect(r).toMatchObject({ ok: true, outDir: out, warnings: [] });
    expect(r.ok && r.written).toEqual(expect.arrayContaining(["fixtures/getPet/200.json", "contracts/getPet.json"]));
    const lock = (await readLock(out))!;
    expect(lock).toMatchObject({ language: "fake", generator: "llm", install: null, sourceFiles: { "server.mjs": hashText(src) } });
    await expect(access(path.join(out, SESSION_MARKER))).rejects.toMatchObject({ code: "ENOENT" });
    const v = await verifyMock(ws, "petstore");
    expect(v.result.failed + v.result.runtimeFailed).toBe(0);
  }, 60_000);
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/core/test/session.test.ts
```
기대: `Failed to load url ../src/generate/session.js` (파일 없음)로 스위트 전체 실패.

- [ ] **Step 3: generate/index.ts — 진행 표식 인정과 export**

`packages/core/src/generate/index.ts`의 `assertSafeOutDir`를 바꾸고, `listFiles`·`readExisting` 앞에 `export`를 붙인다. 진행 표식 이름은 순환 import를 피하려고 index.ts에 둔다.

```ts
/** 세션 모드 지시서 작성 뒤 outDir에 남기는 표식. finalize가 지운다. */
export const SESSION_MARKER = ".specmock-session.json";

/** 비어 있지 않고 specmock이 만든 흔적(lock 또는 세션 표식)이 없는 디렉터리는 force 없이 덮어쓰지 않는다. 실패 시도 디렉터리만 있으면 specmock 것으로 본다. */
export async function assertSafeOutDir(outDir: string): Promise<void> {
  const names = (await readdir(outDir).catch(() => [] as string[])).filter((n) => n !== ATTEMPT_DIR);
  if (names.length > 0 && !names.includes(LOCK_FILE) && !names.includes(SESSION_MARKER)) {
    throw new Error(`${outDir}은(는) specmock이 만든 디렉터리가 아닙니다(${LOCK_FILE} 없음). 덮어쓰려면 --force`);
  }
}
```

```ts
export async function listFiles(root: string, rel = ""): Promise<string[]> {
```

```ts
export async function readExisting(outDir: string, profile: LanguageProfile, previous: Lock): Promise<ExistingSources> {
```

- [ ] **Step 4: session.ts**

```ts
// packages/core/src/generate/session.ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GenerateInfoSchema, MockSpecSchema } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import type { Workspace } from "../workspace.js";
import { withSystemLock } from "../workspaceLock.js";
import { matchesAny } from "./glob.js";
import { assertSafeOutDir, defaultMockDir, listFiles, readExisting, SESSION_MARKER } from "./index.js";
import { readStaticFiles } from "./llm.js";
import { readLock, writeLock } from "./lock.js";
import { assertLanguage, getProfile, type LanguageProfile } from "./profiles/index.js";
import { buildGenerateRequest, GenerateRequestSchema } from "./request.js";
import { writeLanguageFiles, writeScaffold } from "./scaffold.js";

export { SESSION_MARKER } from "./index.js";
export const REQUEST_FILE = "generate-request.json";

export interface PrepareGenerationOptions {
  outDir?: string;
  force?: boolean;
  /** 생성 언어. 없으면 lock.language. ts는 세션 모드가 필요 없어 거부한다. */
  language?: string;
  /** 테스트 전용 프로필 주입. */
  profile?: LanguageProfile;
}

export interface PrepareGenerationResult {
  mode: "session";
  requestPath: string;
  outDir: string;
  language: string;
  /** 같은 mockspec의 지시서가 이미 있어 다시 쓰지 않았다. */
  reused: boolean;
  nextSteps: string[];
}

export type FinalizeReason = "no-request" | "stale-request" | "protected-path-modified" | "no-sources" | "too-many-files";
export type FinalizeResult =
  | { ok: true; outDir: string; written: string[]; warnings: string[] }
  | { ok: false; reason: FinalizeReason; errors: string[] };

function nextSteps(system: string, requestPath: string, outDir: string, profile: LanguageProfile): string[] {
  const install = profile.install(process.platform);
  return [
    `1. 지시서를 읽는다: ${requestPath} (prompt 필드가 전체 지시다)`,
    `2. ${outDir} 아래 ${profile.sourceGlobs.join(", ")} 범위에만 파일을 쓴다. ${profile.protectedPaths.join(", ")}는 건드리지 않는다.`,
    install ? `3. ${outDir}에서 ${[install.command, ...install.args].join(" ")}로 빌드가 되는지 확인하고 오류를 고친다.` : "3. 빌드 단계는 없다.",
    `4. finalize_generation(system: "${system}") — CLI: specmock generate ${system} --finalize`,
    `5. verify_mock(system: "${system}") — 실패하면 고친 뒤 4~5를 반복한다.`,
  ];
}

/** 보호 경로 파일의 현재 해시(지시서 작성 시점과 finalize 시점 비교용). */
async function protectedHashes(outDir: string, profile: LanguageProfile): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(outDir)) {
    if (matchesAny(profile.protectedPaths, rel)) out[rel] = hashText(await readFile(path.join(outDir, rel), "utf8"));
  }
  return out;
}

/** 세션 모드 1단계: 지시서를 쓰고 정적 파일을 outDir에 둔 뒤 멈춘다. 파일 작성은 대화 속 Claude가 한다. */
export async function prepareGeneration(ws: Workspace, system: string, opts: PrepareGenerationOptions = {}): Promise<PrepareGenerationResult> {
  return withSystemLock(ws, system, async () => {
    const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
    const outDir = path.resolve(opts.outDir ?? defaultMockDir(system));
    if (!opts.force) await assertSafeOutDir(outDir);
    const previous = await readLock(outDir);
    const language = opts.profile?.language ?? opts.language ?? previous?.language;
    if (!language || language === "ts") throw new Error("세션 모드는 ts가 아닌 언어에만 씁니다. ts는 generate_mock(또는 specmock generate)이 바로 만듭니다.");
    if (!opts.profile) assertLanguage(language);
    const profile = opts.profile ?? getProfile(language);
    if (!profile) throw new Error(`'${language}' 언어 프로필이 없습니다.`);
    if (previous && previous.language !== language && !opts.force) {
      throw new Error(`이 디렉터리는 ${previous.language}로 생성됐습니다. 다른 언어로 바꾸려면 --force(기존 소스 삭제) 또는 --out을 쓰세요`);
    }
    const requestPath = ws.file(system, REQUEST_FILE);
    const mockspecHash = hashJson(spec);

    if (await ws.exists(system, REQUEST_FILE)) {
      const old = await ws.read(system, REQUEST_FILE, GenerateRequestSchema);
      if (old.mockspecHash === mockspecHash && old.language === language && old.outDir === outDir) {
        return { mode: "session", requestPath, outDir, language, reused: true, nextSteps: nextSteps(system, requestPath, outDir, profile) };
      }
    }

    const existing = previous && previous.language === language && previous.generator === "llm" ? await readExisting(outDir, profile, previous) : null;
    await mkdir(outDir, { recursive: true });
    await writeLanguageFiles(outDir, { files: await readStaticFiles(profile), install: null, start: profile.start, healthPath: profile.healthPath, notes: [] }, []);
    await writeFile(path.join(outDir, SESSION_MARKER), JSON.stringify({ system, language, mockspecHash }, null, 2) + "\n", "utf8");
    const req = await buildGenerateRequest({ spec, profile, outDir, existing, mockspecHash });
    req.protectedHashes = await protectedHashes(outDir, profile);
    await ws.write(system, REQUEST_FILE, GenerateRequestSchema, req);
    return { mode: "session", requestPath, outDir, language, reused: false, nextSteps: nextSteps(system, requestPath, outDir, profile) };
  });
}

/** 세션 모드 2단계: Claude가 쓴 파일을 확정한다. 컴파일하지 않는다(verify의 일). 실패는 예외가 아니라 ok:false. */
export async function finalizeGeneration(ws: Workspace, system: string, opts: { profile?: LanguageProfile } = {}): Promise<FinalizeResult> {
  return withSystemLock(ws, system, async () => {
    if (!(await ws.exists(system, REQUEST_FILE))) {
      return { ok: false, reason: "no-request", errors: [`${REQUEST_FILE}이 없습니다. generate_mock(language)을 먼저 호출하세요`] };
    }
    const req = await ws.read(system, REQUEST_FILE, GenerateRequestSchema);
    const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
    const mockspecHash = hashJson(spec);
    if (req.mockspecHash !== mockspecHash) {
      return { ok: false, reason: "stale-request", errors: ["select가 바뀌었습니다. generate_mock을 다시 호출하세요"] };
    }
    const profile = opts.profile ?? getProfile(req.language);
    if (!profile) throw new Error(`'${req.language}' 언어 프로필이 없습니다.`);
    const outDir = req.outDir;
    const files = await listFiles(outDir);

    const changed = files.filter((rel) => matchesAny(profile.protectedPaths, rel) && rel !== SESSION_MARKER)
      .filter((rel) => req.protectedHashes[rel] === undefined);
    for (const [rel, hash] of Object.entries(req.protectedHashes)) {
      const now = files.includes(rel) ? hashText(await readFile(path.join(outDir, rel), "utf8")) : null;
      if (now !== hash) changed.push(rel);
    }
    if (changed.length) return { ok: false, reason: "protected-path-modified", errors: changed.sort() };

    const statics = new Set(profile.staticFiles.map((s) => s.path));
    const sources = files.filter((rel) => !statics.has(rel) && rel !== SESSION_MARKER && matchesAny(profile.sourceGlobs, rel) && !matchesAny(profile.protectedPaths, rel));
    if (sources.length === 0) return { ok: false, reason: "no-sources", errors: [`${profile.sourceGlobs.join(", ")} 범위에 파일이 없습니다`] };
    if (sources.length > profile.maxFiles) return { ok: false, reason: "too-many-files", errors: [`파일 ${sources.length}개 > 최대 ${profile.maxFiles}개`] };

    const previous = await readLock(outDir);
    const written: string[] = [];
    const s = await writeScaffold(spec, outDir, previous, {}, written);
    const sourceFiles: Record<string, string> = {};
    for (const rel of sources) sourceFiles[rel] = hashText(await readFile(path.join(outDir, rel), "utf8"));
    await writeLock(outDir, {
      system: spec.system,
      language: profile.language,
      generator: "llm",
      mockspecHash,
      generatedAt: new Date().toISOString(),
      install: profile.install(process.platform),
      start: profile.start,
      healthPath: profile.healthPath,
      startTimeoutMs: profile.startTimeoutMs,
      installTimeoutMs: profile.installTimeoutMs,
      fixtureHashes: s.fixtureHashes,
      sourceFiles,
    });
    await rm(path.join(outDir, SESSION_MARKER), { force: true });
    await ws.write(system, "generate.json", GenerateInfoSchema, { outDir, generatedAt: new Date().toISOString(), language: profile.language, notes: [], attempts: 0 });
    const warnings = [
      ...s.preserved.map((p) => `사용자 수정 fixture 보존: ${p}`),
      ...s.orphaned.map((p) => `선택에서 빠진 fixture가 남아 있음: ${p}`),
    ];
    return { ok: true, outDir, written, warnings };
  });
}
```

`index.ts`가 `session.ts`를 import하지 않으므로 순환은 없다(`session.ts` → `index.ts` 한 방향).

- [ ] **Step 5: core index export**

`packages/core/src/index.ts`의 generate 관련 export 다음에 더한다.

```ts
export { prepareGeneration, finalizeGeneration, REQUEST_FILE, SESSION_MARKER, type PrepareGenerationOptions, type PrepareGenerationResult, type FinalizeResult, type FinalizeReason } from "./generate/session.js";
export { SUPPORTED_LANGUAGES, assertLanguage } from "./generate/profiles/index.js";
```

- [ ] **Step 6: 통과 확인**

```bash
pnpm vitest run packages/core/test/session.test.ts packages/core/test/generateLlm.test.ts packages/core/test/generate.test.ts
```
기대: 모두 passed.

- [ ] **Step 7: 전체 확인과 커밋**

```bash
pnpm typecheck && pnpm test
git add -A packages/core
git commit -m "feat(core): 세션 모드 생성 — 지시서 작성과 finalize

prepareGeneration은 generate-request.json·정적 파일·진행 표식을 쓰고 멈춘다.
finalizeGeneration은 지시서 없음·stale·보호 경로 변경·소스 없음·파일 수 초과를 ok:false로 돌려주고,
통과하면 fixtures·contracts·lock(sourceFiles)을 쓴다. 컴파일은 verify가 한다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: MCP `generate_mock(language)`·`finalize_generation`(도구 12개)과 SKILL.md 세션 절차

**Files:**
- Modify: `packages/mcp/src/names.ts:2-5`
- Modify: `packages/mcp/src/tools/mock.ts`(import, `generate_mock` 등록 전체, `finalize_generation` 추가, `verify_mock` 설명)
- Modify: `packages/mcp/test/tools.test.ts:20,23,205,211`(개수), 새 describe 추가
- Modify: `packages/mcp/test/plugin.test.ts:24`(정규식 접미사)
- Modify: `plugin/skills/specmock/SKILL.md:12`(도구 수), `:26`(표), `:41`(흐름), `:47` 뒤(안전 규칙)

- [ ] **Step 1: 실패 테스트**

`packages/mcp/test/tools.test.ts`의 개수 단정 네 곳을 12로 바꾼다.

```ts
  it("registers exactly TOOL_NAMES (12 tools, no leftovers)", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(12);
  });
```

```ts
    expect((await s.client.listTools()).tools.length).toBe(12);
```
(:205와 :211 두 곳)

파일 끝에 더한다.

```ts
describe("generation tools", () => {
  it("finalize_generation without a request → ok:false no-request (not isError)", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet"] });
    const r = await s.ok("finalize_generation", { system: "petstore" });
    expect(r).toMatchObject({ ok: false, reason: "no-request" });
  });

  it("generate_mock with an unknown language is a tool error listing supported languages", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet"] });
    expect(await s.err("generate_mock", { system: "petstore", language: "cobol" })).toMatch(/'cobol' 언어는 지원하지 않습니다\. 지원 언어: ts/);
  });

  it("generate_mock(ts) reports mode generated and the launch hint", async () => {
    await s.ok("ingest_spec", { system: "petstore", origins: [PETSTORE] });
    await s.ok("analyze_spec", { system: "petstore" });
    await s.ok("select_features", { system: "petstore", exprs: ["getPet"] });
    const g = await s.ok("generate_mock", { system: "petstore", language: "ts" });
    expect(g).toMatchObject({ mode: "generated", language: "ts", outDir: path.join(dir, "mock", "petstore") });
    expect(g.launch).toBe(`cd ${path.join(dir, "mock", "petstore")} && npm install && npm start`);
  });
});
```

`packages/mcp/test/plugin.test.ts:24`:

```ts
    const mentioned = new Set([...docs.matchAll(/`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock|ui|generation))`/g)].map((x) => x[1]!));
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/mcp/test/tools.test.ts packages/mcp/test/plugin.test.ts
```
기대: `expected [ 'analyze_spec', … ] to have a length of 12 but got 11` 등 실패. (`pnpm test`가 아닌 단독 실행이면 `build:mcp`가 돌지 않으므로 plugin.test의 서버 파일 단정은 이전 빌드를 본다. 최종 확인은 Step 6의 `pnpm test`.)

- [ ] **Step 3: names.ts**

```ts
// packages/mcp/src/names.ts:2-5
export const TOOL_NAMES = [
  "ingest_spec", "analyze_spec", "get_chunk", "submit_extraction", "merge_extractions",
  "list_features", "show_feature", "select_features", "generate_mock", "finalize_generation", "verify_mock", "open_ui",
] as const;
```

- [ ] **Step 4: mock.ts — generate_mock과 finalize_generation**

import를 바꾼다.

```ts
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  defaultMockDir, finalizeGeneration, findFeature, generate, listFeatures, prepareGeneration, readLock, select,
  SUPPORTED_LANGUAGES, assertLanguage, verifyMock, type OnEvent, type Workspace,
} from "@specmock/core";
```

`generate_mock` 등록 전체를 바꾼다.

```ts
  server.registerTool("generate_mock", {
    title: "mock 서버 생성",
    description: `선택한 기능으로 mock 서버 프로젝트를 만든다. 언어: ${SUPPORTED_LANGUAGES.join(", ")}(기본 ts, 또는 기존 디렉터리의 언어). ts는 바로 생성한다(mode=generated). ts가 아닌 언어는 지시서(generate-request.json)를 쓰고 멈춘다(mode=session): nextSteps대로 지시서를 읽고 파일을 쓰고 빌드를 확인한 뒤 finalize_generation → verify_mock. 기본 위치 ./mock/<system>/. 사용자가 고친 fixture는 force 없이는 보존한다.`,
    inputSchema: z.object({
      system: SystemArg,
      language: z.string().optional().describe(`생성 언어(${SUPPORTED_LANGUAGES.join(" | ")}). 생략하면 기존 디렉터리의 언어, 없으면 ts`),
      outDir: z.string().optional().describe("출력 디렉터리(프로젝트 루트 기준). 기본 ./mock/<system>"),
      force: z.boolean().optional().describe("사용자가 수정한 fixture도 덮어쓴다. specmock이 만들지 않은(specmock.lock.json 없는) 비어 있지 않은 디렉터리도 덮어쓴다. 언어를 바꿀 때도 필요하다(fixtures·contracts 밖의 기존 소스 삭제). 반드시 사용자에게 경로와 덮어쓸 내용을 알리고 확인받은 뒤에만 true"),
    }),
    outputSchema: z.object({
      mode: z.enum(["generated", "session"]),
      outDir: z.string(),
      language: z.string(),
      written: z.array(z.string()).optional(),
      preserved: z.array(z.string()).optional(),
      orphaned: z.array(z.string()).optional(),
      launch: z.string().optional(),
      skipped: z.boolean().optional(),
      requestPath: z.string().optional(),
      nextSteps: z.array(z.string()).optional(),
    }),
  }, guard(async ({ system, language, outDir, force }) => {
    if (language !== undefined) assertLanguage(language);
    const target = path.resolve(outDir ?? defaultMockDir(system));
    const effective = language ?? (await readLock(target))?.language ?? "ts";
    if (effective !== "ts") {
      const p = await prepareGeneration(ws, system, { outDir, force, language: effective });
      const head = p.reused ? "지시서가 이미 최신입니다" : "지시서를 썼습니다";
      return ok(`${head}: ${p.requestPath}. 출력 위치: ${p.outDir}.\n${p.nextSteps.join("\n")}`, {
        mode: "session" as const, outDir: p.outDir, language: p.language, requestPath: p.requestPath, nextSteps: p.nextSteps,
      });
    }
    const r = await generate(ws, system, { outDir, force, language: "ts" });
    return ok(`생성: ${r.outDir} (파일 ${r.written.length}개, 보존 ${r.preserved.length}, 남겨진 fixture ${r.orphaned.length}). 실행: ${r.launch}. 다음: verify_mock`, {
      mode: "generated" as const, outDir: r.outDir, language: r.language, written: r.written, preserved: r.preserved, orphaned: r.orphaned, launch: r.launch, skipped: r.skipped,
    });
  }));

  server.registerTool("finalize_generation", {
    title: "세션 생성 확정",
    description: "generate_mock(mode=session) 뒤 대화에서 쓴 파일을 확정한다: 보호 경로(fixtures·contracts·lock·wrapper 등) 변경과 파일 범위를 검사하고 fixtures·contracts·lock을 쓴다. 컴파일하지 않는다. ok=false면 reason과 errors를 보고 고친다: stale-request면 generate_mock부터 다시, protected-path-modified면 나열된 파일을 원래대로 되돌린다. 다음: verify_mock",
    inputSchema: z.object({ system: SystemArg }),
    outputSchema: z.object({
      ok: z.boolean(),
      outDir: z.string().optional(),
      written: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional(),
      reason: z.enum(["no-request", "stale-request", "protected-path-modified", "no-sources", "too-many-files"]).optional(),
      errors: z.array(z.string()).optional(),
    }),
  }, guard(async ({ system }) => {
    const r = await finalizeGeneration(ws, system);
    if (r.ok) {
      const warn = r.warnings.length ? ` 경고: ${r.warnings.join("; ")}.` : "";
      return ok(`확정: ${r.outDir} (파일 ${r.written.length}개).${warn} 다음: verify_mock`, r);
    }
    return ok(`확정 거부(${r.reason}): ${r.errors.join("; ")}`, r);
  }));
```

`verify_mock` 등록(:73)의 `description`을 다음으로 바꾼다.

```ts
    description: "mock 서버를 띄워 contract test와 런타임 계약(501·404) 검사를 실행하고 .specmock/<system>/coverage.md를 쓴다. 대상은 dir → 마지막 generate_mock 위치 → ./mock/<system>. lock의 install 단계(npm install, Java는 Maven 빌드)를 필요할 때 자동 실행하므로 처음엔 오래 걸릴 수 있다.",
```

- [ ] **Step 5: SKILL.md**

`plugin/skills/specmock/SKILL.md:12`의 "도구 11개"를 "도구 12개"로 바꾼다. 표(:26)를 두 줄로 바꾼다.

```markdown
| `generate_mock` | mock 서버 생성 (`./mock/<system>/`). `language`(ts·java). java는 지시서를 쓰고 멈춤(`mode: "session"`) |
| `finalize_generation` | 세션에서 쓴 파일 확정(보호 경로·범위 검사, fixtures·contracts·lock 작성). 실패면 `ok: false`와 `reason` |
```

흐름 4(:41) 아래에 더한다.

```markdown
   - 사용자가 TypeScript가 아닌 언어(예: Java)를 원하면 `generate_mock(language: "java")`. `mode: "session"`이 오면 **당신이 직접** 작성한다:
     1. `requestPath`의 지시서(`generate-request.json`)에서 `prompt`를 읽는다. 런타임 계약·TS 참조 구현·Java 규칙·참조 예시가 들어 있다.
     2. `outDir` 아래 `sourceGlobs`(Java: `pom.xml`, `src/**`) 범위에만 파일을 쓴다. `protectedPaths`(fixtures·contracts·lock·`mvnw*`·`.mvn/**`)는 건드리지 않는다.
     3. `outDir`에서 `./mvnw -q -DskipTests package`로 컴파일을 확인하고 오류를 고친다(JDK 17 이상, 첫 실행은 Maven 다운로드로 오래 걸린다).
     4. `finalize_generation` → `verify_mock`. 실패하면 소스를 고치고 `finalize_generation` → `verify_mock`을 다시 한다. `reason: "stale-request"`면 선택이 바뀐 것이므로 `generate_mock`부터 다시.
```

안전 규칙(:47) 뒤에 더한다.

```markdown
- `generate_mock`이 "이 디렉터리는 ts로 생성됐습니다"로 실패하면 언어를 바꾸려는 것이다. `force: true`는 fixtures·contracts 밖의 기존 소스를 지운다고 알리고 확인받은 뒤에만 쓴다. 아니면 `outDir`을 다른 곳으로 준다.
```

- [ ] **Step 6: 통과 확인과 커밋**

```bash
pnpm test
```
기대: 모두 passed(`build:mcp`가 먼저 돌아 plugin.test가 새 서버를 본다).

```bash
pnpm typecheck
git add -A packages/mcp plugin/skills/specmock/SKILL.md
git commit -m "feat(mcp): generate_mock에 language, finalize_generation 추가

ts가 아닌 언어는 지시서를 쓰고 mode=session으로 멈추고, finalize_generation이 확정한다.
도구는 12개. SKILL.md에 세션 생성 절차와 언어 변경 안전 규칙을 적는다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Java 프로필과 Maven Wrapper 정적 파일

**Files:**
- Create: `packages/core/templates/java/mvnw`(실행 권한), `packages/core/templates/java/mvnw.cmd`, `packages/core/templates/java/.mvn/wrapper/maven-wrapper.properties`
- Create: `packages/core/src/generate/profiles/java.ts`
- Test: `packages/core/test/javaProfile.test.ts`(새 파일)

이 Task는 프로필을 등록표(`PROFILES`)에 넣지 않는다. 등록은 실제 기동·검증 테스트가 생기는 Task 14에서 한다(`profiles/index.ts`의 주석 "각 언어는 실제 기동·검증 테스트가 있어야 등록한다").

- [ ] **Step 1: Maven Wrapper 정적 파일 가져오기**

only-script 배포본에서 `mvnw`·`mvnw.cmd`만 쓴다(디버그 스크립트는 버린다). 해시는 "사전 확인 사실"의 값과 같아야 한다.

```bash
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/w.zip" https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper-distribution/3.3.4/maven-wrapper-distribution-3.3.4-only-script.zip
unzip -q "$tmp/w.zip" -d "$tmp/w"
shasum -a 256 "$tmp/w/mvnw" "$tmp/w/mvnw.cmd"
```
기대:
```
cae96cef89ebea3531221f4ae17c23cf8edf67d00eae8306d4186ae1bbed4d02  …/mvnw
46eedb8419bd14fe70d5bb2916d7b6f51806e51b39d5b76a42610384ca929c1c  …/mvnw.cmd
```

```bash
mkdir -p packages/core/templates/java/.mvn/wrapper
cp "$tmp/w/mvnw" "$tmp/w/mvnw.cmd" packages/core/templates/java/
chmod 755 packages/core/templates/java/mvnw
rm -rf "$tmp"
```

`mvnw.cmd`는 CRLF 줄끝이다. git이 바꾸지 않게 루트 `.gitattributes`가 있는지 확인하고(`ls .gitattributes`), 없으면 만든다.

```gitattributes
# .gitattributes
packages/core/templates/java/mvnw text eol=lf
packages/core/templates/java/mvnw.cmd text eol=crlf
```

```properties
# packages/core/templates/java/.mvn/wrapper/maven-wrapper.properties
wrapperVersion=3.3.4
distributionType=only-script
distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.zip
```

A3 확인: `grep -n 'unzip\|tar' packages/core/templates/java/mvnw`. mvnw 3.3.4는 `unzip`이 없으면 `.tar.gz` 배포본으로 바꿔 `tar`로 푼다(`distributionUrl`의 `.zip`을 `.tar.gz`로 치환). 그래서 `unzip`은 필수가 아니다. 이 사실을 Task 18의 README 요구 사항에 반영한다.

- [ ] **Step 2: 실패 테스트**

```ts
// packages/core/test/javaProfile.test.ts
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchesAny } from "../src/generate/glob.js";
import { readStaticFiles } from "../src/generate/llm.js";
import { launchCommand } from "../src/generate/lock.js";
import { javaProfile } from "../src/generate/profiles/java.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const JAVA_TEMPLATES = path.resolve(here, "..", "templates", "java");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("javaProfile", () => {
  it("정적 파일은 mvnw(실행 권한)·mvnw.cmd·wrapper 설정 세 개이고 내용은 3.3.4 only-script 배포본과 같다", async () => {
    const files = await readStaticFiles(javaProfile);
    expect(files.map((f) => f.path)).toEqual(["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties"]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(sha256(byPath["mvnw"]!.content!)).toBe("cae96cef89ebea3531221f4ae17c23cf8edf67d00eae8306d4186ae1bbed4d02");
    expect(sha256(byPath["mvnw.cmd"]!.content!)).toBe("46eedb8419bd14fe70d5bb2916d7b6f51806e51b39d5b76a42610384ca929c1c");
    expect(byPath["mvnw"]!.mode).toBe(0o755);
    expect(byPath["mvnw.cmd"]!).not.toHaveProperty("mode");
    expect(byPath[".mvn/wrapper/maven-wrapper.properties"]!.content).toMatch(/distributionType=only-script/);
    expect(byPath[".mvn/wrapper/maven-wrapper.properties"]!.content).toMatch(/apache-maven-3\.9\.16-bin\.zip/);
    // 템플릿 파일 자체도 실행 권한을 가진다(git이 보존).
    expect((await stat(path.join(JAVA_TEMPLATES, "mvnw"))).mode & 0o111).not.toBe(0);
  });

  it("install은 플랫폼별로 갈린다(Windows는 cmd.exe /c mvnw.cmd)", () => {
    const unix = { command: "./mvnw", args: ["-q", "-DskipTests", "package"] };
    expect(javaProfile.install("darwin")).toEqual(unix);
    expect(javaProfile.install("linux")).toEqual(unix);
    expect(javaProfile.install("win32")).toEqual({ command: "cmd.exe", args: ["/c", "mvnw.cmd", "-q", "-DskipTests", "package"] });
    expect(javaProfile.start).toEqual({ command: "java", args: ["-jar", "target/mock.jar"] });
  });

  it("lock에 기록될 install·start로 실행 안내를 만든다", () => {
    const lock = { language: "java", install: javaProfile.install("darwin"), start: javaProfile.start };
    expect(launchCommand(lock)).toBe("./mvnw -q -DskipTests package && java -jar target/mock.jar");
  });

  it("모델은 pom.xml·src/**만 쓰고 wrapper·fixtures·target은 보호한다", () => {
    for (const p of ["pom.xml", "src/main/java/specmock/petstore/Main.java", "src/main/resources/x.json"]) {
      expect(matchesAny(javaProfile.sourceGlobs, p)).toBe(true);
    }
    for (const p of ["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties", "fixtures/getPet/200.json", "contracts/getPet.json", "specmock.lock.json", ".specmock-installed", "target/mock.jar"]) {
      expect(matchesAny(javaProfile.protectedPaths, p)).toBe(true);
    }
    expect(matchesAny(javaProfile.sourceGlobs, "build.gradle")).toBe(false);
  });

  it("환경 오류(JDK·네트워크)만 재시도 없이 멈추고 컴파일 오류는 재시도 대상이다", () => {
    const env = (log: string) => (javaProfile.environmentErrors ?? []).some((re) => re.test(log));
    expect(env("The JAVA_HOME environment variable is not defined correctly, so mvnw cannot run.")).toBe(true);
    expect(env("The java/javac command does not exist in PATH nor is JAVA_HOME set, so mvnw cannot run.")).toBe(true);
    expect(env("curl: Failed to fetch https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.zip")).toBe(true);
    expect(env("[ERROR] Failed to execute goal … Could not transfer artifact io.javalin:javalin:pom:6.7.0 from/to central")).toBe(true);
    expect(env("java.net.UnknownHostException: repo.maven.apache.org")).toBe(true);
    expect(env("[ERROR] Fatal error compiling: error: release version 17 not supported")).toBe(true);
    expect(env("[ERROR] /x/src/main/java/specmock/petstore/Main.java:[12,5] cannot find symbol")).toBe(false);
  });

  it("규칙·참조·요구 사항이 프롬프트에 들어갈 수 있게 채워져 있다", async () => {
    expect(javaProfile).toMatchObject({
      language: "java", displayName: "Java (Maven + Javalin)", healthPath: "/__specmock/health",
      startTimeoutMs: 60_000, installTimeoutMs: 600_000, maxFiles: 200, requires: "JDK 17 이상과 네트워크(첫 빌드)",
      referenceFiles: ["reference/pom.xml", "reference/Main.java"],
    });
    expect(javaProfile.rules.join("\n")).toMatch(/Javalin 6\.7\.0/);
    expect(javaProfile.rules.join("\n")).toMatch(/target\/mock\.jar/);
    expect(javaProfile.rules.join("\n")).toMatch(/127\.0\.0\.1/);
    expect(await readFile(path.join(JAVA_TEMPLATES, ".mvn", "wrapper", "maven-wrapper.properties"), "utf8")).toMatch(/wrapperVersion=3\.3\.4/);
  });
});
```

- [ ] **Step 3: 실패 확인**

```bash
pnpm vitest run packages/core/test/javaProfile.test.ts
```
기대: FAIL — `Failed to load url ../src/generate/profiles/java.js`(모듈 없음).

- [ ] **Step 4: 프로필 구현**

규칙(프롬프트 5항목)은 설계 §2.5 5항목을 한 줄에 하나씩 옮긴다. 버전은 "사전 확인 사실"의 Maven Central 최신값이다.

```ts
// packages/core/src/generate/profiles/java.ts
import type { LanguageProfile } from "./types.js";

const MVN_ARGS = ["-q", "-DskipTests", "package"];

/** Java 17 + Maven + Javalin. 빌드는 Maven Wrapper(only-script)가 Maven을 내려받아 한다. */
export const javaProfile: LanguageProfile = {
  language: "java",
  displayName: "Java (Maven + Javalin)",
  rules: [
    "Java 17로 컴파일한다(pom.xml의 maven.compiler.release = 17).",
    "의존성은 io.javalin:javalin 6.7.0, com.fasterxml.jackson.core:jackson-databind 2.19.4, com.networknt:json-schema-validator 1.5.9, org.slf4j:slf4j-simple 2.0.20만 쓴다. 다른 라이브러리를 더하지 않는다.",
    "빌드 플러그인은 maven-compiler-plugin 3.15.0과 maven-shade-plugin 3.6.2. finalName은 mock이고 shade가 Main-Class 매니페스트를 가진 target/mock.jar 하나를 만든다.",
    "소스는 패키지 specmock.<system>(영문 소문자·숫자만)에 둔다. 진입점은 그 패키지의 Main 클래스다.",
    "포트는 환경 변수 PORT(없으면 4010), 바인드 주소는 127.0.0.1이다.",
    "요청 검증은 기능별 validation 스키마({params, query, body})를 networknt(Draft 7)로 한다. path·query 값은 스키마의 type(integer·number·boolean)에 맞춰 바꾼 뒤 검증한다. 실패하면 400 {\"error\":\"validation_failed\",\"details\":[...]}.",
    "응답 바디는 요청마다 작업 디렉터리 기준 fixtures/<기능 id>/<status>.json을 읽어 그대로 보낸다(application/json). 204·205는 바디 없이 상태만 보낸다.",
    "GET /__specmock/health는 200 {\"ok\":true,\"system\":<system>,\"features\":<선택 기능 수>}.",
    "notMocked의 method·경로에 맞는 요청은 501 {\"error\":\"not_mocked\",\"feature\":<id>,\"hint\":\"specmock select <system> --add <id> && specmock generate <system>\"}. 그 밖의 경로는 404 {\"error\":\"unknown_path\",\"method\":<method>,\"path\":<path>}.",
    "끝 슬래시는 구분하지 않는다. SIGTERM을 받으면 서버를 멈추고 종료한다.",
    "네트워크 호출·파일 쓰기를 하지 않는다. 파일은 pom.xml과 src/** 아래에만 낸다(mvnw·.mvn·fixtures·contracts는 이미 있다).",
  ],
  staticFiles: [
    { path: "mvnw", mode: 0o755 },
    { path: "mvnw.cmd" },
    { path: ".mvn/wrapper/maven-wrapper.properties" },
  ],
  install: (platform) => platform === "win32"
    ? { command: "cmd.exe", args: ["/c", "mvnw.cmd", ...MVN_ARGS] }
    : { command: "./mvnw", args: [...MVN_ARGS] },
  start: { command: "java", args: ["-jar", "target/mock.jar"] },
  healthPath: "/__specmock/health",
  startTimeoutMs: 60_000,
  installTimeoutMs: 600_000,
  sourceGlobs: ["pom.xml", "src/**"],
  protectedPaths: ["fixtures/**", "contracts/**", "specmock.lock.json", ".specmock-installed", "mvnw*", ".mvn/**", "target/**"],
  maxFiles: 200,
  requires: "JDK 17 이상과 네트워크(첫 빌드)",
  referenceFiles: ["reference/pom.xml", "reference/Main.java"],
  environmentErrors: [
    /JAVA_HOME environment variable is not defined correctly/,
    /java\/javac command does not exist/,
    /Failed to fetch https?:/,
    /UnknownHostException/,
    /Could not transfer artifact/,
    /release version 17 not supported|invalid target release/,
  ],
};
```

- [ ] **Step 5: 통과 확인과 커밋**

```bash
pnpm vitest run packages/core/test/javaProfile.test.ts
```
기대: 6 passed. `templates/java/reference/`가 아직 없어도 이 테스트는 참조 파일을 읽지 않으므로 통과한다.

```bash
pnpm typecheck && pnpm test
git add -A packages/core/templates/java packages/core/src/generate/profiles/java.ts packages/core/test/javaProfile.test.ts .gitattributes
git commit -m "feat(core): Java 프로필과 Maven Wrapper 정적 파일

mvnw 3.3.4 only-script(Maven 3.9.16)를 templates/java에 두고, 플랫폼별 install,
보호 경로, 환경 오류 패턴을 가진 javaProfile을 만든다. 등록은 다음 Task에서.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Java 참조 mock·참조 발췌·JDK 게이트 테스트, 등록표에 java 등록

**Files:**
- Create: `packages/core/test/fixtures/java-petstore/pom.xml`, `packages/core/test/fixtures/java-petstore/src/main/java/specmock/petstore/Main.java`
- Create: `packages/core/templates/java/reference/pom.xml`, `packages/core/templates/java/reference/Main.java`(위 두 파일의 복사본)
- Modify: `packages/core/src/generate/profiles/index.ts`(`PROFILES`에 `java`)
- Modify: `packages/core/test/lock.test.ts`(지원 언어 단정), `packages/mcp/test/tools.test.ts`(지원 언어 단정)
- Test: `packages/core/test/java.test.ts`(새 파일, JDK 게이트), `packages/core/test/javaProfile.test.ts`(참조 발췌 동일성)

참조 mock은 런타임 계약(설계 §3.3)의 **정답지**다. Petstore에서 `getPet`·`createPet`를 고른 mockspec(아래 값)에 맞춰 손으로 쓴다. 이 Task에서 열린 가정 A1·A2를 실제 빌드로 확인한다.

Petstore 선택(`getPet`, `createPet`)의 mockspec 값(`dist`로 확인한 값):
- `createPet`: `POST /pets`, 정상 status 201, body 있음. validation: `{"type":"object","properties":{"params":{"type":"object","properties":{},"required":[]},"query":{"type":"object","properties":{},"required":[]},"body":{"type":"object","required":["name"],"properties":{"name":{"type":"string"},"tag":{"type":"string"}}}},"required":["body"]}`
- `getPet`: `GET /pets/{petId}`, 정상 status 200. validation: `{"type":"object","properties":{"params":{"type":"object","properties":{"petId":{"type":"integer"}},"required":["petId"]},"query":{"type":"object","properties":{},"required":[]},"body":{}},"required":[]}`
- `notMocked`: `listPets GET /pets`, `deletePet DELETE /pets/{petId}`, `inventory.list GET /store/inventory`.
- contracts는 3개: `createPet` 정상·필수 값 누락(400), `getPet` 정상.

- [ ] **Step 1: 참조 mock의 pom.xml**

```xml
<!-- packages/core/test/fixtures/java-petstore/pom.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>specmock</groupId>
  <artifactId>petstore-mock</artifactId>
  <version>0.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>io.javalin</groupId>
      <artifactId>javalin</artifactId>
      <version>6.7.0</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.19.4</version>
    </dependency>
    <dependency>
      <groupId>com.networknt</groupId>
      <artifactId>json-schema-validator</artifactId>
      <version>1.5.9</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-simple</artifactId>
      <version>2.0.20</version>
    </dependency>
  </dependencies>

  <build>
    <finalName>mock</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.15.0</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-shade-plugin</artifactId>
        <version>3.6.2</version>
        <executions>
          <execution>
            <phase>package</phase>
            <goals><goal>shade</goal></goals>
            <configuration>
              <createDependencyReducedPom>false</createDependencyReducedPom>
              <transformers>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                  <mainClass>specmock.petstore.Main</mainClass>
                </transformer>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ServicesResourceTransformer"/>
              </transformers>
              <filters>
                <filter>
                  <artifact>*:*</artifact>
                  <excludes>
                    <exclude>META-INF/*.SF</exclude>
                    <exclude>META-INF/*.DSA</exclude>
                    <exclude>META-INF/*.RSA</exclude>
                  </excludes>
                </filter>
              </filters>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
```

`<?xml …?>` 선언은 파일 첫 줄이어야 하므로 위 블록의 첫 줄 주석은 파일에 넣지 않는다.

- [ ] **Step 2: 참조 mock의 Main.java**

```java
// packages/core/test/fixtures/java-petstore/src/main/java/specmock/petstore/Main.java
package specmock.petstore;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.HandlerType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** specmock이 생성한 Petstore mock. fixtures/<기능 id>/<status>.json 을 요청마다 읽는다. */
public final class Main {
  private static final String SYSTEM = "petstore";
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final JsonSchemaFactory SCHEMAS = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V7);

  record Route(String id, String method, String path, int status, boolean hasBody, String schema) {}
  record Missing(String id, String method, String path) {}

  private static final List<Route> ROUTES = List.of(
      new Route("createPet", "POST", "/pets", 201, true, """
          {"type":"object","properties":{"params":{"type":"object","properties":{},"required":[]},"query":{"type":"object","properties":{},"required":[]},"body":{"type":"object","required":["name"],"properties":{"name":{"type":"string"},"tag":{"type":"string"}}}},"required":["body"]}
          """),
      new Route("getPet", "GET", "/pets/{petId}", 200, false, """
          {"type":"object","properties":{"params":{"type":"object","properties":{"petId":{"type":"integer"}},"required":["petId"]},"query":{"type":"object","properties":{},"required":[]},"body":{}},"required":[]}
          """));

  private static final List<Missing> NOT_MOCKED = List.of(
      new Missing("listPets", "GET", "/pets"),
      new Missing("deletePet", "DELETE", "/pets/{petId}"),
      new Missing("inventory.list", "GET", "/store/inventory"));

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "4010"));
    Javalin app = Javalin.create(config -> config.showJavalinBanner = false);
    app.get("/__specmock/health", ctx -> {
      ObjectNode body = JSON.createObjectNode().put("ok", true).put("system", SYSTEM).put("features", ROUTES.size());
      send(ctx, 200, body);
    });
    for (Route r : ROUTES) {
      JsonSchema schema = SCHEMAS.getSchema(r.schema());
      JsonNode shape = JSON.readTree(r.schema());
      app.addHttpHandler(HandlerType.valueOf(r.method()), r.path(), ctx -> handle(ctx, r, schema, shape));
    }
    app.error(404, Main::notMocked);
    Runtime.getRuntime().addShutdownHook(new Thread(app::stop));
    app.start("127.0.0.1", port);
  }

  private static void handle(Context ctx, Route r, JsonSchema schema, JsonNode shape) throws Exception {
    ObjectNode data = JSON.createObjectNode();
    ObjectNode params = data.putObject("params");
    for (Map.Entry<String, String> e : ctx.pathParamMap().entrySet()) {
      params.set(e.getKey(), coerce(shape, "params", e.getKey(), e.getValue()));
    }
    ObjectNode query = data.putObject("query");
    for (Map.Entry<String, List<String>> e : ctx.queryParamMap().entrySet()) {
      if (!e.getValue().isEmpty()) query.set(e.getKey(), coerce(shape, "query", e.getKey(), e.getValue().get(0)));
    }
    if (r.hasBody() && !ctx.body().isBlank()) {
      try { data.set("body", JSON.readTree(ctx.body())); } catch (Exception invalid) { /* 잘못된 JSON은 바디 없음으로 본다 */ }
    }
    Set<ValidationMessage> errors = schema.validate(data);
    if (!errors.isEmpty()) {
      ObjectNode body = JSON.createObjectNode().put("error", "validation_failed");
      ArrayNode details = body.putArray("details");
      for (ValidationMessage m : errors) details.addObject().put("message", m.getMessage());
      send(ctx, 400, body);
      return;
    }
    if (r.status() == 204 || r.status() == 205) { ctx.status(r.status()); return; }
    ctx.status(r.status()).contentType("application/json")
        .result(Files.readString(Path.of("fixtures", r.id(), r.status() + ".json")));
  }

  /** path·query 값은 문자열로 온다. 스키마의 type에 맞춰 바꾼다(TS 템플릿의 ajv coerceTypes와 같은 효과). */
  private static JsonNode coerce(JsonNode shape, String part, String key, String raw) {
    String pointer = "/properties/" + part + "/properties/" + key.replace("~", "~0").replace("/", "~1") + "/type";
    String type = shape.at(pointer).asText("");
    try {
      if (type.equals("integer")) return JSON.getNodeFactory().numberNode(Long.parseLong(raw));
      if (type.equals("number")) return JSON.getNodeFactory().numberNode(Double.parseDouble(raw));
    } catch (NumberFormatException keep) { /* 문자열로 두어 검증이 실패하게 한다 */ }
    if (type.equals("boolean") && (raw.equals("true") || raw.equals("false"))) return JSON.getNodeFactory().booleanNode(raw.equals("true"));
    return JSON.getNodeFactory().textNode(raw);
  }

  private static void notMocked(Context ctx) throws Exception {
    String method = ctx.method().name();
    String path = ctx.path();
    for (Missing m : NOT_MOCKED) {
      if (m.method().equals(method) && toRegex(m.path()).matcher(path).matches()) {
        ObjectNode body = JSON.createObjectNode().put("error", "not_mocked").put("feature", m.id())
            .put("hint", "specmock select " + SYSTEM + " --add " + m.id() + " && specmock generate " + SYSTEM);
        send(ctx, 501, body);
        return;
      }
    }
    send(ctx, 404, JSON.createObjectNode().put("error", "unknown_path").put("method", method).put("path", path));
  }

  private static Pattern toRegex(String template) {
    StringBuilder re = new StringBuilder("^");
    for (String part : template.split("(?=\\{)|(?<=\\})")) {
      re.append(part.startsWith("{") ? "[^/]+" : Pattern.quote(part));
    }
    return Pattern.compile(re.append("/?$").toString());
  }

  private static void send(Context ctx, int status, ObjectNode body) throws Exception {
    ctx.status(status).contentType("application/json").result(JSON.writeValueAsString(body));
  }
}
```

설계 메모:
- Javalin의 경로 변수 문법 `{petId}`는 OpenAPI와 같아 그대로 등록한다. 끝 슬래시는 Javalin 기본값(`ignoreTrailingSlashes = true`)으로 구분하지 않는다.
- `DELETE /pets/1`처럼 경로는 있고 method가 없는 요청도 Javalin 기본값(`prefer405over404 = false`)에서는 404가 되어 `app.error(404, …)`로 들어온다. 그래서 501 판정이 이 한 곳에서 된다.
- 첫 줄 주석(`// packages/…`)은 실제 파일에 넣지 않는다(package 선언이 첫 문장이어야 하는 건 아니지만 참조 발췌가 프롬프트에 들어가므로 경로 주석이 혼동을 준다).

- [ ] **Step 3: 손 빌드로 A1·A2 확인 (JDK 있는 기기)**

```bash
tmp=$(mktemp -d)
cp -R packages/core/test/fixtures/java-petstore/. "$tmp/"
cp -R packages/core/templates/java/mvnw packages/core/templates/java/mvnw.cmd packages/core/templates/java/.mvn "$tmp/"
mkdir -p "$tmp/fixtures/getPet" "$tmp/fixtures/createPet"
echo '{"id":1,"name":"doggie"}' > "$tmp/fixtures/getPet/200.json"
echo '{"id":2,"name":"cat"}' > "$tmp/fixtures/createPet/201.json"
(cd "$tmp" && ./mvnw -q -DskipTests package && ls -la target/mock.jar)
(cd "$tmp" && PORT=4399 java -jar target/mock.jar & echo $! > "$tmp/pid")
sleep 3
curl -s localhost:4399/__specmock/health; echo
curl -s localhost:4399/pets/1; echo
curl -s -o /dev/null -w '%{http_code}\n' localhost:4399/pets/abc
curl -s -X POST -H 'content-type: application/json' -d '{"name":"x"}' localhost:4399/pets; echo
curl -s -w ' %{http_code}\n' -X POST localhost:4399/pets
curl -s -w ' %{http_code}\n' -X DELETE localhost:4399/pets/1
curl -s -w ' %{http_code}\n' localhost:4399/nope
kill "$(cat "$tmp/pid")"; rm -rf "$tmp"
```
기대:
```
{"ok":true,"system":"petstore","features":2}
{"id":1,"name":"doggie"}
400
{"id":2,"name":"cat"}
{"error":"validation_failed","details":[{"message":"$: required property 'body' not found"}]} 400
{"error":"not_mocked","feature":"deletePet","hint":"specmock select petstore --add deletePet && specmock generate petstore"} 501
{"error":"unknown_path","method":"GET","path":"/nope"} 404
```
(400 details의 문구는 networknt 버전에 따라 다를 수 있다. 상태 코드와 `error`만 본다.)

- A1이 깨지면(컴파일 오류 `cannot find symbol: method addHttpHandler`, 또는 501 대신 Javalin 기본 404 문구) `Javalin.create(config -> { config.showJavalinBanner = false; config.router.mount(router -> { for (Route r : ROUTES) router.addHttpHandler(…); }); })`로 옮기고, `app.error(404, …)` 대신 `config.router.mount` 안에서 `router.error(404, …)`가 있는지 확인한다. 바꾼 결과를 참조 mock과 아래 발췌에 같이 반영한다.
- A2가 깨지면(OpenAPI 유래 `format: int64` 등에서 예외) `SCHEMAS.getSchema(r.schema(), SchemaValidatorsConfig.builder().formatAssertionsEnabled(false).build())`로 바꾼다(import `com.networknt.schema.SchemaValidatorsConfig`).
- A3은 Task 13 Step 1에서 해소했다(`unzip`이 없으면 mvnw가 `tar`로 푼다).

- [ ] **Step 4: 참조 발췌를 templates로 복사**

프롬프트 6항목은 배포되는 `templates/java/reference/`에서 읽는다(결정 사항 8). 참조 mock과 바이트 단위로 같게 둔다.

```bash
mkdir -p packages/core/templates/java/reference
cp packages/core/test/fixtures/java-petstore/pom.xml packages/core/templates/java/reference/pom.xml
cp packages/core/test/fixtures/java-petstore/src/main/java/specmock/petstore/Main.java packages/core/templates/java/reference/Main.java
```

`packages/core/test/javaProfile.test.ts`의 describe 안에 더한다(import에 `../src/generate/profiles/index.js`의 `SUPPORTED_LANGUAGES, getProfile` 추가).

```ts
  it("참조 발췌는 참조 mock과 같은 내용이다(프롬프트의 예시가 실제로 빌드·검증되는 코드)", async () => {
    const FIXTURE = path.resolve(here, "fixtures", "java-petstore");
    expect(await readFile(path.join(JAVA_TEMPLATES, "reference", "pom.xml"), "utf8")).toBe(await readFile(path.join(FIXTURE, "pom.xml"), "utf8"));
    expect(await readFile(path.join(JAVA_TEMPLATES, "reference", "Main.java"), "utf8"))
      .toBe(await readFile(path.join(FIXTURE, "src", "main", "java", "specmock", "petstore", "Main.java"), "utf8"));
  });

  it("java는 등록표에 있다", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["ts", "java"]);
    expect(getProfile("java")).toBe(javaProfile);
  });
```

- [ ] **Step 5: JDK 게이트 통합 테스트(실패 테스트)**

가짜 claude(`claude-gen`)가 참조 mock의 두 파일을 응답으로 돌려주게 해서 `generate(language:"java")`의 전 흐름(정적 파일 → 임시 디렉터리 빌드 → 기동 → contract·런타임 계약 → outDir 반영)과 `verifyMock`을 실제 JDK로 돌린다. JDK가 없으면 skip하고 이유를 출력한다(제약). 첫 실행은 Maven과 의존성을 내려받아 수 분 걸리므로 테스트별 타임아웃을 15분으로 둔다.

```ts
// packages/core/test/java.test.ts
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { generate } from "../src/generate/index.js";
import { ingest } from "../src/ingest/index.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { select } from "../src/select/index.js";
import { verifyMock } from "../src/service/verify.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const FIXTURE = path.join(here, "fixtures", "java-petstore");
const MAIN = "src/main/java/specmock/petstore/Main.java";

const javaVersion = await promisify(execFile)("java", ["-version"]).then((r) => r.stderr.split("\n")[0]!.trim(), () => null);
if (!javaVersion) console.warn("[java.test] skip: `java -version` 실패 — JDK 17 이상이 PATH에 없습니다.");
else console.info(`[java.test] ${javaVersion}`);

describe.skipIf(!javaVersion)("Java 생성 (JDK·네트워크 필요)", () => {
  let dir: string;
  let genDir: string;
  let out: string;
  let ws: Workspace;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "specmock-java-"));
    genDir = path.join(dir, "gen");
    out = path.join(dir, "mock", "petstore");
    await mkdir(genDir);
    ws = new Workspace(path.join(dir, ".specmock"));
    await ingest(ws, "petstore", [PETSTORE]);
    await analyze(ws, "petstore");
    await select(ws, "petstore", ["getPet", "createPet"]);
    const files = [
      { path: "pom.xml", content: await readFile(path.join(FIXTURE, "pom.xml"), "utf8") },
      { path: MAIN, content: await readFile(path.join(FIXTURE, MAIN), "utf8") },
    ];
    await writeFile(path.join(genDir, "1.json"), JSON.stringify({ files, notes: ["참조 mock"] }));
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("참조 소스로 generate(java)가 한 번에 통과하고 verify도 통과한다", async () => {
    const progress: string[] = [];
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
    const r = await generate(ws, "petstore", {
      outDir: out, language: "java", adapter,
      onProgress: (e) => progress.push(`${e.stage} ${e.attempt}/${e.maxAttempts}`),
    });
    expect(r).toMatchObject({ language: "java", attempts: 1, skipped: false, notes: ["참조 mock"] });
    expect(r.launch).toBe(`cd ${out} && ./mvnw -q -DskipTests package && java -jar target/mock.jar`);
    expect(progress).toEqual(["generating 1/3", "building 1/3", "verifying 1/3"]);
    for (const f of ["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties", "pom.xml", MAIN, "fixtures/getPet/200.json", "specmock.lock.json"]) {
      await access(path.join(out, f));
    }

    const v = await verifyMock(ws, "petstore");
    expect(v.result).toMatchObject({ total: 3, failed: 0, runtimeFailed: 0 });
    expect(v.result.runtime.map((c) => [c.id, c.passed, c.skipped])).toEqual([["not_mocked", true, false], ["unknown_path", true, false]]);
  }, 900_000);

  it("mockspec이 같으면 다시 부르지 않고 건너뛴다", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-gen"), env: { GEN_DIR: genDir } });
    const r = await generate(ws, "petstore", { outDir: out, language: "java", adapter });
    expect(r).toMatchObject({ skipped: true, attempts: 0 });
    expect(await readFile(path.join(genDir, "count"), "utf8")).toBe("1");
  });
});
```

- [ ] **Step 6: 실패 확인**

```bash
java -version
pnpm vitest run packages/core/test/java.test.ts packages/core/test/javaProfile.test.ts
```
기대: java.test는 FAIL — `'java' 언어는 지원하지 않습니다. 지원 언어: ts`(등록 전). javaProfile.test의 "java는 등록표에 있다"도 FAIL(`["ts"]`). JDK가 없는 기기라면 java.test는 `skip: \`java -version\` 실패` 경고와 함께 skipped로 나온다. 이 Task는 JDK 있는 기기에서 진행한다.

- [ ] **Step 7: 등록**

```ts
// packages/core/src/generate/profiles/index.ts (import와 PROFILES만 바꾼다)
import { javaProfile } from "./java.js";
import type { LanguageProfile } from "./types.js";

/** LLM으로 생성하는 언어의 프로필. 비어 있으면 ts만 지원한다. */
const PROFILES: Record<string, LanguageProfile> = { java: javaProfile };
```

지원 언어 단정을 정확한 목록으로 좁힌다(부분 문자열이라 지금도 통과하지만 목록 변화를 잡게).

```ts
// packages/core/test/lock.test.ts ("모르는 언어는 지원 언어 목록과 함께 거부하고 아무것도 쓰지 않는다")
    await expect(generate(ws, "petstore", { outDir: out, language: "cobol" })).rejects.toThrow("'cobol' 언어는 지원하지 않습니다. 지원 언어: ts, java");
```

```ts
// packages/mcp/test/tools.test.ts ("generate_mock with an unknown language …")
    expect(await s.err("generate_mock", { system: "petstore", language: "cobol" })).toMatch(/'cobol' 언어는 지원하지 않습니다\. 지원 언어: ts, java/);
```

- [ ] **Step 8: 통과 확인과 커밋**

```bash
pnpm vitest run packages/core/test/java.test.ts packages/core/test/javaProfile.test.ts packages/core/test/lock.test.ts
```
기대: java.test 2 passed(첫 실행 수 분), 출력에 `[java.test] openjdk version "17…"`. javaProfile.test 8 passed.

```bash
pnpm typecheck && pnpm test
git add -A packages/core packages/mcp/test/tools.test.ts
git commit -m "feat(core): Java 참조 mock과 java 언어 등록

Petstore용 Javalin 참조 mock(런타임 계약 정답지)을 test/fixtures에 두고 같은 내용을
templates/java/reference에 프롬프트 예시로 둔다. JDK가 있으면 generate(java)→verify를
실제로 돌리고, 없으면 이유를 출력하고 skip한다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: CLI `generate --lang/--llm/--model/--max-attempts/--finalize`, `run --lang`, 종료 코드 5

**Files:**
- Modify: `packages/cli/src/commands/generate.ts`(파일 전체)
- Modify: `packages/cli/src/commands/run.ts:5,14,22,28-31`
- Modify: `packages/cli/src/context.ts`(`parseAttempts`, `formatGenerate`에 시도·notes·변경 없음)
- Modify: `packages/cli/src/cli.ts`(마지막 catch의 종료 코드)
- Modify: `plugin/skills/specmock/SKILL.md` §4(:102-106 bash 블록), :112(run 안내)
- Test: `packages/cli/test/cli.test.ts`(describe "Phase 3A CLI" 추가)

설계 §4.1: `--llm` 기본은 `claude-code`이고 ts에는 영향이 없다. 언어는 `--lang` > lock.language > ts(core가 정한다). 종료 코드 0 성공 · 1 입력/환경 오류 · 2 verify 실패 · **5** LLM 생성이 maxAttempts 안에 통과하지 못함. 종료 코드 5는 core의 `GenerationFailedError.exitCode`를 `cli.ts`의 공통 catch가 읽어 낸다(`generate`와 `run` 둘 다 이 catch로 끝난다).

- [ ] **Step 1: 실패 테스트**

`packages/cli/test/cli.test.ts` 파일 끝에 더한다(`withClaude`·`FAKE_BIN`은 같은 파일의 "Phase 1B CLI" 위에 있다).

```ts
describe("Phase 3A CLI", () => {
  async function selected() {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "getPet,createPet");
  }

  it("generate --lang cobol은 지원 언어 목록과 함께 종료 코드 1", async () => {
    await selected();
    await expect(specmock("generate", "petstore", "--lang", "cobol")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("'cobol' 언어는 지원하지 않습니다. 지원 언어: ts, java"),
    });
  });

  it("generate는 모르는 --llm과 잘못된 --max-attempts를 거부한다", async () => {
    await selected();
    await expect(specmock("generate", "petstore", "--lang", "java", "--llm", "gpt")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("알 수 없는 LLM 어댑터: gpt (claude-code, session)") });
    await expect(specmock("generate", "petstore", "--lang", "java", "--max-attempts", "0")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--max-attempts는 1 이상의 정수") });
  });

  it("generate --lang java가 maxAttempts 안에 통과하지 못하면 종료 코드 5와 attempt 위치를 알린다", async () => {
    await selected();
    const env = await withClaude("claude-fail");
    await expect(run(TSX, [CLI, "generate", "petstore", "--lang", "java", "--max-attempts", "2"], env)).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringMatching(/코드 생성 중 \(1\/2\)[\s\S]*코드 생성 중 \(2\/2\)[\s\S]*2번 시도했지만 검증을 통과하는 mock을 만들지 못했습니다\. 마지막 시도: .*\.specmock-attempt/),
    });
    // 실패한 시도는 outDir에 소스·lock을 남기지 않는다.
    await expect(readFile(path.join(dir, "mock", "petstore", "specmock.lock.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("generate --lang java --llm session은 지시서를 쓰고 다음 단계를 안내한다. --json은 같은 정보", async () => {
    await selected();
    const { stdout } = await specmock("generate", "petstore", "--lang", "java", "--llm", "session");
    expect(stdout).toContain(path.join(dir, ".specmock", "petstore", "generate-request.json"));
    expect(stdout).toContain("specmock generate petstore --finalize");
    const j = JSON.parse((await specmock("generate", "petstore", "--lang", "java", "--llm", "session", "--json")).stdout);
    expect(j).toMatchObject({ mode: "session", language: "java", reused: true, outDir: path.join(dir, "mock", "petstore") });
  });

  it("generate --finalize는 지시서가 없으면 reason과 함께 종료 코드 1", async () => {
    await selected();
    await expect(specmock("generate", "petstore", "--finalize")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("확정 거부(no-request)") });
  });

  it("generate(ts) --json은 attempts·notes·userModified·skipped·launch를 싣는다. ts는 같은 mockspec이어도 건너뛰지 않는다", async () => {
    await selected();
    const first = JSON.parse((await specmock("generate", "petstore", "--json")).stdout);
    expect(first).toMatchObject({ language: "ts", attempts: 0, notes: [], userModified: [], skipped: false, launch: `cd ${path.join(dir, "mock", "petstore")} && npm install && npm start` });
    const { stdout } = await specmock("generate", "petstore");
    expect(stdout).toContain("생성 완료");
    expect(stdout).not.toContain("변경 없음");
  });

  it("run --lang cobol은 파이프라인 전에 종료 코드 1", async () => {
    await expect(specmock("run", "petstore", PETSTORE, "--lang", "cobol", "--no-verify")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("지원 언어: ts, java") });
    await expect(readdir(path.join(dir, ".specmock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

건너뛰기(`skipped:true`)는 Task 10 `generate`에서 lock의 `generator === "llm"`이고 언어·mockspecHash가 같고 `--force`가 없을 때만 일어난다. ts는 템플릿이라 늘 다시 쓴다. "변경 없음" 출력은 Task 16의 web 테스트와 Task 14의 `java.test.ts`(두 번째 테스트)가 확인한다.

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/cli/test/cli.test.ts -t "Phase 3A CLI"
```
기대: 6개 FAIL, ts `--json` 테스트 1개는 Task 10에서 이미 통과. 실패 예: `'cobol' 언어는 아직 지원하지 않습니다. (ts만 가능)`(옛 문구), `error: unknown option '--llm'`, 종료 코드 5 대신 1.

- [ ] **Step 3: 공통 출력과 종료 코드**

```ts
// packages/cli/src/context.ts (fail 아래에 더한다)
/** --max-attempts 값. 1 이상의 정수가 아니면 종료 코드 1. */
export function parseAttempts(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--max-attempts는 1 이상의 정수여야 합니다: ${raw}`);
  return n;
}
```

`formatGenerate`(context.ts:24)의 본문 끝에 세 줄을 더한다. 기존 줄(생성 완료·보존·고아)은 그대로 둔다. `report.skipped`면 첫 줄 대신 "변경 없음"을 쓴다.

```ts
// packages/cli/src/context.ts — formatGenerate 전체
export function formatGenerate(report: GenerateReport): string {
  if (report.skipped) return `변경 없음: ${report.outDir} (mockspec이 마지막 생성과 같습니다. 다시 만들려면 --force)`;
  const lines = [`생성 완료: ${report.outDir} (${report.written.length}개 파일)`];
  if (report.preserved.length) lines.push(`보존된 fixture ${report.preserved.length}개 (수정 흔적 있음): ${report.preserved.join(", ")}`);
  if (report.orphaned.length) lines.push(`고아 fixture ${report.orphaned.length}개 (선택 해제됐지만 수정 흔적이 있어 남김): ${report.orphaned.join(", ")}`);
  if (report.attempts > 0) lines.push(`LLM 시도 ${report.attempts}회`);
  if (report.userModified.length) lines.push(`사용자가 고친 파일 중 이번 생성이 바꾼 것 ${report.userModified.length}개 (확인하세요): ${report.userModified.join(", ")}`);
  for (const n of report.notes) lines.push(`참고: ${n}`);
  return lines.join("\n");
}
```

보존·고아 두 줄은 지금(context.ts:25-27) 문구 그대로다. `--force`는 Task 10 `generate`의 건너뛰기 조건(`!opts.force`)을 끄므로 안내 문구가 맞다.

```ts
// packages/cli/src/cli.ts — 마지막 catch
program.parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`오류: ${e.message}\n`);
  // GenerationFailedError(5)처럼 종료 코드를 가진 오류는 그 값을 쓴다.
  process.exit((e as { exitCode?: number }).exitCode ?? 1);
});
```

- [ ] **Step 4: generate 명령**

```ts
// packages/cli/src/commands/generate.ts
import { assertLanguage, finalizeGeneration, generate, prepareGeneration } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatGenerate, parseAttempts, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

interface Opts { lang?: string; llm: string; model?: string; maxAttempts?: string; finalize: boolean; out?: string; force: boolean; json: boolean }

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("mockspec.json으로 mock 서버 프로젝트를 생성한다. ts는 템플릿, java는 LLM(claude-code)이 만들고 빌드·검증까지 통과한 것만 반영한다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--lang <lang>", "생성 언어 (ts | java). 생략하면 기존 디렉터리의 언어, 없으면 ts")
    .option("--llm <adapter>", "ts가 아닌 언어의 생성 방식: claude-code(기본, 여기서 끝까지) | session(지시서만 쓰고 대화에서 작성)", "claude-code")
    .option("--model <model>", "claude-code 어댑터의 모델 (예: sonnet, opus)")
    .option("--max-attempts <n>", "LLM 생성의 최대 시도 횟수 (기본 3)")
    .option("--finalize", "--llm session 뒤 대화에서 쓴 파일을 확정한다(보호 경로·범위 검사, fixtures·contracts·lock 작성)", false)
    .option("--out <dir>", "출력 디렉터리 (기본 ./mock/<system>)")
    .option("--force", "사용자가 수정한 fixture도 덮어쓴다. specmock이 만들지 않은(specmock.lock.json 없는) 비어 있지 않은 디렉터리도 덮어쓴다(package.json·src 등 교체, routes·contracts 정리). 언어를 바꿀 때도 필요하다(fixtures·contracts 밖의 기존 소스 삭제)", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: Opts, cmd: Command) => {
      if (opts.llm !== "claude-code" && opts.llm !== "session") fail(`알 수 없는 LLM 어댑터: ${opts.llm} (claude-code, session)`);
      if (opts.lang !== undefined) assertLanguage(opts.lang);
      const maxAttempts = parseAttempts(opts.maxAttempts);
      const ws = workspaceFrom(cmd);

      if (opts.finalize) {
        const r = await finalizeGeneration(ws, system);
        if (!r.ok) {
          if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
          fail(`확정 거부(${r.reason}): ${r.errors.join("; ")}`);
        }
        printJsonOr(opts.json, r, () => [
          `확정: ${r.outDir} (${r.written.length}개 파일)`,
          ...r.warnings.map((w) => `경고: ${w}`),
          `검증: specmock verify ${system}`,
        ].join("\n"));
        return;
      }

      if (opts.llm === "session") {
        const p = await prepareGeneration(ws, system, { outDir: opts.out, force: opts.force, language: opts.lang });
        printJsonOr(opts.json, p, () => [
          `${p.reused ? "지시서가 이미 최신입니다" : "지시서를 썼습니다"}: ${p.requestPath}`,
          `출력 위치: ${p.outDir} (${p.language})`,
          ...p.nextSteps,
        ].join("\n"));
        return;
      }

      const report = await generate(ws, system, {
        outDir: opts.out, force: opts.force, language: opts.lang, model: opts.model, maxAttempts,
        onProgress: (e) => process.stderr.write(e.message + "\n"),
      });
      printJsonOr(opts.json, report, () =>
        `${formatGenerate(report)}\n실행: ${report.launch}\n검증: specmock verify ${system}`,
      );
    });
}
```

`prepareGeneration`은 언어가 ts(또는 lock 없음 + `--lang` 없음)이면 "세션 모드는 ts가 아닌 언어에만 씁니다…"로 던지므로 CLI가 따로 막지 않는다(종료 코드 1).

- [ ] **Step 5: run 명령**

```ts
// packages/cli/src/commands/run.ts:1-3 import
import { assertLanguage, formatCatalog, runPipeline, verifyFailed } from "@specmock/core";
import type { Command } from "commander";
import { fail, formatDiff, formatGenerate, formatMerge, formatVerify, parseAttempts, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";
```

```ts
// packages/cli/src/commands/run.ts:5
interface Opts { select: string; lang?: string; out?: string; verify: boolean; llm?: string; model?: string; maxAttempts?: string; refresh: boolean; json: boolean }
```

```ts
// packages/cli/src/commands/run.ts:14 (기본값 "ts"를 없애 lock의 언어를 따르게 하고 --max-attempts를 더한다)
    .option("--lang <lang>", "생성 언어 (ts | java). 생략하면 기존 디렉터리의 언어, 없으면 ts. java는 claude-code로 생성한다")
    .option("--max-attempts <n>", "LLM 생성의 최대 시도 횟수 (기본 3)")
```

`--llm` 설명(:17)을 "문서 입력의 추출과 ts가 아닌 언어의 생성에 쓰는 LLM 어댑터 (claude-code만 가능. 세션 모드는 run 대신 analyze·generate로 단계별 진행)"로 바꾼다.

```ts
// packages/cli/src/commands/run.ts:22 (ts 전용 검사를 지원 언어 검사로)
      if (opts.lang !== undefined) assertLanguage(opts.lang);
      const maxAttempts = parseAttempts(opts.maxAttempts);
```

```ts
// packages/cli/src/commands/run.ts:28-31 (runPipeline 옵션)
      const r = await runPipeline(ws, system, origins, {
        select: opts.select, outDir: opts.out, verify: opts.verify,
        llm: opts.llm as "claude-code" | undefined, model: opts.model, refresh: opts.refresh,
        language: opts.lang, maxAttempts,
        onEvent: (e) => process.stderr.write(e.message + "\n"),
        onProgress: (e) => process.stderr.write(e.message + "\n"),
```

`assertLanguage`는 던지므로 `cli.ts`의 catch가 종료 코드 1로 끝낸다(ingest 전이라 `.specmock`이 생기지 않는다). `runPipeline`의 `language`·`maxAttempts`·`onProgress`는 Task 10 Step 6에서 더했다.

- [ ] **Step 6: SKILL.md §4**

`plugin/skills/specmock/SKILL.md` §4의 bash 블록(:102-106)에서 `specmock generate <system>` 줄 아래에 더한다. drift 테스트(`cli/test/plugin.test.ts:50-67`)가 이 옵션들이 `--help`에 있는지 본다.

```bash
specmock generate <system> --lang java --llm claude-code [--model sonnet] [--max-attempts 3]   # Java: 생성·빌드·검증 통과분만 반영. 실패하면 종료 코드 5
specmock generate <system> --lang java --llm session    # 지시서만 쓴다. 대화에서 pom.xml·src/** 작성 후
specmock generate <system> --finalize                    # 확정 → specmock verify <system>
```

:112(run 안내) 문장 끝에 더한다: "Java는 `specmock run <system> <origins...> --lang java --llm claude-code`. 스킬 환경에서는 MCP `generate_mock(language)`의 세션 모드를 우선한다."

- [ ] **Step 7: 통과 확인과 커밋**

```bash
pnpm vitest run packages/cli/test/cli.test.ts packages/cli/test/plugin.test.ts
```
기대: 모두 passed(기존 generate·run 테스트 포함. 기존 `generate`는 `--lang` 기본값이 없어져도 lock이 없으므로 ts).

```bash
pnpm typecheck && pnpm test
git add -A packages/cli plugin/skills/specmock/SKILL.md
git commit -m "feat(cli): generate --lang java·--llm session·--finalize·--max-attempts, 종료 코드 5

--lang은 지원 언어 등록표로 검사하고, 생략하면 lock의 언어를 따른다. java 생성의 단계는
stderr로, 시도·notes·사용자가 고쳤는데 바뀐 파일·변경 없음은 출력과 --json에 싣는다. LLM 생성이
maxAttempts 안에 통과하지 못하면 종료 코드 5.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: ui-server `generate`의 language·진행 이벤트, web 생성 화면의 언어 선택·진행·결과

**Files:**
- Modify: `packages/ui-server/src/app.ts:5`(import에 `assertLanguage`), `:17`(`GenerateBody`), generate 라우트
- Modify: `packages/ui-server/src/api-types.ts:41`(`Job.input`에 `language`)
- Modify: `packages/web/src/api.ts:28`(`generate`에 language)
- Modify: `packages/web/src/screens/Generate.tsx`
- Test: `packages/ui-server/test/api.test.ts`(generate describe), `packages/ui-server/test/sse.test.ts`, `packages/web/test/Generate.test.tsx`

설계 §4.3: 언어 선택(ts/java), 진행 표시(단계·attempt n/max), 결과에 attempts·notes·userModified. Web UI는 세션 모드를 쓰지 않는다(claude-code만). 진행은 기존 job 이벤트 모양 `{message, done?, total?}`(`jobs.ts:42-47`)에 `GenerateProgress`를 `message`·`done=attempt`·`total=maxAttempts`로 옮겨 `job-progress`로 흘린다. 새 이벤트 이름은 만들지 않는다.

`toApiError`는 InvalidRequest만 400으로 바꾸고 나머지 메시지는 500 `failed`로 둔다. 그래서 라우트에서 `assertLanguage`의 오류를 `InvalidRequest`로 다시 던진다. `GenerationFailedError`는 작업 안에서 나므로 job이 `failed`가 되고 `error.message`에 "N번 시도했지만 … 마지막 시도: …"가 그대로 실린다.

- [ ] **Step 1: ui-server 실패 테스트**

`packages/ui-server/test/api.test.ts`의 "generate 작업은 입력(outDir)을 job에 싣는다" 아래에 더한다.

```ts
  it("generate body의 language는 job 입력에 실리고, 모르는 언어는 400 invalid", async () => {
    const c = client();
    await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
    await c.post("/systems/petstore/analyze");
    const bad = await c.post("/systems/petstore/generate", { outDir: path.join(root, "o"), language: "cobol" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "invalid", message: expect.stringContaining("지원 언어: ts, java") });
    expect((await c.get("/jobs")).body.data).toEqual({ running: [], recent: [] });
    const out = path.join(root, "out-ts");
    const r = await c.post("/systems/petstore/generate", { outDir: out, language: "ts" });
    const list = (await c.get("/jobs")).body.data as { running: { id: string; input?: unknown }[]; recent: { id: string; input?: unknown }[] };
    expect([...list.running, ...list.recent].find((x) => x.id === r.body.data.jobId)!.input).toEqual({ outDir: out, language: "ts" });
  });
```

`packages/ui-server/test/sse.test.ts`의 "OpenAPI 시스템: 생성 작업 → done…" 테스트 안, `expect(j1.state).toBe("done");` 아래에 결과 필드 단정을 더한다.

```ts
  expect(j1.result).toMatchObject({ language: "ts", attempts: 0, notes: [], userModified: [], skipped: false, launch: `cd ${outDir} && npm install && npm start` });
```

같은 파일 끝에 java 실패 테스트를 더한다(가짜 `claude-fail`은 `Not logged in`으로 끝나므로 매 시도가 실패하고 JDK 없이도 돈다).

```ts
it("java 생성: 진행이 job-progress(시도 n/max)로 오고, 시도를 다 쓰면 failed와 마지막 attempt 위치", async () => {
  const c = make("claude-fail");
  await c.post("/systems", { system: "petstore", origins: [PETSTORE] });
  await c.post("/systems/petstore/analyze");
  const id = (await c.get("/systems/petstore/features")).body.data.rows[0].id;
  await c.post("/systems/petstore/selection", { ids: [id] });
  const progress: unknown[] = [];
  c.bus.subscribe((e) => {
    const d = e.data as { kind?: string; progress?: unknown };
    if (e.event === "job-progress" && d.kind === "generate") progress.push(d.progress);
  });
  const outDir = path.join(root, "out-java");
  expect((await c.post("/systems/petstore/generate", { outDir, language: "java" })).status).toBe(202);
  const j = await until(async () => (await c.get("/jobs")).body.data.recent.find((x: { kind: string }) => x.kind === "generate"), 20_000);
  expect(j).toMatchObject({ state: "failed", input: { outDir, language: "java" }, error: { message: expect.stringContaining("3번 시도했지만 검증을 통과하는 mock을 만들지 못했습니다") } });
  expect(progress).toContainEqual({ message: "코드 생성 중 (1/3)", done: 1, total: 3 });
  expect(progress.at(-1)).toEqual({ message: "코드 생성 중 (3/3)", done: 3, total: 3 });
  await expect(readFile(path.join(outDir, "specmock.lock.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
```

`EventBus.subscribe(fn: (e: {event, data}) => void)`(bus.ts:6)에 직접 구독한다. 실패한 job 스냅숏에도 마지막 progress가 남는다(`snap()`, jobs.ts:40).

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run packages/ui-server/test
```
기대: 새 api 테스트 FAIL(400 대신 202, input에 language 없음), sse java 테스트 FAIL(language를 받지 않아 ts로 생성되어 done). 결과 필드 단정은 Task 10 뒤라 통과.

- [ ] **Step 3: ui-server 구현**

```ts
// packages/ui-server/src/app.ts:5 — import 목록에 assertLanguage 추가(알파벳 순)
import { analyzeSpec, assertLanguage, CatalogSchema, ClaudeCodeAdapter, findFeature, generate, ingestSpec, listFeatures, select, summarizeChunks, verifyMock, Workspace } from "@specmock/core";
```

```ts
// packages/ui-server/src/app.ts:17
const GenerateBody = z.object({ outDir: z.string().min(1).optional(), force: z.boolean().optional(), language: z.string().min(1).optional() });
```

```ts
// packages/ui-server/src/app.ts — generate 라우트 전체
app.post("/api/systems/:s/generate", async (c) => {
  const system = c.req.param("s");
  const b = await optionalBody(c, GenerateBody);
  // 모르는 언어는 작업을 만들기 전에 400으로 돌려준다(toApiError는 이 메시지를 500으로 본다).
  if (b.language !== undefined) {
    try { assertLanguage(b.language); } catch (e) { throw new InvalidRequest((e as Error).message); }
  }
  await assertRegistered(ws, system);
  const outDir = resolveFromRoot(b.outDir) ?? (await defaultOutDir(ws, opts.root, system));
  const input = { outDir, ...(b.language ? { language: b.language } : {}) };
  return accepted(c, jobs.start(system, "generate", ({ onEvent }) => generate(ws, system, {
    outDir, force: b.force, language: b.language,
    adapter: new ClaudeCodeAdapter({ command: claudeCommand }),
    onProgress: (e) => onEvent({ message: e.message, done: e.attempt, total: e.maxAttempts }),
  }), input).id);
});
```

`InvalidRequest(message)`는 `invalid`(400)로 매핑된다(errors.ts:3). ts 생성에서는 `adapter`·`onProgress`를 쓰지 않으므로 기존 동작이 바뀌지 않는다.

```ts
// packages/ui-server/src/api-types.ts:41
  input?: { outDir?: string; language?: string };
```

- [ ] **Step 4: ui-server 통과 확인**

```bash
pnpm vitest run packages/ui-server/test
```
기대: 모두 passed.

- [ ] **Step 5: web 실패 테스트**

`packages/web/test/Generate.test.tsx` 끝에 더한다. 기존 단정(:38 `{ outDir: "/tmp/out", force: false }`, :76 `force: true`)은 언어를 고르지 않으면 body에 `language`를 싣지 않으므로 그대로 둔다. `:90`의 실행 명령 단정은 `result.launch`를 그대로 보이므로 그대로 통과한다.

```ts
it("언어 선택: 기본은 '기존 언어 유지', Java를 고르면 body에 language:'java'. 덮어쓰기 재호출에도 실린다", async () => {
  const api = setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  const sel = (await screen.findByLabelText("언어")) as HTMLSelectElement;
  expect(sel.value).toBe("");
  expect([...sel.options].map((o) => o.textContent)).toEqual(["기존 언어 유지(없으면 TypeScript)", "TypeScript (Hono)", "Java (Maven + Javalin)"]);
  fireEvent.change(sel, { target: { value: "java" } });
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/generate"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/petstore/generate")]).toEqual({ outDir: "/r/mock/petstore", force: false, language: "java" });
  emit("job-started", job());
  emit("job-failed", job({ state: "failed", error: { code: "overwrite-required", message: "비어 있지 않아요" } }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "덮어쓸까요?" })).getByRole("button", { name: "덮어쓰기" }));
  await vi.waitFor(() => expect(api.calls.filter((c) => c === "POST /api/systems/petstore/generate")).toHaveLength(2));
  expect(api.bodies.at(-1)).toEqual({ outDir: "/r/mock/petstore", force: true, language: "java" });
});

it("생성 중 진행: job-progress의 단계 메시지와 '시도 n/max'를 보인다", async () => {
  setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(FakeEventSource.last).toBeTruthy());
  emit("job-started", job());
  emit("job-progress", job({ progress: { message: "빌드 중 (2/3)", done: 2, total: 3 } }));
  const status = await screen.findByText(/빌드 중 \(2\/3\)/);
  expect(status.textContent).toContain("시도 2/3");
});

it("java 결과: 시도 횟수·참고·사용자가 고쳤는데 바뀐 파일 목록과 launch 명령. 건너뛴 생성은 '변경 없음'", async () => {
  const api = setup({ "POST /api/systems/petstore/generate": accepted });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "생성" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/petstore/generate"));
  emit("job-started", job());
  const launch = "cd /r/mock/petstore && ./mvnw -q -DskipTests package && java -jar target/mock.jar";
  emit("job-done", job({ state: "done", endedAt: "t1", result: { outDir: "/r/mock/petstore", language: "java", written: ["pom.xml", "src/main/java/mock/Main.java"], preserved: [], orphaned: [], launch, attempts: 2, notes: ["POST /pets 검증 규칙을 단순화"], userModified: ["src/main/java/mock/Custom.java"], skipped: false } }));
  expect(await screen.findByText(/생성 완료: \/r\/mock\/petstore \(2개 파일\)/)).toBeTruthy();
  expect(screen.getByText("LLM 시도 2회")).toBeTruthy();
  expect(screen.getByText("POST /pets 검증 규칙을 단순화")).toBeTruthy();
  expect(screen.getByText(/이번 생성이 바꾼 것 1개 \(확인하세요\): src\/main\/java\/mock\/Custom\.java/)).toBeTruthy();
  expect(document.body.textContent).toContain(launch);
  emit("job-done", job({ id: "j2", state: "done", endedAt: "t2", result: { outDir: "/r/mock/petstore", language: "java", written: [], preserved: [], orphaned: [], launch, attempts: 0, notes: [], userModified: [], skipped: true } }));
  expect(await screen.findByText(/변경 없음: \/r\/mock\/petstore/)).toBeTruthy();
});
```

`launch` 문자열은 테스트 안에서만 쓰는 값이다. 실제 문구는 Task 13 `javaProfile.launchCommand`가 정하고 화면은 그대로 보인다. `useJob`의 `last`는 같은 시스템·kind 작업 목록의 마지막 항목(useJob.ts:14)이라 새 id `j2`의 `job-done`이 결과를 바꾼다.

- [ ] **Step 6: 실패 확인**

```bash
pnpm vitest run packages/web/test/Generate.test.tsx
```
기대: 새 3개 FAIL(`Unable to find a label with the text of: 언어`, 진행 문구 없음, `LLM 시도 2회` 없음). 기존 8개 passed.

- [ ] **Step 7: web 구현**

```ts
// packages/web/src/api.ts:28
  generate: (name: string, outDir: string, force = false, language?: string) =>
    call<{ jobId: string }>("POST", `${s(name)}/generate`, { outDir, force, ...(language ? { language } : {}) }),
```

`packages/web/src/screens/Generate.tsx`를 고친다.

```tsx
// :10-11 — core GenerateReport의 화면에 쓰는 필드
/** core GenerateReport. CLI의 generate 출력과 같은 정보를 보인다. */
interface GenerateReport {
  outDir: string; written: string[]; preserved: string[]; orphaned: string[]; launch?: string;
  language?: string; attempts?: number; notes?: string[]; userModified?: string[]; skipped?: boolean;
}

/** 언어 선택지. ""는 body에 language를 싣지 않는다(core가 lock의 언어, 없으면 ts를 쓴다). */
const LANGUAGES: { value: string; label: string }[] = [
  { value: "", label: "기존 언어 유지(없으면 TypeScript)" },
  { value: "ts", label: "TypeScript (Hono)" },
  { value: "java", label: "Java (Maven + Javalin)" },
];
```

```tsx
// :18 아래 상태 하나 추가
  const [language, setLanguage] = useState("");
```

```tsx
// :22 확인 창 상태에 language를 싣는다(덮어쓰기 재호출이 같은 언어로 가게)
  const [ask, setAsk] = useState<{ id: string; dir: string; language: string; message: string } | null>(null);
```

```tsx
// :37
    setAsk({ id: failedId, dir: seen?.input?.outDir ?? sent.current, language: seen?.input?.language ?? sentLang.current, message: seen?.error?.message ?? "" });
```

```tsx
// :25 아래
  const sentLang = useRef<string>("");
```

```tsx
// :40-42 start
  const start = async (dir: string, force: boolean, lang: string) => {
    setBusy(true); setError(null); setDeclined(false); sent.current = dir; sentLang.current = lang;
    try { const r = await api.generate(system, dir, force, lang || undefined); watch(r.jobId); refreshJobs(); } catch (e) {
```

```tsx
// :62-68 — 출력 디렉터리 아래 언어 선택, 생성 버튼, 진행 표시
      <label className="field">출력 디렉터리
        <input value={outDir} onChange={(e) => setOutDir(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">언어
        <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={selectLocked}>
          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </label>
      <div className="action-row">
        <button type="button" className="btn-primary" disabled={locked} onClick={() => void start(outDir.trim(), false, language)}>생성</button>
        {running ? (
          <span role="status" className="muted">
            생성 중이에요. 파일을 쓰는 중이라 멈출 수 없어요.
            {running.progress?.message ? ` · ${running.progress.message}` : ""}
            {running.progress?.total ? ` · 시도 ${running.progress.done ?? 0}/${running.progress.total}` : ""}
          </span>
        ) : null}
      </div>
```

`:55` 아래에 `const selectLocked = busy || !!running;`를 둔다. 생성 버튼의 `locked`는 출력 디렉터리가 비어도 잠그지만, 언어 선택은 작업 중에만 잠근다.

```tsx
// :69-79 — 결과
      {done ? (
        <section className="result" aria-label="생성 결과">
          {done.skipped
            ? <p><strong>변경 없음: {done.outDir} (mockspec이 마지막 생성과 같아요)</strong></p>
            : <p><strong>생성 완료: {done.outDir} ({done.written.length}개 파일)</strong></p>}
          {done.preserved.length ? <p className="muted">보존된 fixture {done.preserved.length}개 (수정 흔적 있음): {done.preserved.join(", ")}</p> : null}
          {done.orphaned.length ? <p className="muted">고아 fixture {done.orphaned.length}개 (선택 해제됐지만 수정 흔적이 있어 남김): {done.orphaned.join(", ")}</p> : null}
          {done.attempts ? <p className="muted">LLM 시도 {done.attempts}회</p> : null}
          {done.userModified?.length ? <p className="muted">사용자가 고친 파일 중 이번 생성이 바꾼 것 {done.userModified.length}개 (확인하세요): {done.userModified.join(", ")}</p> : null}
          {done.notes?.length ? <ul className="notes">{done.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          <ul className="files mono">{done.written.map((f) => <li key={f}>{f}</li>)}</ul>
          <p className="muted">실행</p>
          <pre className="cmd">{done.launch ?? `cd ${done.outDir} && npm install && npm start`}</pre>
          <div><button type="button" className="btn-primary" onClick={() => go(pathFor("verify", system))}>⑤ 검증으로 →</button></div>
        </section>
      ) : null}
```

`launch`가 없는 결과는 3A 이전에 만든 작업 기록뿐이라 `:76`의 대체 문구는 그대로 둔다(core 결과에는 늘 `launch`가 있다, Task 10).

```tsx
// :80 — 확인 창의 덮어쓰기
      <ConfirmDialog open={!!ask} title="덮어쓸까요?" confirmLabel="덮어쓰기" onCancel={() => { setAsk(null); setDeclined(true); }} onConfirm={() => { const a = ask!; setAsk(null); void start(a.dir, true, a.language); }}>
```

- [ ] **Step 8: 통과 확인과 커밋**

```bash
pnpm vitest run packages/web/test packages/ui-server/test
pnpm typecheck && pnpm test
git add packages/ui-server packages/web
git commit -m "feat(ui): 생성 화면에 언어 선택·시도 진행·LLM 결과 표시

POST /generate가 language를 받아 지원 언어로 검사하고(모르면 400), java 생성의 단계는
job-progress(시도 n/max)로 흘린다. 결과의 시도 횟수·참고·사용자 수정·변경 없음을 보인다.
Web UI는 claude-code로만 생성한다(세션 모드 없음).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: `scripts/live-llm-check.ts`에 Java 케이스(Petstore → claude-code 생성 → verify)

**Files:**
- Modify: `scripts/live-llm-check.ts`(파일 전체)

설계 §5 "실제 LLM" 행, §6-9. 수동 확인용이라 vitest에 넣지 않는다(구독 호출 비용). 타입 검사는 `tsconfig.scripts.json`(`include: ["scripts", …]`)이 `pnpm typecheck`에서 한다. 실제 호출 1회 이상 통과는 Task 19에서 확인한다.

- [ ] **Step 1: 스크립트 교체**

```ts
// pnpm llm:check [model]          (= pnpm build:core && tsx scripts/live-llm-check.ts)
// pnpm llm:check [model] --java   Petstore를 Java로 생성하고 verify까지 돌린다(JDK 17 필요, 수 분 걸림)
// 로컬 claude CLI가 구조화 출력을 제대로 내는지 확인한다. 구독 호출이 발생한다.
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChunkPrompt, ClaudeCodeAdapter, extractionJsonSchema, ExtractionResultSchema, runPipeline, verifyFailed, Workspace } from "@specmock/core";

const args = process.argv.slice(2);
const java = args.includes("--java");
const model = args.find((a) => !a.startsWith("--"));
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

if (!java) {
  const adapter = new ClaudeCodeAdapter({ model, timeoutMs: 120_000 });
  const chunk = "## Get a pet\n\n`GET /pets/{petId}` returns one pet.\n\n```json\n{\"id\": 1, \"name\": \"Rex\"}\n```\n";
  const out = await adapter.complete({ prompt: buildChunkPrompt(chunk), schema: extractionJsonSchema() });
  const parsed = ExtractionResultSchema.safeParse(out);
  console.log(JSON.stringify(out, null, 2));
  console.log(parsed.success ? `OK (${Date.now() - started}ms, model=${model ?? "default"})` : `스키마 불일치: ${parsed.error.message}`);
  process.exit(parsed.success && parsed.data.endpoints.some((e) => e.path === "/pets/{petId}") ? 0 : 1);
}

try {
  execFileSync("java", ["-version"], { stdio: "ignore" });
} catch {
  console.log("SKIP: java -version이 실패했습니다. JDK 17 이상을 설치한 뒤 다시 실행하세요.");
  process.exit(0);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "specmock-llm-java-"));
const ws = new Workspace(path.join(root, ".specmock"));
const outDir = path.join(root, "mock", "petstore");
console.log(`작업 디렉터리: ${root}`);
try {
  const r = await runPipeline(ws, "petstore", [path.join(repo, "examples", "petstore", "petstore.yaml")], {
    select: "all", outDir, verify: true, language: "java", model,
    onEvent: (e) => console.error(`[${elapsed()}] ${e.message}`),
    onProgress: (e) => console.error(`[${elapsed()}] ${e.message}`),
  });
  const g = r.generate;
  console.log(`생성: ${g.outDir} (시도 ${g.attempts}회, 파일 ${g.written.length}개)`);
  for (const n of g.notes) console.log(`참고: ${n}`);
  console.log(`실행: ${g.launch}`);
  const v = r.verify!;
  console.log(`contract: 통과 ${v.passed} / 실패 ${v.failed} / 전체 ${v.total}, runtime 실패 ${v.runtimeFailed}`);
  const ok = !verifyFailed(v) && g.language === "java";
  console.log(ok ? `OK (${elapsed()}, model=${model ?? "default"})` : `FAIL: verify 실패. ${outDir}을 확인하세요.`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  // GenerationFailedError면 메시지에 마지막 시도(.specmock-attempt/errors.md) 위치가 있다.
  console.log(`FAIL (${elapsed()}): ${(e as Error).message}`);
  process.exit(1);
}
```

예시 Petstore는 `examples/petstore/petstore.yaml`(README 빠른 시작과 같은 파일)이다. `select: "all"`은 README 빠른 시작의 `--select all`과 같다. 작업 디렉터리는 지우지 않는다(실패 시 attempt를 보려고). `runPipeline`의 `language`·`maxAttempts`·`onProgress`는 Task 10 Step 6, `GenerateReport.language`·`attempts`·`notes`·`launch`는 Task 10, `verifyFailed`·`VerifyResult.runtimeFailed`는 Task 5에서 정했다.

- [ ] **Step 2: 타입 검사**

```bash
pnpm typecheck
```
기대: 오류 없음(`tsconfig.scripts.json`이 `scripts/`를 검사한다). 이 Step에서는 실제 claude를 부르지 않는다(Task 19에서 부른다). `package.json`의 `llm:check` 스크립트는 그대로 둔다. pnpm 12는 `pnpm llm:check --java`처럼 스크립트 이름 뒤 인자를 그대로 넘긴다.

- [ ] **Step 3: 커밋**

```bash
pnpm typecheck && pnpm test
git add scripts/live-llm-check.ts
git commit -m "chore(scripts): llm:check --java로 Petstore Java 생성과 verify를 실제로 확인

JDK가 없으면 SKIP. 시도 횟수·notes·contract/runtime 결과를 출력하고, 생성이 시도를
다 쓰면 마지막 attempt 위치와 함께 FAIL.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: 문서 — README, architecture.md, 설계 문서 §10·§12, 3A 설계 문서 오기·상태

**Files:**
- Modify: `README.md`(:18 요구 사항, :52-80 CLI·종료 코드, :142~ Web UI, :275-299 생성 결과물, :304 제한 사항, :321 문서 목록, :340 로드맵)
- Modify: `docs/architecture.md`(:9-18 개요 그림, :22-44 레이어 그림, :201-220 로드맵)
- Modify: `docs/superpowers/specs/2026-11-04-specmock-design.md`(:536 3단계 경계 문단, :550 §12 제목과 표 끝)
- Modify: `docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md`(:4 상태, :298 "11 → 13")
- Test: `packages/cli/test/plugin.test.ts`(README·SKILL drift는 그대로 돌린다)

문서 Task라 실패 테스트가 없다. 대신 Step 마다 grep으로 확인하고, 마지막에 drift 테스트(SKILL.md의 CLI 옵션이 `--help`에 있음, MCP 도구 이름 양방향)를 돌린다.

- [ ] **Step 1: README 요구 사항과 CLI 절**

:18 아래에 한 문단을 더한다.

```markdown
Java mock을 만들려면(`--lang java`) JDK 17 이상과 로그인된 `claude` CLI가 필요합니다. Maven은 설치하지 않아도 됩니다(생성물의 `./mvnw`가 받습니다). 첫 빌드는 Maven 배포본과 의존성을 내려받으므로 네트워크가 필요하고 수 분 걸립니다. `unzip`이 없으면 mvnw가 `tar`로 풉니다. Windows(`mvnw.cmd`)는 동작하도록 작성했지만 검증하지 않았습니다.
```

:61 `generate` 줄과 :63-64 `run` 줄을 바꾼다.

```bash
specmock generate <system> [--lang ts|java] [--llm claude-code|session] [--model m] [--max-attempts n]
                           [--finalize] [--out dir] [--force] [--json]  # ./mock/<system>/ 에 mock 프로젝트 생성
specmock run      <system> <origins...> [--select 표현식] [--lang ts|java] [--max-attempts n] [--out dir] [--no-verify]
                                          [--llm claude-code] [--model m] [--refresh] [--json]   # 위 과정을 한 번에
```

:68 "`verify`는 mock 디렉터리에 `node_modules`가 없으면 `npm install`을 먼저 수행합니다."를 바꾼다.

```markdown
`verify`는 lock에 적힌 설치 단계(TS는 `npm install`, Java는 `./mvnw -q -DskipTests package`)를 먼저 수행합니다. 소스가 바뀌지 않았으면 다시 하지 않습니다(`.specmock-installed`).
```

종료 코드 표(:72-77)에 열 하나와 행 하나를 더한다.

```markdown
| 명령 | 0 | 1 | 2 | 5 |
|---|---|---|---|---|
| 모든 명령 | 성공 | 오류(메시지 출력) | 명령마다 다름(아래) | — |
| `analyze` | 성공 | 오류 | 일부 청크 추출 실패. 같은 명령을 다시 실행하면 실패한 청크만 재시도 | — |
| `generate` | 성공 | 오류(지원하지 않는 언어, `--finalize` 거부 포함) | — | LLM 생성이 `--max-attempts` 안에 검증을 통과하지 못함 |
| `run` | 성공 | 오류(청크 전부 실패 포함) | contract 실패 **또는** 일부 청크 추출 실패 | `generate`와 같음 |
| `verify` | 성공 | 기동 실패 등 오류 | contract 또는 런타임 계약(501·404) 실패 | — |
```

종료 코드 표 아래에 새 절을 더한다.

````markdown
### 다른 언어로 생성 (Java)

```bash
pnpm specmock run petstore examples/petstore/petstore.yaml --select all --lang java
cd mock/petstore && ./mvnw -q -DskipTests package && java -jar target/mock.jar
curl -s localhost:4010/pets/1
```

TS는 템플릿으로 만들지만 Java는 `claude`가 MockSpec과 TS 참조 구현을 보고 작성합니다. specmock은 결과를 임시 디렉터리에서 빌드·기동하고 contract와 런타임 계약(선택하지 않은 경로 501, 모르는 경로 404)을 통과한 것만 `mock/<system>/`에 반영합니다. 실패하면 오류 요약을 붙여 다시 요청하고(기본 3회, `--max-attempts`), 그래도 안 되면 종료 코드 5와 함께 마지막 시도를 `mock/<system>/.specmock-attempt/`(`errors.md`)에 남깁니다.

- 같은 mockspec으로 다시 `generate`하면 claude를 부르지 않고 "변경 없음"을 출력합니다(`--force`로 다시 생성).
- 기능을 추가해 다시 생성하면 기존 소스를 함께 보내 고칠 부분만 바뀝니다. 직접 고친 소스는 "(사용자 수정)"으로 표시해 라우트 추가·삭제 외에는 바꾸지 말라고 요청하고, 그래도 바뀐 파일은 출력에 목록으로 알립니다. 응답에서 빠진 기존 소스는 지우지 않습니다.
- Claude Code 대화 안에서는 `--llm session`이 지시서(`.specmock/<system>/generate-request.json`)만 쓰고, 대화에서 파일을 작성한 뒤 `specmock generate <system> --finalize`로 확정합니다. MCP는 `generate_mock(language)` → `finalize_generation`입니다.
- 언어를 바꿀 때(ts ↔ java)는 `--force`가 필요합니다. fixtures·contracts만 남기고 기존 소스를 지웁니다.
````

- [ ] **Step 2: README Web UI·생성 결과물·제한 사항·로드맵**

Web UI 절(:142~)의 생성 화면 설명 문장 끝에 더한다: "생성 화면에서 언어(기존 유지 · TypeScript · Java)를 고를 수 있고, Java는 단계와 시도 n/max를 보여 줍니다. Web UI는 claude-code로만 생성합니다."

생성 결과물 절(:275) 트리 아래에 Java 트리를 더한다.

````markdown
Java(`--lang java`):

```
mock/<system>/
├── pom.xml                                # Javalin 6 + networknt json-schema-validator, shade로 target/mock.jar
├── mvnw, mvnw.cmd, .mvn/wrapper/          # Maven Wrapper (specmock이 넣는 고정 파일, 생성 대상 아님)
├── src/main/java/**                       # claude가 작성. 요청 검증 → fixture 응답, 501·404 동작은 TS와 같다
├── fixtures/, contracts/, specmock.lock.json   # TS와 같다 (lock의 install·start가 빌드·기동 명령)
```
````

제한 사항 제목(:304)을 `## 제한 사항`으로 바꾸고 첫 줄을 바꾼다.

```markdown
- 생성 언어는 TypeScript(Hono, 템플릿)와 Java(Maven + Javalin, LLM 생성)입니다. Java 생성은 LLM 출력이라 매번 코드가 다를 수 있고, verify를 통과한 것만 반영합니다.
- Java 생성은 `claude` 구독 호출을 시도마다 한 번 씁니다. 기능이 많으면 프롬프트가 커집니다.
- Java 출력은 Windows에서 검증하지 않았습니다.
```

:318 "`generate`는 `src/`를 통째로 다시 씁니다…"는 "TS `generate`는 `src/`를 통째로 다시 씁니다…"로 바꾼다(Java는 사용자 수정 소스를 유지한다).

로드맵 표(:340-347)를 바꾼다.

```markdown
| 2B | Web UI(`specmock ui`, MCP `open_ui`로 11개), 파일 잠금, Playwright E2E — 완료 |
| 3A | 다른 언어 생성: `LanguageGenerator`·언어 프로필, Java(Maven + Javalin) LLM 생성과 검증 루프, 세션 모드, MCP `finalize_generation`(12개) ← 현재 |
| 3 | Proxy/녹화, API 키 어댑터, 다른 언어 프로필 추가 |
```

문서 목록(:321-327)에 한 줄을 더한다: `- [3A 설계: 다른 언어 생성](docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md)`. 기존 목록의 링크 모양(상대 경로·괄호 설명)을 따른다(`sed -n 321,328p README.md`).

"기여 방법" 절(:329)의 테스트 안내 끝에 더한다(지금 README에는 `llm:check` 안내가 없다): "실제 claude 호출 확인은 `pnpm llm:check`, Java 생성·verify까지는 `pnpm llm:check --java`(JDK 17, 수 분, 구독 호출)."

```bash
grep -n 'java\|Java' README.md | wc -l
grep -n '5 |\|--max-attempts\|3A' README.md
```
기대: Java 언급이 10줄 이상, 종료 코드 5 열·`--max-attempts`·3A 로드맵 행이 보인다.

- [ ] **Step 3: architecture.md**

:14 개요 그림의 생성 노드를 바꾼다.

```mermaid
    MS --> GEN["mock 서버<br/>(TS · Hono / Java · Javalin)"]
```

:22-44 레이어 그림의 core 하위 그래프 아래에 생성기 층을 더하고, LLM 어댑터 연결을 하나 더 그린다.

```mermaid
    subgraph GENL["generate의 언어 생성기 (3A)"]
        direction LR
        TSG["TsHonoGenerator<br/>(템플릿)"]
        LLMG["LlmGenerator<br/>(언어 프로필 + 검증 루프)"]
        PROF["프로필 등록표<br/>java: Maven + Javalin"]
        LLMG --- PROF
    end

    GENM --> GENL
    LLMG -.코드 작성.-> LLM
```

레이어 그림 아래 문단(:46~ "2A부터 CLI와 MCP 서버는…") 뒤에 문단을 더한다.

```markdown
3A부터 `generate`는 언어와 무관한 부분(fixtures·contracts·lock·보존 판정, `scaffold`)과 언어 종속 부분(`LanguageGenerator`)으로 나뉜다. `LanguageGenerator`는 `LanguageOutput`(파일·install·start·sourceGlobs)을 돌려주고, verify는 lock의 install·start만 보고 기동한다. TS는 `TsHonoGenerator`(템플릿), 그 밖의 언어는 `LlmGenerator`가 언어 프로필(`core/src/generate/profiles/`)과 TS 참조 구현을 프롬프트로 claude에 보내고, 임시 디렉터리에서 빌드·contract·런타임 계약(501·404)을 통과한 결과만 반영한다. 지원 언어 목록은 `SUPPORTED_LANGUAGES`이고 입력 단계(CLI·MCP·Web)에서 `assertLanguage`로 검사한다.
```

로드맵(:203-220): gantt의 3단계를 둘로 나누고 표에 3A 행을 더한다.

```mermaid
    section 3단계
    다른 언어 생성(3A, Java)             :done, a3, after a2, 1
    Proxy/녹화 · API 키                  :a4, after a3, 1
```

```markdown
| 3 | 3A(완료): 검증된 MockSpec으로 Java mock을 LLM이 생성하고 같은 verify 통과. 이후: 키 있으면 실제 시스템 전달·녹화 |
```

1·2단계 행에도 `done,`을 붙인다(`:a1, 0, 3` → `:done, a1, 0, 3`, `:a2, after a1, 2` → `:done, a2, after a1, 2`).

- [ ] **Step 4: 설계 문서 §10·§12**

`docs/superpowers/specs/2026-11-04-specmock-design.md:536`의 "3단계 인터페이스 경계" 문단을 바꾼다.

```markdown
3단계 인터페이스 경계: 3A(다른 언어 생성)를 먼저 했다. `generate`는 언어 무관 `scaffold`(fixtures·contracts·lock·보존 판정)와 `LanguageGenerator`(`LanguageOutput`: 파일 · install · start · sourceGlobs)로 나뉜다. TS는 `TsHonoGenerator`(템플릿, 출력 바이트 동일), 그 밖의 언어는 `LlmGenerator`가 언어 프로필(Java: Maven + Javalin) + MockSpec + TS 참조 구현을 프롬프트로 claude에 보내고 임시 디렉터리에서 빌드·contract·런타임 계약(501·404)을 통과한 결과만 반영한다(기본 3회, 실패 시 exit 5). verify는 lock의 install·start만 안다. 세션 모드(`--llm session` → `--finalize`, MCP `finalize_generation`)로 대화 안에서도 생성한다. MCP 도구는 12개. 상세: [2026-11-09-phase3a-java-generator-design.md](2026-11-09-phase3a-java-generator-design.md), [계획](../plans/2026-11-09-phase3a-java-generator.md). Proxy/녹화와 API 키 어댑터는 남은 3단계다.
```

§12 제목(:550)을 `## 12. 구현 중 변경 (1A, 1B, 2A, 3A)`로 바꾸고 표 끝(:598 다음)에 행을 더한다. 이 계획 머리말 "설계 문서 대비 결정 사항" 중 설계와 달라진 것만 옮긴다.

```markdown
| **3A** MCP 도구는 12개(`finalize_generation` 하나 추가) | 3A 설계 §4.2의 "11 → 13"은 오기. `list_languages`는 두지 않고 지원 언어는 오류 메시지와 `generate_mock` 설명에 싣는다 |
| **3A** Java 참조 발췌를 `core/templates/java/reference/`에 두고, 참조 mock 전문(`test/fixtures/java-petstore/`)과 같은지 테스트로 묶음 | 프롬프트가 런타임에 읽는 파일인데 `test/`는 배포되지 않는다 |
| **3A** 실행 안내를 `launchCommand(lock)`·`launchHint`로 조합하고 `GenerateReport.launch`에 실음 | `npm install && npm start` 하드코딩이 CLI·MCP·Web(`Generate.tsx`, 설계가 놓친 곳)·스킬에 흩어져 있었다 |
| **3A** 런타임 계약(501·404)은 `VerifyResult.runtime`·`runtimeFailed`로 contract와 따로 세고, 종료 코드는 `verifyFailed()` | 기존 `total/passed/failed` 단정을 지키면서 LLM 생성물의 라우터 동작을 검사 |
| **3A** 설치 마커 `.specmock-installed`에 설치 키(`install` + 소스 해시) 기록 | Java 설치는 빌드라서 소스가 바뀌면 jar가 낡는다. 키가 다르면 다시 빌드 |
| **3A** lock에 `installTimeoutMs`, `install`은 없음(옛 lock=npm install)/`null`(설치 없음) 구분, `generator`·`sourceFiles` 기본값 | verify가 lock만 보고 설치 여부·시간 제한을 정하고, 옛 lock을 그대로 읽게 |
| **3A** 테스트용 `fake` 프로필은 core에 등록하지 않고 `generate(…, { profile })`로 주입 | 지원 언어 목록(`SUPPORTED_LANGUAGES`)에 테스트 언어가 섞이지 않게 |
| **3A** 세션 진행 표식 `.specmock-session.json`과 `protectedHashes` | 지시서를 쓴 outDir은 lock 없이 mvnw가 생겨 다시 부르면 덮어쓰기 거부에 걸렸다. finalize가 보호 파일 변경을 판정 |
| **3A** 응답에서 빠진 기존 소스는 유지(notes에 기록), 삭제는 `content: null`로만 | 모델이 파일을 빠뜨려 사용자 소스가 사라지는 것을 막기 위해 |
| **3A** TS 라우트 정리를 `LanguageOutput.prune`으로 | 쓰지 않은 `src/routes/*.ts`를 지우는 기존 동작 유지 |
| **3A** 세션 지시서는 `prepareGeneration`·`finalizeGeneration`으로 `generate`와 분리 | `generate`가 늘 `GenerateReport`를 돌려주게(CLI·MCP·Web 출력 단순화) |
```

- [ ] **Step 5: 3A 설계 문서의 오기와 상태**

`docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md`:
- :298 `### 4.2 MCP (11 → 13개 도구)` → `### 4.2 MCP (11 → 12개 도구)`. 같은 절 본문에 "13"이 더 있으면(`sed -n 298,315p`) 12로 맞춘다.
- :4 `상태: 초안 (사용자 검토 대기)` → `상태: 구현 완료 (계획: [2026-11-09-phase3a-java-generator.md](../plans/2026-11-09-phase3a-java-generator.md), 설계와 달라진 점은 상위 문서 §12 "3A" 행)`.

```bash
grep -n '11 → 1' docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md
grep -n '^상태' docs/superpowers/specs/2026-11-09-phase3a-java-generator-design.md
grep -c '\*\*3A\*\*' docs/superpowers/specs/2026-11-04-specmock-design.md
```
기대: `11 → 12`, 상태 "구현 완료", 3A 행 11개.

- [ ] **Step 6: drift 테스트와 커밋**

```bash
pnpm vitest run packages/cli/test/plugin.test.ts packages/mcp/test/plugin.test.ts
pnpm typecheck && pnpm test
git add README.md docs/architecture.md docs/superpowers/specs
git commit -m "docs: 3A Java 생성 사용법·요구 사항, 레이어 그림과 로드맵, 설계 §10·§12 갱신

README에 JDK 17·첫 빌드 네트워크·Windows 미검증, --lang java·세션 모드·종료 코드 5,
Java 생성 결과물을 적는다. architecture.md에 LanguageGenerator·프로필 층을 그리고
3A를 완료로 표기한다. 3A 설계의 MCP 도구 수 오기(11 → 12)를 고친다.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19: 전체 검증과 PR 요점

**Files:** 없음(확인만. 실패하면 해당 Task로 돌아가 고친다)

- [ ] **Step 1: 깨끗한 설치부터 전체**

```bash
pnpm install && pnpm build && pnpm test && pnpm typecheck
```
기대: 모두 성공. `pnpm test` 요약에 실패 0.

- [ ] **Step 2: Java 테스트가 skip되지 않았는지**

```bash
java -version 2>&1 | head -1
pnpm vitest run packages/core/test/java.test.ts packages/core/test/javaProfile.test.ts --reporter=verbose 2>&1 | tail -20
```
기대: `openjdk version "17.…"`(이 기기는 17.0.17). `java.test.ts`의 2개 테스트가 `✓`(skip 표시 `↓` 없음)이고 `javaProfile.test.ts` 8개 passed. JDK가 있는데 skip되면 `java.test.ts` 맨 위의 `java -version` 게이트가 PATH를 못 보는 것이다. `which java`와 vitest가 상속한 `PATH`를 비교해 고친다.

- [ ] **Step 3: TS 출력이 바뀌지 않았는지**

```bash
pnpm vitest run packages/core/test/snapshot.test.ts
git diff main -- packages/core/test/__snapshots__ | head -5
```
기대: passed, 스냅샷 diff 없음(Task 1에서 만든 그대로).

- [ ] **Step 4: 실제 claude로 1회(설계 §6-9)**

```bash
pnpm llm:check
pnpm llm:check --java
```
기대: 둘 다 마지막 줄 `OK (…)`. `--java`는 수 분 걸린다. FAIL이면 출력의 `.specmock-attempt/errors.md`를 읽어 프롬프트 규칙(Task 9·13의 프로필 규칙)이나 참조 발췌(Task 14)를 고치고 다시 돌린다. 3번 연속 FAIL이면 멈추고, errors.md 요약과 함께 conductor에 보고한다(PR은 "live 확인 실패"를 적어 보류).

- [ ] **Step 5: 작업 트리 정리 확인**

```bash
git status --short
git log --oneline main..HEAD
```
기대: 작업 트리 깨끗함, Task 0~18 커밋이 순서대로 있다(Task 19는 커밋 없음).

- [ ] **Step 6: PR 본문에 들어갈 요점**

PR 본문은 conductor가 쓴다. 구현자는 아래 요점과 Step 1·2·4의 실제 출력(테스트 수, java 버전, llm:check 결과 줄)만 보고에 싣는다.

- 무엇: `specmock generate/run --lang java`로 Java(Maven + Javalin) mock 생성. claude-code가 작성하고 임시 디렉터리에서 빌드·contract·런타임 계약(501·404)을 통과한 결과만 반영. 실패 시 오류를 붙여 재시도(기본 3회), 다 쓰면 exit 5와 `.specmock-attempt/`.
- 구조: `generate`를 `scaffold`(언어 무관) + `LanguageGenerator`(`TsHonoGenerator`·`LlmGenerator`)로 분리. 언어 프로필 등록표 `SUPPORTED_LANGUAGES`/`assertLanguage`. TS 출력은 바이트 동일(스냅샷 테스트).
- verify: lock의 install·start로 기동, 설치 키 마커 `.specmock-installed`, `VerifyResult.runtime`·`runtimeFailed`, coverage.md에 런타임 계약 절. 종료 코드는 `verifyFailed()`.
- 세션 모드: `--llm session` → 대화에서 작성 → `--finalize`. MCP `generate_mock(language)`·`finalize_generation`(도구 12개), SKILL.md 절차.
- 노출: CLI 옵션(`--lang/--llm/--model/--max-attempts/--finalize`), Web 생성 화면 언어 선택·시도 진행·결과, 실행 안내 하드코딩 5곳과 SKILL.md를 `launchHint`/`GenerateReport.launch`로 교체.
- 증분: 기존 소스를 프롬프트에 포함(사용자 수정 표시), 사용자가 고쳤는데 이번에 바뀐 파일을 `userModified`로 알림, 응답에서 빠진 소스 유지, 같은 mockspec이면 건너뜀(`skipped`).
- 설계와 달라진 점: 설계 문서 §12의 3A 행 11개(MCP 12개 오기 수정, 참조 발췌 위치, 세션 표식 등).
- 테스트 환경: Java 테스트는 JDK 17 있을 때만 돈다(이 기기에서 실제로 돎). CI 없음, Windows 미검증. 실제 claude 확인은 `pnpm llm:check --java` 결과.
