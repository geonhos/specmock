# record Web UI 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web UI에 단계 ⑥ 녹화를 추가해, 대상 서버 설정(target.json)·기능별 값·환경 변수 입력·녹화 실행·결과 보기를 터미널과 파일 편집 없이 끝낼 수 있게 합니다.

**Architecture:** 코어는 `target.json`에 `features`(기능별 값)를 더하고 404 안내 문구를 구분합니다. ui-server는 환경 변수 메모리 저장(`POST /env`), target 읽기 확장·쓰기(`GET`/`PUT /target`), 녹화 요청 확장(`features`·`apply`), 마지막 결과(`GET /record/last`), 단계 플래그 `record`를 더합니다. web은 새 화면 `Record.tsx`와 6단계 막대를 넣고 ⑤의 `RecordCard`를 링크로 바꿉니다. 설계: `docs/superpowers/specs/2026-11-25-record-web-ui-design.md`.

**Tech Stack:** TypeScript, zod, Hono(ui-server), React 19 + Vite 8(web), vitest + Testing Library, Playwright(e2e). 새 의존성 없음.

**작업 규칙:** 각 Task는 "테스트 먼저 → 실패 확인 → 구현 → 통과 → 커밋" 순서입니다. 커밋 메시지는 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`을 붙입니다. `.specmock/`·`mock/`은 커밋하지 않습니다. `docs/superpowers/`가 `.git/info/exclude`에 들어 있으면 `git add -f`로 추가합니다. LLM 호출과 실제 외부 요청은 하지 않습니다. 사전 조사의 파일·줄 번호는 `.harness/record-ui-detail.md`에 있습니다(HEAD 92f41d5 기준이므로 실제 위치는 다시 확인).

---

## PR 1 — core + ui-server (이슈 #20, 브랜치 `feat/20-record-target-features`)

### Task 1: `target.json`에 `features` 추가 (core)

**Files:**
- Modify: `packages/core/src/record/target.ts` (`TargetSchema` :25-30, `Target` :32-43, `readTarget` :82-108, `TARGET_EXAMPLE` :12-17)
- Test: `packages/core/test/record/target.test.ts` (기존 파일이 있으면 그 파일에 추가)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
describe("target.features", () => {
  it("기능별 값을 읽고 ${ENV}를 치환하며 secrets에 넣는다", async () => {
    await ws.writeText(TARGET_FILE_PATH, JSON.stringify({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer ${TOKEN}" },
      params: { query: "q" },
      features: { "customers.get": { id: "${CUS_ID}" }, "pi.get": { id: "pi_1" } },
    }));
    const t = await readTarget(ws, "s", { TOKEN: "abcd1234", CUS_ID: "cus_9999" });
    expect(t.features["customers.get"]).toEqual({ id: "cus_9999" });
    expect(t.features["pi.get"]).toEqual({ id: "pi_1" });
    expect(t.secrets).toContain("cus_9999");
    expect(t.secrets).toContain("abcd1234");
  });
  it("features가 없으면 빈 객체다", async () => { /* baseUrl만 있는 파일 → t.features = {} */ });
  it("features 안의 모르는 형식(문자열이 아닌 값)은 형식 오류다", async () => {
    /* features: { "a": { id: 1 } } → readTarget이 던지는 메시지에 "features"가 들어감 */
  });
  it("TARGET_EXAMPLE은 스키마를 통과한다", () => {
    expect(() => TargetSchema.parse(JSON.parse(TARGET_EXAMPLE))).not.toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm vitest run packages/core/test/record/target.test.ts` → `features` 속성 없음으로 실패.

- [ ] **Step 3: 구현**

```ts
// TargetSchema
features: z.record(z.string(), z.record(z.string(), z.string())).optional(),
// Target
features: Record<string, Record<string, string>>;
// readTarget: headers·params 치환 다음에
const features: Record<string, Record<string, string>> = {};
for (const [fid, map] of Object.entries(parsed.features ?? {})) {
  features[fid] = substituteCollect(map, env, secrets);   // 기존 헬퍼 재사용
}
return { ..., features, secrets };
```

`TARGET_EXAMPLE`에 다음을 더합니다(스키마 통과 확인).

```json
  "features": { "customers.get": { "id": "cus_실제값" } },
```

`TargetSchema`는 테스트에서 쓰도록 export 합니다(`core/src/index.ts`에는 내보내지 않음).

- [ ] **Step 4: 통과 확인** — 같은 명령 → 모두 통과.
- [ ] **Step 5: 커밋** — `feat(core): target.json에 기능별 값 features 추가`

### Task 2: 기능별 값 적용과 404 안내 문구 (core)

**Files:**
- Modify: `packages/core/src/record/index.ts` (호출부 :119 근처), `packages/core/src/record/drift.ts` (`statusHint` :17)
- Test: `packages/core/test/record/drift.test.ts`, `packages/core/test/record/record.test.ts` (기존 record 단위 테스트 파일에 추가)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// drift.test.ts
it("404이고 경로 변수가 샘플 값이면 기능별 값 안내를 낸다", () => {
  expect(statusHint(404, { pathVars: ["id"], unresolved: ["id"] }))
    .toBe("경로 변수 {id}에 샘플 값이 쓰였습니다. 기능별 값(features)에 실제 id를 넣으세요");
});
it("404이고 변수가 모두 지정됐으면 일반 안내를 낸다", () => {
  expect(statusHint(404, { pathVars: ["id"], unresolved: [] }))
    .toBe("`target.json`의 기능별 값 또는 params를 확인하세요");
});
// record.test.ts (가짜 fetch)
it("features 값이 params보다 우선해 경로를 채운다", async () => {
  // target.params = { id: "common" }, target.features = { "customers.get": { id: "cus_1" } }
  // record() 뒤 가짜 fetch가 받은 URL이 /v1/customers/cus_1
});
```

- [ ] **Step 2: 실패 확인** — `statusHint` 시그니처 불일치로 실패.

- [ ] **Step 3: 구현**

```ts
// index.ts 호출부
const merged = { ...target.params, ...(target.features[feature.id] ?? {}) };
const req = applyParams(feature, contract, merged);
const pathVars = [...feature.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
const unresolved = pathVars.filter(n => !(n in merged));
// statusMismatch 항목 생성 시
hint: statusHint(res.status, { pathVars, unresolved }),
```

```ts
// drift.ts
export function statusHint(status: number, ctx: { pathVars: string[]; unresolved: string[] }): string | undefined {
  if (status !== 404) return /* 기존 분기 유지 */;
  if (ctx.unresolved.length > 0) {
    const names = ctx.unresolved.map(n => `{${n}}`).join(", ");
    return `경로 변수 ${names}에 샘플 값이 쓰였습니다. 기능별 값(features)에 실제 id를 넣으세요`;
  }
  return "`target.json`의 기능별 값 또는 params를 확인하세요";
}
```

- [ ] **Step 4: 통과 확인** — `pnpm vitest run packages/core` → 통과. `pnpm typecheck`.
- [ ] **Step 5: 커밋** — `feat(core): record가 기능별 값을 우선 적용하고 샘플 id 404를 구분해 안내`

### Task 3: 환경 변수 메모리 저장 `POST /env` (ui-server)

**Files:**
- Create: `packages/ui-server/src/envStore.ts`
- Modify: `packages/ui-server/src/app.ts` (record 작업 :153-160), `packages/ui-server/src/security.ts` (`POST_ONLY` :21), `packages/ui-server/src/api-types.ts`
- Test: `packages/ui-server/test/api.test.ts` (record 묶음 :312-390의 가짜 HTTP 서버 재사용)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("POST /env 뒤 녹화가 ${TOKEN}을 치환하고 값은 어디에도 남지 않는다", async () => {
  // target.json: headers { Authorization: "Bearer ${TOKEN}" } — 가짜 서버는 Authorization이 "Bearer tok_secret_1234"일 때만 200
  const r = await app.fetch(new Request(`${BASE}/api/systems/petstore/env`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ values: { TOKEN: "tok_secret_1234" } }) }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, data: { names: ["TOKEN"] } });
  // POST /record → vi.waitFor job done → result.matched에 getPet
  // 전체 점검: JSON.stringify(job), drift.md, recorded/*.json, SSE로 받은 이벤트 전부에 "tok_secret_1234" 없음
});
it("GET /env는 405다", ...);
it("이름이 규칙에 안 맞으면 400 invalid", ...);  // { values: { "1BAD": "x" } }
```

- [ ] **Step 2: 실패 확인** — 404.

- [ ] **Step 3: 구현**

```ts
// envStore.ts
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export class EnvStore {
  #m = new Map<string, Record<string, string>>();
  set(system: string, values: Record<string, string>): string[] {
    const cur = { ...(this.#m.get(system) ?? {}) };
    for (const [k, v] of Object.entries(values)) {
      if (!NAME.test(k) || v.length > 4096) throw new InvalidBodyError(`환경 변수 이름 또는 값이 규칙에 맞지 않습니다: ${k}`);
      if (v === "") delete cur[k]; else cur[k] = v;
    }
    this.#m.set(system, cur);
    return Object.keys(cur);
  }
  names(system: string): string[] { return Object.keys(this.#m.get(system) ?? {}); }
  env(system: string): Record<string, string | undefined> { return { ...process.env, ...(this.#m.get(system) ?? {}) }; }
}
```

```ts
// app.ts
const EnvBody = z.object({ values: z.record(z.string(), z.string()) });
app.post("/api/systems/:s/env", async (c) => {
  const s = c.req.param("s"); await assertRegistered(ws, s);
  const { values } = await body(c, EnvBody);
  return c.json({ ok: true, data: { names: envStore.set(s, values) } });
});
// record 작업: recordResponses(ws, s, { ..., env: envStore.env(s) })
```

`security.ts`의 `POST_ONLY`에 `/env`를 더합니다. 로그·이벤트에 `values`를 남기지 않습니다(요청 로깅이 있으면 이 경로는 본문을 찍지 않도록).

- [ ] **Step 4: 통과 확인** — `pnpm vitest run packages/ui-server`.
- [ ] **Step 5: 커밋** — `feat(ui-server): 환경 변수를 서버 메모리에만 두는 POST /env, record에 전달`

### Task 4: target 읽기 확장과 쓰기 `GET`/`PUT /target` (ui-server)

**Files:**
- Create: `packages/ui-server/src/targetView.ts` (파일 → `TargetInfo` 변환, `PUT` 본문 → 파일 병합)
- Modify: `packages/ui-server/src/app.ts` (`GET /target` :142-152), `security.ts` (`methodGuard` PUT 허용, `POST_ONLY`에 `/target` PUT), `api-types.ts` (`TargetInfo`, `TargetPutBody`)
- Test: `packages/ui-server/test/api.test.ts` (:347 수정 포함)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("GET /target은 ${ENV} 참조는 그대로, 직접 적은 값은 ***, env 상태를 돌려준다", async () => {
  // 파일: headers { Authorization: "Bearer ${TOKEN}", "X-Plain": "plainvalue" }, params { q: "x" }, features { getPet: { id: "p1" } }
  // process.env에 TOKEN 없음, envStore에도 없음 → status "missing"
  const d = (await (await app.fetch(GET target)).json()).data;
  expect(d.target.headers).toEqual([
    { name: "Authorization", value: "Bearer ${TOKEN}", literal: false },
    { name: "X-Plain", value: "***", literal: true },
  ]);
  expect(d.env).toEqual([{ name: "TOKEN", status: "missing" }]);
  expect(JSON.stringify(d)).not.toContain("plainvalue");
  // POST /env TOKEN → status "session"; process.env.TOKEN 설정 후 → "process"
});
it("PUT /target은 파일을 쓰고 keep은 기존 값을 지킨다", async () => {
  // PUT { baseUrl, headers: [{ name: "X-Plain", keep: true }, { name: "Authorization", value: "Bearer ${TOKEN}" }], params: [], features: { getPet: [{ name: "id", value: "p2" }] } }
  // 파일을 읽어 X-Plain === "plainvalue", features.getPet.id === "p2"
});
it("PUT /target에서 없는 이름을 keep하면 400", ...);
it("PUT /target 형식 오류(baseUrl에 query)는 400", ...);
```

기존 :347 테스트("headers·params를 싣지 않음")는 위 첫 테스트로 대체합니다.

- [ ] **Step 2: 실패 확인**.

- [ ] **Step 3: 구현**

```ts
// targetView.ts
const ONLY_REFS = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\})+$/;   // 참조만으로 이루어진 값
export function toEntries(map: Record<string, string>) {
  return Object.entries(map).map(([name, value]) => ONLY_REFS.test(value)
    ? { name, value, literal: false } : { name, value: "***", literal: true });
}
export function envNames(raw: RawTarget): string[] { /* headers·params·features 값의 ${NAME} 전부, 중복 제거 */ }
export function envStatus(names: string[], store: EnvStore, system: string) {
  return names.map(name => ({ name, status: process.env[name] ? "process" : store.names(system).includes(name) ? "session" : "missing" }));
}
export function mergePut(body: TargetPutBody, existing: RawTarget | null): RawTarget {
  const pick = (items, prev) => Object.fromEntries(items.map(i => {
    if (i.keep) { if (!prev || !(i.name in prev)) throw new InvalidBodyError(`기존 값이 없어 유지할 수 없습니다: ${i.name}`); return [i.name, prev[i.name]]; }
    return [i.name, i.value ?? ""];
  }));
  const features = Object.fromEntries(Object.entries(body.features).map(([fid, items]) => [fid, pick(items, existing?.features?.[fid])]).filter(([, m]) => Object.keys(m).length > 0));
  return TargetSchema.parse({ baseUrl: body.baseUrl, timeoutMs: body.timeoutMs, headers: pick(body.headers, existing?.headers), params: pick(body.params, existing?.params), features });
}
```

`GET /target`은 **원문 파일**(치환 전)을 읽어야 참조를 그대로 보여 줄 수 있습니다. `readTarget`은 치환된 값을 돌려주므로, 원문은 `ws.readJson(TARGET_FILE)` 뒤 `TargetSchema.parse`로 읽고, 형식 확인은 기존 `readTarget(ws, s, ANY_ENV)`를 그대로 씁니다. `PUT`은 `mergePut` 결과를 `ws.write(TARGET_FILE, …)`로 쓰고 `GET`과 같은 응답을 돌려줍니다. `methodGuard`가 PUT을 허용하도록 넓히고, `POST_ONLY`에 `/target`의 PUT을 넣습니다(GET은 계속 허용).

- [ ] **Step 4: 통과 확인**.
- [ ] **Step 5: 커밋** — `feat(ui-server): GET /target 내용 확장(참조 그대로·직접 값 가림·env 상태), PUT /target`

### Task 5: 녹화 요청 확장, 마지막 결과, 단계 플래그 (ui-server)

**Files:**
- Modify: `packages/ui-server/src/app.ts` (`RecordBody` :19, record 작업), `packages/ui-server/src/systems.ts` (:15-27, :54-70), `api-types.ts` (`SystemSummary.steps`·`stale`, `RecordLast`), `errors.ts` (`알 수 없는 기능 id` → 400)
- Test: `packages/ui-server/test/api.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("POST /record는 features·apply를 받고 apply:false면 generate가 돌지 않는다", async () => {
  // body { features: ["getPet"], apply: false } → job-done, result.result.recorded = ["getPet"], result.result.applied === null
});
it("모르는 기능 id는 400 invalid", ...);         // { features: ["nope"] }
it("GET /record/last는 drift.md와 녹화 목록(상태·시각)을 돌려주고 본문은 싣지 않는다", async () => {
  // 녹화 1회 뒤: exists true, driftMarkdown이 "# petstore 실제 시스템 대조"로 시작, recorded = [{ featureId: "getPet", status: 200, at: ISO }]
  // JSON.stringify(data)에 가짜 서버 응답 본문의 고유 문자열이 없음
});
it("steps.record와 stale.record", async () => {
  // 녹화 전 false; 녹화 뒤 true; mockspec.json을 다시 쓰면(선택 변경) stale.record true
});
```

- [ ] **Step 2: 실패 확인**.

- [ ] **Step 3: 구현**

```ts
const RecordBody = z.object({ allowMutating: z.boolean().optional(), refresh: z.boolean().optional(),
  features: z.array(z.string()).optional(), apply: z.boolean().optional() });
// 작업: recordResponses(ws, s, { allowMutating, refresh, features, apply, env: envStore.env(s), signal, onEvent })
// 모르는 id는 jobs.start 전에 검사: mockspec의 contracts 기능 id 집합과 비교해 없으면 InvalidBodyError (코어 메시지 "알 수 없는 기능 id"를 toApiError에서 400으로 매핑하는 방법도 가능; 하나만 택함)

app.get("/api/systems/:s/record/last", async (c) => {
  const s = c.req.param("s"); await assertRegistered(ws, s);
  const drift = await ws.readTextIfExists(`${s}/drift.md`);
  const files = await ws.list(`${s}/recorded`);           // 없으면 []
  const recorded = await Promise.all(files.map(async f => {
    const r = RecordedSchema.parse(await ws.readJson(f));
    return { featureId: r.featureId, status: r.status, at: r.recordedAt ?? (await ws.stat(f)).mtime.toISOString() };
  }));
  return c.json({ ok: true, data: { exists: drift !== null, driftMarkdown: drift ?? undefined, recordedAt: drift?.match(/\((\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1], recorded } });
});
```

`RecordedSchema`의 실제 필드 이름(`featureId`·`status`·시각)은 `core/src/record/recorded.ts`에서 확인해 맞춥니다. `systems.ts`의 단계 판정에 `record: exists(drift.md)`, `stale.record: mtime(mockspec.json) > mtime(drift.md)`를 더합니다. `/record/last`는 GET이므로 `POST_ONLY`의 `/record` 정규식이 `/record/last`를 막지 않도록 정규식을 `\/record$`로 조정합니다.

- [ ] **Step 4: 통과 확인** — `pnpm typecheck && pnpm test`.
- [ ] **Step 5: 커밋** — `feat(ui-server): record 요청에 features·apply, GET /record/last, 단계 플래그 record`

### Task 6: 문서와 PR 1

**Files:**
- Modify: `README.md`("실제 시스템 녹화" 절), `packages/plugin/**/SKILL.md`(record 절), `packages/mcp/src/tools/mock.ts:140`(설명 문구), `docs/superpowers/specs/2026-11-09-phase3b-record-design.md`(끝에 `## 개정(2026-11-25)`)

- [ ] **Step 1: README** — `features` 형식(설계 §3.1 JSON), "specmock 이전 버전은 `features` 키가 있는 파일을 형식 오류로 거부합니다", Web 화면 ⑥(PR 2에서 생김)은 "다음 PR" 표시 없이 설계대로 적되 PR 2 머지 전까지는 CLI 절만 갱신.
- [ ] **Step 2: SKILL.md·MCP 설명** — "`target.json`의 `features.<기능id>` 값이 공통 `params`보다 우선합니다" 한 줄.
- [ ] **Step 3: 3B 설계 개정 절**

```markdown
## 개정(2026-11-25)

`docs/superpowers/specs/2026-11-25-record-web-ui-design.md`가 다음 세 결정을 바꿉니다.
- :33 "Web은 실행 버튼과 결과 보기만(target 편집 없음)" → Web 화면 ⑥에서 target을 편집합니다. 키는 `${ENV}` 참조로만 파일에 남고, 값은 ui-server 메모리에만 둡니다.
- :42 비목표 "Web에서 target.json 편집" → 목표로 바뀝니다.
- :90 "params는 모든 기능에 공통 적용" → `features.<기능id>`가 공통 `params`보다 우선합니다.
```

- [ ] **Step 4: 전체 확인** — `pnpm typecheck && pnpm test`(모두 통과), 테스트 수 기록.
- [ ] **Step 5: 커밋·push·PR** — `docs: target features, Web target 편집으로 3B 설계 개정`. PR 제목 `feat: record 기능별 값(features)과 ui-server target 편집·env 입력 API (#20)`, 본문은 `.harness/pr-record-1.md`(요약 표, 동작 변화, 검증, `Closes #20`, 끝에 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`). 머지는 conductor.

---

## PR 2 — web 화면 ⑥ (이슈 #21, 브랜치 `feat/21-record-screen`, PR 1 머지 뒤 main에서 시작)

### Task 7: 경로·단계 막대·사이드바 6단계

**Files:**
- Modify: `packages/web/src/route.ts`(:3, :6, :10), `components/StepBar.tsx`(:4-13), `components/Sidebar.tsx`(단계 점), `App.tsx`(:15-22, :96-105), `api.ts`(타입 import)
- Test: `packages/web/test/route.test.ts`, `test/App.test.tsx`, `test/StepBar.test.tsx`(있으면)

- [ ] **Step 1: 실패하는 테스트**

```ts
it("parseRoute가 /systems/stripe/record를 record 화면으로 푼다", () => {
  expect(parseRoute("/systems/stripe/record")).toEqual({ screen: "record", system: "stripe" });
});
it("StepBar는 6단계를 그리고 generate 완료면 ⑥ 녹화에 갈 수 있다", () => {
  // steps { analyze:true, select:true, generate:true, verify:false, record:false } → "⑥ 녹화" 링크 활성
  // stale.record true → "다시 실행 필요" 표시
});
```

- [ ] **Step 2: 실패 확인** — `pnpm vitest run --project web`.
- [ ] **Step 3: 구현** — `Screen`에 `"record"`, `STEP_SCREENS` 6개, `parseRoute` 정규식에 `record`, `LABELS` `["① 등록","② 분석","③ 선택","④ 생성","⑤ 검증","⑥ 녹화"]`(기존 라벨 문구 유지), `reachable(record) = steps.generate`, `TITLES.record = "실제 서버와 대조"`, App 분기 `<Record … />`(Task 8에서 만들 컴포넌트; 이 Task에서는 빈 카드 반환). Sidebar 점 6개.
- [ ] **Step 4: 통과 확인**.
- [ ] **Step 5: 커밋** — `feat(web): 단계 ⑥ 녹화 경로와 6단계 막대`

### Task 8: 화면 ⑥ 구역 A — 대상 서버 설정 폼과 환경 변수

**Files:**
- Create: `packages/web/src/screens/Record.tsx`, `packages/web/src/components/TargetForm.tsx`, `packages/web/src/components/EnvTable.tsx`
- Modify: `packages/web/src/api.ts`(`target`, `putTarget`, `setEnv`, `recordLast`, `record(name, body)`), `styles/app.css`
- Test: `packages/web/test/Record.test.tsx`

- [ ] **Step 1: 실패하는 테스트**

```tsx
it("설정이 없으면 폼이 펼쳐지고 녹화 버튼이 막힌 이유를 보인다", async () => {
  const api = fakeApi({ "GET /api/systems/stripe/target": { exists: false, example: "…" }, "GET /api/systems/stripe/record/last": { exists: false, recorded: [] }, "GET /api/systems/stripe/features": { total: 0, rows: [], groups: [] } });
  render(<Record system="stripe" … />);
  expect(await screen.findByRole("group", { name: "대상 서버 설정" })).toBeVisible();
  const btn = screen.getByRole("button", { name: /녹화/ });
  expect(btn).toBeDisabled();
  expect(screen.getByText("먼저 대상 서버 설정을 저장하세요")).toBeInTheDocument();
});
it("저장은 PUT /target 본문에 헤더·공통 값·keep을 담는다", async () => {
  // GET target: headers [{Authorization,"Bearer ${TOKEN}",false},{X-Plain,"***",true}] → 폼에서 baseUrl 수정 후 저장
  // bodies["PUT /api/systems/stripe/target"][0].headers 가 [{name:"Authorization",value:"Bearer ${TOKEN}"},{name:"X-Plain",keep:true}]
});
it("직접 적은 헤더 값에는 안내가 뜬다", async () => { /* 값 "abc" 입력 → "이 값은 파일에 그대로 남습니다" */ });
it("환경 변수가 미설정이면 녹화가 막히고, 이번 세션에 사용을 누르면 POST /env 뒤 설정됨으로 바뀐다", async () => {
  // env [{TOKEN, missing}] → 버튼 막힘 이유 "환경 변수 1개가 미설정입니다" → 입력 "x" + 클릭 → bodies["POST /api/systems/stripe/env"][0] = { values: { TOKEN: "x" } } → GET target 재호출(응답 session) → 상태 "설정됨(화면 입력)"
});
```

- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현** — `Record.tsx`는 `useEffect`로 `api.target`·`api.recordLast`·`api.features`를 불러 상태를 들고, 구역 A에 `TargetForm`(폼 상태는 `TargetInfo`에서 만든 편집용 모델: `{ baseUrl, timeoutSec, headers: {name, value, literal, keep}[], params: 같은 모양, features: Record<id, 같은 모양> }`), `EnvTable`(이름·상태 문구·`<input type="password">`·버튼). 저장 시 모델 → `TargetPutBody`(literal이고 바뀌지 않은 항목은 `{name, keep:true}`). `Register.tsx`의 `form`·`label.field` 패턴과 `Notice`를 씁니다. 상태 문구 매핑: `process → "설정됨(서버)"`, `session → "설정됨(화면 입력)"`, `missing → "미설정"`.
- [ ] **Step 4: 통과 확인**.
- [ ] **Step 5: 커밋** — `feat(web): 화면 ⑥ 대상 서버 설정 폼과 환경 변수 입력`

### Task 9: 화면 ⑥ 구역 B·C — 기능 표, 실행, 결과; ⑤ 카드 축소

**Files:**
- Create: `packages/web/src/components/RecordTable.tsx`
- Modify: `packages/web/src/screens/Record.tsx`, `screens/Verify.tsx`(:143 RecordCard → 링크), `format.ts`
- Delete: `packages/web/src/components/RecordCard.tsx`
- Test: `packages/web/test/Record.test.tsx`, `test/Verify.test.tsx`(:165-200 교체)

- [ ] **Step 1: 실패하는 테스트**

```tsx
it("기본 선택은 읽기 요청만이고 변경 요청 포함을 켜면 확인 창 뒤 선택할 수 있다", ...);
it("경로 변수 입력란의 값은 저장 본문 features에 들어간다", async () => {
  // rows: customers.get GET /v1/customers/{id} → 입력 "cus_1" → 저장 → body.features["customers.get"] = [{ name: "id", value: "cus_1" }]
});
it("녹화 버튼은 POST /record에 features·allowMutating·apply를 담는다", async () => {
  // 선택 2개, "mock에 반영" 해제 → { features: ["a","b"], allowMutating: false, apply: false }
});
it("job-done 뒤 표의 지난 결과와 요약이 갱신된다", async () => {
  // FakeEventSource.emit("job-done", { kind:"record", result:{ result:{ matched:["a"], statusMismatch:[{featureId:"b",expected:200,actual:404,hint:"…샘플 값…"}], … }, driftMarkdown:"# …" } })
  // 행 a "일치", 행 b "상태 불일치(기대 200, 실제 404)" + 펼치면 hint
});
it("처음 열 때 GET /record/last로 지난 결과를 채운다", ...);
// Verify.test: "⑥ 녹화로" 링크가 /systems/petstore/record를 가리킨다
```

- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현** — `RecordTable`은 `FeatureTable`의 행 모양(메서드 칩·경로 `.var`)을 재사용하고 열 다섯 개(선택·기능·요청·필요한 값·지난 결과)를 그립니다. 선택 상태는 `Set<string>`; 변경 요청 포함은 `ConfirmDialog`. 실행은 `useJob(jobs, system, "record")`와 `api.record(system, { features, allowMutating, apply })`, 409는 `err.jobId`를 watch. 결과 매핑: `matched → 일치`, `drifted → 스펙과 다름(+errors)`, `statusMismatch → 상태 불일치(기대 X, 실제 Y)(+hint)`, `skipped → 건너뜀(변경 요청)`, `failed → 실패(+reason)`, 그 밖 `미녹화`. 요약 줄은 기존 `RecordCard`의 `p.summary` 문구를 옮깁니다. `Verify.tsx`는 `<p className="hint"><a href=…>실제 서버와 대조하려면 ⑥ 녹화로</a></p>`(기존 `route` 이동 함수 사용). `RecordCard.tsx` 삭제.
- [ ] **Step 4: 통과 확인** — `pnpm vitest run --project web`, `pnpm typecheck`.
- [ ] **Step 5: 커밋** — `feat(web): 화면 ⑥ 기능 표·녹화 실행·결과, 검증 화면 카드를 링크로`

### Task 10: e2e, architecture.md, PR 2

**Files:**
- Modify: `e2e/ui.spec.ts`, `docs/architecture.md`(화면 6개, 엔드포인트 3개 추가), `README.md`(Web 화면 ⑥ 한 단락)

- [ ] **Step 1: e2e 시나리오** — 기존 OpenAPI 시나리오 뒤에: `node:http`로 가짜 실제 서버(`GET /pets/p1` 200 JSON, Authorization `Bearer tok` 필수) → ⑥ 이동 → baseUrl 입력, 헤더 `Authorization` = `Bearer ${TOKEN}` → 환경 변수 `TOKEN`에 `tok` 입력·"이번 세션에 사용" → `getPet` 행 `id` = `p1` → 저장 → 녹화 → 행 "일치" 확인. role·label만 사용.
- [ ] **Step 2: 실행** — `pnpm build && pnpm test:e2e` 통과.
- [ ] **Step 3: 문서** — architecture.md·README 갱신.
- [ ] **Step 4: 전체 확인** — `pnpm typecheck && pnpm test`, 테스트 수 기록.
- [ ] **Step 5: 커밋·push·PR** — PR 제목 `feat(web): 단계 ⑥ 녹화 화면 (#21)`, 본문 `.harness/pr-record-2.md`, `Closes #21`. 머지는 conductor.

---

## 끝난 뒤

1. 설계 문서 §11에 구현 중 바뀐 점을 적습니다.
2. 사용자가 브라우저에서 Stripe 2·3단계(설계 §5.3)를 실행합니다.
3. notes `real-use-check-stripe.md` §3·§4에 결과와 비용을 기록합니다(§4 27·29·32 "완료").
