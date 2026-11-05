# Phase 1B: 비구조 문서 분석 + LLM 어댑터 + 수확 + Claude Code 스킬 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 문서 URL, Markdown, PDF, 텍스트 스펙을 입력받아 LLM(로컬 Claude Code 구독)으로 기능을 추출하고, 1A와 같은 카탈로그 → 선택 → mock 생성 → 검증 흐름을 타게 한다. 셀렉트박스·탭 뒤 숨은 내용은 ego-browser 수확 스크립트로 가져오고, Claude Code 스킬로 대화형 사용을 지원하며, `select --interactive`를 추가한다.

**Architecture:** 1A의 결정적 코어를 그대로 두고 세 지점만 확장한다. (1) `ingest`가 문서를 정규화된 Markdown 텍스트로 `source.json`에 넣는다. (2) `analyze`가 비구조 입력을 만나면 `prepare`(청크 + 프롬프트 + 출력 스키마) → LLM 추출(`extracted/NNN.json`) → `merge`(검증 · 근거 대조 · 신뢰도 보정 · 병합)로 처리하고, OpenAPI 입력은 지금처럼 바로 변환한다. (3) LLM 호출은 `LlmAdapter` 인터페이스 뒤에 두고, `claude-code` 어댑터(`claude --print --output-format json --json-schema`)와 `session` 어댑터(Claude Code 스킬 모드에서 Claude 자신이 파일을 쓴다)를 제공한다. 모든 중간 산출물은 `.specmock/<system>/` 아래 파일이므로 CLI·스킬·(2단계) Web UI가 같은 상태를 공유한다.

**Tech Stack:** 1A 스택 + `@mozilla/readability` 0.6, `linkedom` 0.18, `turndown` 7 + `turndown-plugin-gfm` 1, `pdf-parse` 2.4, `@inquirer/checkbox` 5. LLM은 로컬 `claude` CLI(2.1.x, `--json-schema` 지원 확인됨). 수확은 로컬 `ego-browser nodejs`(설치돼 있을 때만).

**사전 확인된 사실 (2026-11-05, 이 기기):**
- `echo <prompt> | claude --print --output-format json --json-schema '<schema>' --tools "" --model sonnet` 은 JSON 한 덩어리를 출력하고, 그 안의 `structured_output` 필드에 스키마를 만족하는 객체가 들어 있다. `is_error: false`, `subtype: "success"`. 스키마에 `{"type":["object","null"]}` 같은 자유 객체와 `{}`(any) 필드를 넣어도 동작했다.
- `claude plugin validate <path>` 로 플러그인 매니페스트와 스킬 디렉터리를 검증할 수 있다. `claude --plugin-dir <dir>` 로 세션에 한해 로컬 플러그인을 로드한다.
- `ego-browser nodejs` 는 stdin 또는 `-e` 로 받은 ESM 스크립트를 Node에서 실행한다. 스크립트는 셸의 cwd와 환경변수를 상속하지 않으므로 모든 입력값과 절대 경로를 스크립트 본문에 써 넣어야 한다. API는 `taskSpace(name)` → `task.page("p1")` → `page.goto/snapshot/click/selectOption/evaluate/waitForSelector`. Playwright API는 없다.
- `pdf-parse` 2.x: `import { PDFParse } from "pdf-parse"; const p = new PDFParse({ data: buffer }); const { text } = await p.getText(); await p.destroy();`
- `@mozilla/readability` + `linkedom`: `const { document } = parseHTML(html); new Readability(document).parse()` → `{ title, content(HTML), textContent }`.

**설계 문서 대비 결정 사항 (이 계획에서 확정):**
- HTML 본문은 텍스트가 아니라 **Markdown**으로 보존한다(`turndown` + GFM 표). 코드 블록과 표가 살아 있어야 LLM이 샘플 응답과 파라미터 표를 읽을 수 있다. `source.json`의 `kind: "html"`은 유지하되 `content`는 Markdown이다.
- 수확(harvest) 결과도 Markdown 조각으로 `harvested.pages[].content`, `harvested.interactions[].content`에 넣고, prepare가 본문 뒤에 "## [수확] <label>" 섹션으로 이어 붙여 청크로 만든다. 별도 경로를 두지 않아 merge 로직이 하나다.
- LLM 출력 스키마는 **얇게** 잡는다(method, path, title, summary, params, requestBody, responses[status, schema, example], auth, evidence, confidence). 스키마 필드는 자유 객체(JSON Schema)로 받고 merge에서 ajv 컴파일을 시도해 실패하면 `null`로 바꾸고 notes에 남긴다.
- "응답 스키마 없고 샘플만 있으면 유추"(설계 5.3)는 이 단계에서 구현한다. 문서 추출에서만 나오는 경우이기 때문이다. 유추 규칙은 단순하다(값 타입 그대로, 배열은 첫 요소, 객체는 properties, required 없음).
- `select --interactive` 는 `@inquirer/checkbox` 로 만든다. 그룹별 `Separator`, `a` 전체 토글, `i` 반전은 기본 제공이고, "그룹 접기"와 `/` 필터는 두지 않는다. 대신 `--group <g>` 로 좁혀 띄울 수 있다. 설계 4.3의 축소다. 이유: 커스텀 프롬프트를 짜는 비용 대비 효용이 낮고, 2단계 Web UI가 그 역할을 맡는다.
- `--refresh` 는 **원문 캐시**를 무시하고 다시 읽는다는 뜻으로 `ingest`에 두고, `analyze --refresh` 는 이미 있는 `extracted/NNN.json`을 버리고 LLM을 다시 부른다는 뜻이다.
- catalog 변경 diff는 `analyze`가 이전 `catalog.json`을 덮어쓰기 전에 id 기준으로 비교해 "새 기능 N / 사라진 기능 M / 바뀐 기능 K"를 출력하고 `catalog-diff.json`에 남긴다. `select`는 기존 경고에 이 수치를 덧붙인다.
- `extracted/NNN.json` 이 일부만 있으면 merge는 있는 것만으로 진행하고 coverage/notes에 "청크 k개 미추출"을 남긴다(설계 6장 "멈추지 않고 기록").

**이 계획에 없는 것 (2·3단계 또는 후속):** MCP 서버, Web UI, 다른 언어 생성, Proxy/녹화, API 키 어댑터, `2XX` 범위 응답 키, `in: cookie` 파라미터, 응답 content-type 보존, gRPC/GraphQL.

---

## 파일 구조

```
specmock/
├── packages/core/
│   ├── package.json                         # + readability, linkedom, turndown(+gfm), pdf-parse
│   ├── src/
│   │   ├── types.ts                         # + SourceInput.harvested/harvestCandidate, Extraction*, AnalyzeRequest, CatalogDiff
│   │   ├── ingest/
│   │   │   ├── index.ts                     # kind별 분기, URL content-type, 캐시(--refresh), 수확 호출
│   │   │   ├── html.ts                      # HTML → Markdown (readability + turndown), 상호작용 요소 감지
│   │   │   ├── pdf.ts                       # PDF → 텍스트
│   │   │   └── fetch.ts                     # fetch 래퍼 (content-type, 타임아웃, 바이너리)
│   │   ├── analyze/
│   │   │   ├── index.ts                     # 입력 종류에 따라 openapi 직변환 / prepare→extract→merge 디스패치
│   │   │   ├── chunk.ts                     # 헤딩 기준 청크 분할
│   │   │   ├── prompt.ts                    # 추출 프롬프트 문자열 + JSON 스키마 생성
│   │   │   ├── prepare.ts                   # chunks/NNN.md + analyze-request.json
│   │   │   ├── extract.ts                   # 어댑터로 청크별 호출 → extracted/NNN.json
│   │   │   ├── merge.ts                     # 검증 · 근거 대조 · 신뢰도 · 병합 · Feature 변환 · rejected
│   │   │   ├── inferSchema.ts               # 샘플 → JSON Schema 유추
│   │   │   └── diff.ts                      # 이전 카탈로그와 비교
│   │   ├── llm/
│   │   │   ├── adapter.ts                   # LlmAdapter 인터페이스, ExtractRequest
│   │   │   ├── claudeCode.ts                # claude --print 어댑터
│   │   │   ├── session.ts                   # 세션 어댑터 (호출하지 않고 안내만)
│   │   │   └── index.ts                     # createAdapter(name)
│   │   ├── harvest/
│   │   │   ├── pageScript.ts                # 브라우저 안에서 실행될 순수 함수들 (linkedom으로 단위 테스트)
│   │   │   ├── script.ts                    # ego-browser nodejs 스크립트 생성 (pageScript 소스 삽입)
│   │   │   └── index.ts                     # isEgoBrowserAvailable, harvest(url, opts)
│   │   └── select/interactive.ts            # buildChoices(catalog, prev) — 순수 함수
│   └── test/
│       ├── fixtures/
│       │   ├── docs/pets.md                 # Markdown 문서 샘플
│       │   ├── docs/pets.html               # 탭·select·details가 있는 HTML 샘플
│       │   ├── docs/pets.pdf                # 생성 스크립트로 만든 작은 PDF
│       │   ├── docs/extracted/000.json ...  # 녹음된 LLM 응답
│       │   └── openapi/with-auth.yaml       # 골든용 인증 포함 스펙
│       ├── golden/<name>/{input, expected-catalog.json}
│       ├── bin/claude                       # 가짜 claude 실행 파일 (셸 스크립트)
│       ├── ingest-docs.test.ts, chunk.test.ts, prepare.test.ts, merge.test.ts, inferSchema.test.ts,
│       ├── llm.test.ts, extract.test.ts, diff.test.ts, golden.test.ts, harvest-page.test.ts,
│       ├── harvest-ego.test.ts (ego-browser 있을 때만), interactive.test.ts
├── packages/cli/src/
│   ├── commands/analyze.ts                  # --llm, --prepare, --merge, --model, --refresh, --json
│   ├── commands/ingest.ts                   # --harvest, --refresh, --json
│   ├── commands/select.ts                   # --interactive, --group
│   ├── commands/run.ts                      # --llm, --json
│   └── context.ts                           # formatDiff, formatPrepare
├── plugin/
│   ├── .claude-plugin/plugin.json
│   ├── README.md
│   └── skills/specmock/SKILL.md
├── scripts/live-llm-check.ts                # 실제 claude 호출 점검 (CI 제외)
├── examples/docs-sample/                    # Markdown 문서 → mock 예제 (녹음 응답 포함)
└── docs/ (설계 §12 보강, architecture.md, README)
```

---

## Part A — 문서 분석 파이프라인

### Task 1: 의존성 추가와 타입 확장

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/types.test.ts` (기존 파일에 추가)

- [ ] **Step 1: 의존성 설치**

```bash
pnpm --filter @specmock/core add @mozilla/readability@^0.6.0 linkedom@^0.18.15 turndown@^7.2.5 turndown-plugin-gfm@^1.0.2 pdf-parse@^2.4.5
pnpm --filter @specmock/core add -D @types/turndown
pnpm --filter @specmock/cli add @inquirer/checkbox@^5.2.8
```

`turndown-plugin-gfm`에는 타입이 없다. `packages/core/src/ingest/turndown-plugin-gfm.d.ts`를 만든다:

```ts
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `packages/core/test/types.test.ts`에 추가

```ts
import { AnalyzeRequestSchema, ExtractionResultSchema, extractionJsonSchema, SourceInputSchema } from "../src/types.js";

describe("Phase 1B schemas", () => {
  it("accepts harvested content and a harvest candidate on a source input", () => {
    const r = SourceInputSchema.safeParse({
      kind: "html", origin: "https://x.test/docs", fetchedAt: "2026-11-05T00:00:00Z", contentHash: "h", content: "# Docs",
      harvestCandidate: { reasons: ["select 요소 2개"] },
      harvested: { pages: [{ url: "https://x.test/docs", title: "Docs", content: "..." }], interactions: [{ type: "tab", label: "Node", content: "..." }] },
    });
    expect(r.success).toBe(true);
  });

  it("validates an extraction result and rejects a bad method", () => {
    const ok = ExtractionResultSchema.safeParse({ endpoints: [{ method: "GET", path: "/pets", title: "List", responses: [{ status: 200 }], evidence: ["GET /pets"], confidence: 0.9 }] });
    expect(ok.success).toBe(true);
    const bad = ExtractionResultSchema.safeParse({ endpoints: [{ method: "FETCH", path: "/pets", title: "", responses: [], evidence: [], confidence: 0.5 }] });
    expect(bad.success).toBe(false);
  });

  it("exports a JSON Schema for the LLM that has no $ref and marks endpoints required", () => {
    const js = extractionJsonSchema();
    expect(JSON.stringify(js)).not.toContain("$ref");
    expect(js.required).toEqual(["endpoints"]);
  });

  it("validates an analyze request", () => {
    const r = AnalyzeRequestSchema.safeParse({
      system: "s", createdAt: "2026-11-05T00:00:00Z", prompt: "p", schema: { type: "object" },
      chunks: [{ index: 0, file: "chunks/000.md", inputIndex: 0, heading: "Pets", chars: 120 }],
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 3: 실행해 실패 확인**

Run: `pnpm build:core && pnpm vitest run packages/core/test/types.test.ts`
Expected: FAIL — `AnalyzeRequestSchema` 등이 export되지 않음.

- [ ] **Step 4: 타입 추가** — `packages/core/src/types.ts`

`SourceInputSchema`를 다음으로 교체한다.

```ts
export const HarvestedSchema = z.object({
  pages: z.array(z.object({ url: z.string(), title: z.string(), content: z.string() })).default([]),
  interactions: z.array(z.object({
    type: z.enum(["tab", "select", "details", "listbox"]),
    label: z.string(),
    content: z.string(),
  })).default([]),
  notes: z.array(z.string()).default([]),
});
export type Harvested = z.infer<typeof HarvestedSchema>;

export const SourceInputSchema = z.object({
  kind: z.enum(["openapi", "html", "markdown", "pdf", "text"]),
  origin: z.string(),
  fetchedAt: z.string(),
  contentHash: z.string(),
  content: z.string(),
  title: z.string().optional(),
  /** ingest가 상호작용 요소를 감지했을 때. 수확 전이면 reasons만, 수확 후면 harvested가 채워진다. */
  harvestCandidate: z.object({ reasons: z.array(z.string()) }).optional(),
  harvested: HarvestedSchema.optional(),
});
```

파일 끝에 추가한다.

```ts
/* ---------- LLM 추출 (analyze prepare/extract/merge) ---------- */

/** LLM이 청크 하나에서 돌려주는 항목. 얇게 유지한다. 검증·보정은 merge가 한다. */
export const ExtractedParamSchema = z.object({
  name: z.string().min(1),
  required: z.boolean().default(false),
  schema: JsonSchema.nullable().default(null),
  description: z.string().default(""),
});

export const ExtractedResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  schema: JsonSchema.nullable().default(null),
  example: z.unknown().optional(),
  description: z.string().default(""),
});

export const ExtractedEndpointSchema = z.object({
  method: HttpMethod,
  path: z.string().min(1),
  title: z.string(),
  summary: z.string().default(""),
  group: z.string().default(""),
  auth: z.enum(["bearer", "apiKey", "basic", "none", "unknown"]).default("unknown"),
  pathParams: z.array(ExtractedParamSchema).default([]),
  queryParams: z.array(ExtractedParamSchema).default([]),
  headers: z.array(ExtractedParamSchema).default([]),
  requestBody: JsonSchema.nullable().default(null),
  requestExample: z.unknown().optional(),
  responses: z.array(ExtractedResponseSchema),
  evidence: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  inferred: z.object({ method: z.boolean().default(false), path: z.boolean().default(false) }).default({ method: false, path: false }),
});
export type ExtractedEndpoint = z.infer<typeof ExtractedEndpointSchema>;

export const ExtractionResultSchema = z.object({ endpoints: z.array(ExtractedEndpointSchema) });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * `claude --json-schema`에 넘길 JSON Schema. zod 변환 결과에서 `$schema`를 떼고,
 * 자유 객체(JsonSchema 자리)는 `{"type":["object","null"]}`로 단순화한다.
 */
export function extractionJsonSchema(): Record<string, unknown> & { required?: string[] } {
  const js = z.toJSONSchema(ExtractionResultSchema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  delete js.$schema;
  return js as Record<string, unknown> & { required?: string[] };
}

export const ChunkInfoSchema = z.object({
  index: z.number().int().min(0),
  file: z.string(),          // workspace 상대 경로 "chunks/000.md"
  inputIndex: z.number().int().min(0),
  heading: z.string(),
  chars: z.number().int().min(0),
});
export type ChunkInfo = z.infer<typeof ChunkInfoSchema>;

/** `.specmock/<system>/analyze-request.json` — prepare 결과. 스킬 모드에서 Claude가 읽는 작업 지시서. */
export const AnalyzeRequestSchema = z.object({
  system: z.string().min(1),
  createdAt: z.string(),
  prompt: z.string(),
  schema: z.record(z.string(), z.unknown()),
  chunks: z.array(ChunkInfoSchema),
  /** OpenAPI 입력에서 이미 결정적으로 뽑은 기능 수. merge가 합칠 때 참고용. */
  openapiFeatures: z.number().int().min(0).default(0),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

/** `.specmock/<system>/catalog-diff.json` — analyze가 이전 카탈로그와 비교한 결과. */
export const CatalogDiffSchema = z.object({
  previousAt: z.string().nullable(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type CatalogDiff = z.infer<typeof CatalogDiffSchema>;
```

`CatalogSchema.rejected` 항목에 `chunk` 를 선택 필드로 추가한다: `z.object({ raw: z.unknown(), reason: z.string(), chunk: z.number().int().optional() })`.

- [ ] **Step 5: index.ts 재export** — `export * from "./types.js"` 가 이미 있으므로 추가 작업 없음. `extractionJsonSchema`가 함수라도 `export *`에 포함된다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm build:core && pnpm vitest run packages/core/test/types.test.ts`
Expected: PASS. `z.toJSONSchema`가 `z.unknown()`을 `{}`로, nullable 레코드를 `anyOf`로 낼 수 있다. `$ref`가 나오면 `{ reused: "inline" }` 옵션을 추가한다(zod 4 옵션명 확인: `z.toJSONSchema(schema, { reused: "inline" })`).

- [ ] **Step 7: 커밋**

```bash
git add packages/core/package.json packages/cli/package.json pnpm-lock.yaml packages/core/src/types.ts packages/core/src/ingest/turndown-plugin-gfm.d.ts packages/core/test/types.test.ts
git commit -m "feat(core): 1B 스키마 — 수확 결과, LLM 추출 결과, analyze-request, catalog-diff"
```

---

### Task 2: ingest — Markdown / 텍스트 / HTML / PDF 입력과 원문 캐시

**Files:**
- Create: `packages/core/src/ingest/fetch.ts`, `packages/core/src/ingest/html.ts`, `packages/core/src/ingest/pdf.ts`
- Modify: `packages/core/src/ingest/index.ts`
- Create: `packages/core/test/fixtures/docs/pets.md`, `pets.html`, `make-pdf.mjs`(→ `pets.pdf`)
- Test: `packages/core/test/ingest-docs.test.ts`

- [ ] **Step 1: 픽스처 작성**

`packages/core/test/fixtures/docs/pets.md`:

````markdown
# Pets API

Base URL: `https://api.example.com/v1`. All requests need `Authorization: Bearer <token>`.

## List pets

`GET /pets` returns an array of pets. Query `limit` (integer, max 100).

```json
[{"id": 1, "name": "Rex", "tag": "dog"}]
```

## Get a pet

`GET /pets/{petId}` returns one pet. Responds `404` with `{"code": 404, "message": "not found"}` when missing.

```json
{"id": 1, "name": "Rex", "tag": "dog"}
```

## Create a pet

`POST /pets` with body `{"name": string, "tag"?: string}`. Returns `201` and the created pet.

## Delete a pet

`DELETE /pets/{petId}` returns `204`.
````

`packages/core/test/fixtures/docs/pets.html` (탭·select·details 포함. 본문은 위 Markdown과 같은 내용을 HTML로):

```html
<!doctype html>
<html><head><title>Pets API Reference</title></head>
<body>
<nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
<main>
  <h1>Pets API</h1>
  <p>Base URL: <code>https://api.example.com/v1</code>. All requests need <code>Authorization: Bearer &lt;token&gt;</code>.</p>
  <h2>List pets</h2>
  <p><code>GET /pets</code> returns an array of pets. Query <code>limit</code> (integer, max 100).</p>
  <div role="tablist">
    <button role="tab" aria-selected="true" aria-controls="tab-curl">curl</button>
    <button role="tab" aria-selected="false" aria-controls="tab-node">Node</button>
  </div>
  <div id="tab-curl" role="tabpanel"><pre>curl https://api.example.com/v1/pets</pre></div>
  <div id="tab-node" role="tabpanel" hidden><pre>await fetch("https://api.example.com/v1/pets")</pre></div>
  <pre><code class="language-json">[{"id": 1, "name": "Rex", "tag": "dog"}]</code></pre>
  <h2>Get a pet</h2>
  <p><code>GET /pets/{petId}</code> returns one pet.</p>
  <label>Response example <select id="resp"><option value="200">200</option><option value="404">404</option></select></label>
  <pre id="resp-200"><code>{"id": 1, "name": "Rex", "tag": "dog"}</code></pre>
  <pre id="resp-404" hidden><code>{"code": 404, "message": "not found"}</code></pre>
  <details><summary>Create a pet</summary>
    <p><code>POST /pets</code> with body <code>{"name": string, "tag"?: string}</code>. Returns <code>201</code> and the created pet.</p>
  </details>
  <table><thead><tr><th>Field</th><th>Type</th></tr></thead><tbody><tr><td>name</td><td>string</td></tr><tr><td>tag</td><td>string</td></tr></tbody></table>
  <h2>Delete a pet</h2>
  <p><code>DELETE /pets/{petId}</code> returns <code>204</code>.</p>
</main>
<footer>© Example</footer>
<script>
document.getElementById("resp").addEventListener("change", (e) => {
  document.getElementById("resp-200").hidden = e.target.value !== "200";
  document.getElementById("resp-404").hidden = e.target.value !== "404";
});
for (const t of document.querySelectorAll("[role=tab]")) t.addEventListener("click", () => {
  for (const x of document.querySelectorAll("[role=tab]")) { x.setAttribute("aria-selected", String(x === t)); document.getElementById(x.getAttribute("aria-controls")).hidden = x !== t; }
});
</script>
</body></html>
```

`packages/core/test/fixtures/docs/make-pdf.mjs` — 외부 의존성 없이 텍스트 한 페이지짜리 PDF를 만든다(pdf-parse가 읽을 수 있는 최소 구조). 한 번 실행해 `pets.pdf`를 커밋한다.

```js
// node packages/core/test/fixtures/docs/make-pdf.mjs
import { writeFileSync } from "node:fs";
const lines = ["Pets API", "GET /pets returns an array of pets.", "GET /pets/{petId} returns one pet.", "DELETE /pets/{petId} returns 204."];
const content = lines.map((l, i) => `BT /F1 12 Tf 40 ${780 - i * 18} Td (${l.replace(/[()\\]/g, (c) => "\\" + c)}) Tj ET`).join("\n");
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let out = "%PDF-1.4\n"; const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(out);
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL("./pets.pdf", import.meta.url), out, "latin1");
```

- [ ] **Step 2: 실패하는 테스트 작성** — `packages/core/test/ingest-docs.test.ts`

```ts
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { detectInteractive, htmlToMarkdown } from "../src/ingest/html.js";
import { ingest, ingestOne } from "../src/ingest/index.js";
import { SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, "fixtures", "docs");

describe("htmlToMarkdown", () => {
  it("keeps headings, code blocks and tables, drops nav/footer", async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    const { title, markdown } = htmlToMarkdown(html, "https://x.test/docs");
    expect(title).toBe("Pets API Reference");
    expect(markdown).toContain("## List pets");
    expect(markdown).toContain('[{"id": 1, "name": "Rex", "tag": "dog"}]');
    expect(markdown).toMatch(/\| *Field *\| *Type *\|/);
    expect(markdown).not.toContain("© Example");
  });

  it("detects interactive elements with reasons", async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    const r = detectInteractive(html, 5000);
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringContaining("select"), expect.stringContaining("tab"), expect.stringContaining("details")]));
    expect(detectInteractive("<html><body><p>" + "x".repeat(3000) + "</p></body></html>", 3000).reasons).toEqual([]);
    expect(detectInteractive("<html><body><p>short</p></body></html>", 5).reasons).toEqual(["본문 2,000자 미만"]);
  });
});

describe("ingestOne for documents", () => {
  it("keeps markdown as is", async () => {
    const input = await ingestOne(path.join(DOCS, "pets.md"));
    expect(input.kind).toBe("markdown");
    expect(input.content).toContain("## Get a pet");
    expect(input.title).toBe("Pets API");
  });

  it("extracts text from a pdf", async () => {
    const input = await ingestOne(path.join(DOCS, "pets.pdf"));
    expect(input.kind).toBe("pdf");
    expect(input.content).toContain("GET /pets/{petId} returns one pet.");
  });

  it("treats unknown extensions as text", async () => {
    const input = await ingestOne(path.join(DOCS, "make-pdf.mjs"));
    expect(input.kind).toBe("text");
  });
});

describe("ingest over http", () => {
  let server: Server; let base: string; let hits = 0;
  beforeAll(async () => {
    const html = await readFile(path.join(DOCS, "pets.html"), "utf8");
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === "/docs") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); return; }
      if (req.url === "/spec") { res.setHeader("content-type", "application/yaml"); res.end("openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths: {}\n"); return; }
      res.statusCode = 404; res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  let dir: string; let ws: Workspace;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-ingest-")); ws = new Workspace(dir); hits = 0; });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("detects html by content-type, converts to markdown and flags a harvest candidate", async () => {
    await ingest(ws, "pets", [`${base}/docs`]);
    const src = await ws.read("pets", "source.json", SourceSchema);
    expect(src.inputs[0].kind).toBe("html");
    expect(src.inputs[0].content).toContain("## Get a pet");
    expect(src.inputs[0].harvestCandidate?.reasons.length).toBeGreaterThan(0);
    expect(src.inputs[0].harvested).toBeUndefined();
  });

  it("detects openapi by content-type even without an extension", async () => {
    await ingest(ws, "spec", [`${base}/spec`]);
    const src = await ws.read("spec", "source.json", SourceSchema);
    expect(src.inputs[0].kind).toBe("openapi");
  });

  it("reuses the cached input unless refresh is set", async () => {
    await ingest(ws, "pets", [`${base}/docs`]);
    const first = (await ws.read("pets", "source.json", SourceSchema)).inputs[0].fetchedAt;
    await ingest(ws, "pets", [`${base}/docs`]);
    expect(hits).toBe(1);
    expect((await ws.read("pets", "source.json", SourceSchema)).inputs[0].fetchedAt).toBe(first);
    await ingest(ws, "pets", [`${base}/docs`], { refresh: true });
    expect(hits).toBe(2);
  });

  it("fails clearly on 404", async () => {
    await expect(ingest(ws, "x", [`${base}/missing`])).rejects.toThrow(/HTTP 404/);
  });
});
```

- [ ] **Step 3: 실행해 실패 확인**

Run: `node packages/core/test/fixtures/docs/make-pdf.mjs && pnpm build:core && pnpm vitest run packages/core/test/ingest-docs.test.ts`
Expected: FAIL — `../src/ingest/html.js` 없음.

- [ ] **Step 4: fetch 래퍼** — `packages/core/src/ingest/fetch.ts`

```ts
export interface Fetched {
  bytes: Uint8Array;
  contentType: string; // 소문자, 파라미터 제거. 예: "text/html"
  finalUrl: string;
}

export async function fetchOrigin(url: string, timeoutMs = 30_000): Promise<Fetched> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json, application/yaml, text/yaml, text/markdown, text/html, application/pdf, text/plain, */*",
      "user-agent": "specmock/0.1 (+https://github.com/geonhos/specmock)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} 요청 실패: HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType, finalUrl: res.url || url };
}
```

- [ ] **Step 5: HTML → Markdown과 상호작용 감지** — `packages/core/src/ingest/html.ts`

```ts
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MIN_BODY_CHARS = 2000;

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use(gfm);
  // <pre><code class="language-json"> 의 언어 힌트를 펜스에 남긴다.
  td.addRule("fencedWithLang", {
    filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
    replacement: (_c, node) => {
      const code = node.firstChild as HTMLElement;
      const lang = (code.getAttribute("class") ?? "").match(/language-([\w-]+)/)?.[1] ?? "";
      return `\n\n\`\`\`${lang}\n${code.textContent ?? ""}\n\`\`\`\n\n`;
    },
  });
  return td;
}

/** hidden 요소는 Readability가 버리므로, 변환 전에 hidden/aria-hidden을 벗겨 탭 패널·접힌 응답 예시도 본문에 남긴다. */
function unhide(document: Document): void {
  for (const el of document.querySelectorAll("[hidden], [aria-hidden='true'], details")) {
    el.removeAttribute("hidden");
    el.removeAttribute("aria-hidden");
    if (el.tagName === "DETAILS") el.setAttribute("open", "");
  }
}

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  unhide(document);
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  const contentHtml = article?.content ?? document.querySelector("main, article, body")?.innerHTML ?? html;
  let markdown = turndown().turndown(contentHtml).trim();
  if (markdown.length === 0) markdown = (document.body?.textContent ?? "").trim();
  return { title: article?.title?.trim() || title, markdown: `<!-- source: ${url} -->\n\n${markdown}\n` };
}

export interface InteractiveReport { reasons: string[] }

/** 설계 5.1의 감지 규칙. bodyChars는 변환된 본문 길이. */
export function detectInteractive(html: string, bodyChars: number): InteractiveReport {
  const { document } = parseHTML(html);
  const reasons: string[] = [];
  if (bodyChars < MIN_BODY_CHARS) reasons.push("본문 2,000자 미만");
  const count = (sel: string) => document.querySelectorAll(sel).length;
  const selects = count("select");
  if (selects) reasons.push(`select 요소 ${selects}개`);
  const tabs = count("[role='tab']");
  if (tabs) reasons.push(`tab 요소 ${tabs}개`);
  const details = count("details");
  if (details) reasons.push(`details 요소 ${details}개`);
  const combos = count("[role='combobox'], [role='listbox']");
  if (combos) reasons.push(`combobox/listbox 요소 ${combos}개`);
  if (/show more|더 ?보기|load more/i.test(document.body?.textContent ?? "")) reasons.push('"Show more"/"더 보기" 텍스트');
  return { reasons };
}
```

- [ ] **Step 6: PDF** — `packages/core/src/ingest/pdf.ts`

```ts
import { PDFParse } from "pdf-parse";

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    // 페이지 경계를 헤딩처럼 남겨 청크 분할이 페이지 단위로도 끊을 수 있게 한다.
    return result.pages.map((p, i) => `## [page ${i + 1}]\n\n${p.text.trim()}`).join("\n\n") + "\n";
  } finally {
    await parser.destroy();
  }
}
```

- [ ] **Step 7: ingest 통합** — `packages/core/src/ingest/index.ts` 전체 교체

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashText } from "../util/hash.js";
import { SourceSchema, type Source, type SourceInput } from "../types.js";
import type { Workspace } from "../workspace.js";
import { fetchOrigin } from "./fetch.js";
import { detectInteractive, htmlToMarkdown } from "./html.js";
import { maskSecrets } from "./mask.js";
import { dereferenceOpenApi, isOpenApiDocument, parseSpecText, stringifyCycleSafe } from "./openapi.js";
import { pdfToText } from "./pdf.js";

export type InputKind = SourceInput["kind"];

const TEXT_DECODER = new TextDecoder("utf-8");

function extOf(origin: string): string {
  return path.extname(origin.split(/[?#]/)[0]).toLowerCase();
}

/** 확장자·content-type·내용으로 종류를 정한다. content-type은 URL일 때만 온다. */
export function detectKind(origin: string, text: string, contentType = ""): InputKind {
  const ext = extOf(origin);
  if (contentType === "application/pdf" || ext === ".pdf") return "pdf";
  const looksStructured = ext === ".json" || ext === ".yaml" || ext === ".yml" || /json|yaml/.test(contentType) || text.trimStart().startsWith("{");
  if (looksStructured) {
    try {
      if (isOpenApiDocument(parseSpecText(text))) return "openapi";
    } catch {
      // 파싱 실패는 아래 규칙으로 넘긴다.
    }
  }
  if (/^\s*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(text.slice(0, 2000))) return "openapi";
  if (contentType === "text/markdown" || ext === ".md" || ext === ".markdown") return "markdown";
  if (contentType === "text/html" || ext === ".html" || ext === ".htm" || /^\s*<(!doctype|html)/i.test(text.slice(0, 500))) return "html";
  if (/^https?:\/\//.test(origin) && contentType === "" ) return "html";
  return "text";
}

async function readOrigin(origin: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (/^https?:\/\//.test(origin)) {
    const f = await fetchOrigin(origin);
    return { bytes: f.bytes, contentType: f.contentType };
  }
  return { bytes: new Uint8Array(await readFile(origin)), contentType: "" };
}

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export async function ingestOne(origin: string): Promise<SourceInput> {
  const { bytes, contentType } = await readOrigin(origin);
  const fetchedAt = new Date().toISOString();
  const text = contentType === "application/pdf" || extOf(origin) === ".pdf" ? "" : TEXT_DECODER.decode(bytes);
  const kind = detectKind(origin, text, contentType);
  const base = { kind, origin, fetchedAt } as const;

  if (kind === "openapi") {
    const doc = await dereferenceOpenApi(origin, parseSpecText(text));
    const content = maskSecrets(stringifyCycleSafe(doc));
    return { ...base, contentHash: hashText(content), content };
  }
  if (kind === "pdf") {
    const content = maskSecrets(await pdfToText(bytes));
    return { ...base, contentHash: hashText(content), content, title: firstHeading(content) };
  }
  if (kind === "html") {
    const { title, markdown } = htmlToMarkdown(text, origin);
    const content = maskSecrets(markdown);
    const { reasons } = detectInteractive(text, content.length);
    return {
      ...base, contentHash: hashText(content), content, title: title || undefined,
      ...(reasons.length ? { harvestCandidate: { reasons } } : {}),
    };
  }
  const content = maskSecrets(text);
  return { ...base, contentHash: hashText(content), content, title: firstHeading(content) };
}

export interface IngestOptions {
  /** true면 source.json에 같은 origin이 있어도 다시 읽는다. */
  refresh?: boolean;
  /** 입력 하나를 읽을 때마다 호출. CLI 진행 표시용. */
  onLog?: (message: string) => void;
}

export async function ingest(ws: Workspace, system: string, origins: string[], opts: IngestOptions = {}): Promise<string> {
  if (origins.length === 0) throw new Error("입력 파일 또는 URL을 하나 이상 지정하세요.");
  const prev: Source | null = !opts.refresh && (await ws.exists(system, "source.json"))
    ? await ws.read(system, "source.json", SourceSchema)
    : null;
  const cached = new Map((prev?.inputs ?? []).map((i) => [i.origin, i]));
  const inputs: SourceInput[] = [];
  for (const origin of origins) {
    const hit = cached.get(origin);
    if (hit) {
      opts.onLog?.(`${origin}: 캐시 재사용 (${hit.fetchedAt}). 다시 읽으려면 --refresh`);
      inputs.push(hit);
      continue;
    }
    inputs.push(await ingestOne(origin));
    opts.onLog?.(`${origin}: ${inputs[inputs.length - 1].kind} ${inputs[inputs.length - 1].content.length.toLocaleString()}자`);
  }
  return await ws.write(system, "source.json", SourceSchema, { system, inputs });
}
```

주의: 캐시는 **같은 origin 집합을 다시 ingest할 때**만 의미가 있다. origin을 바꾸면 그 입력만 새로 읽고 나머지는 재사용한다. 캐시된 입력의 `harvested`도 그대로 보존되므로 수확 결과가 날아가지 않는다(Task 9).

- [ ] **Step 8: 테스트 통과 확인**

Run: `pnpm build:core && pnpm vitest run packages/core/test/ingest-docs.test.ts packages/core/test/ingest.test.ts`
Expected: PASS. Readability가 본문을 못 찾으면(`parse()`가 null) `main/article/body` 폴백이 동작해야 한다. 표 변환이 안 되면 `gfm` 대신 `tables` 플러그인만 써 본다. linkedom의 `Document` 타입과 Readability의 DOM 타입이 어긋나면 `as unknown as Document`로 맞춘다(이미 코드에 있음).

- [ ] **Step 9: 기존 테스트 전체 확인과 커밋**

Run: `pnpm test`
Expected: 전체 PASS (기존 `detectKind` 호출부는 세 번째 인자 기본값으로 호환).

```bash
git add packages/core/src/ingest packages/core/test/ingest-docs.test.ts packages/core/test/fixtures/docs
git commit -m "feat(core): ingest — Markdown/텍스트/HTML(→Markdown)/PDF 입력, content-type 감지, 원문 캐시와 --refresh, 상호작용 요소 감지"
```

---

### Task 3: 청크 분할

**Files:**
- Create: `packages/core/src/analyze/chunk.ts`
- Test: `packages/core/test/chunk.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it } from "vitest";
import { splitIntoChunks } from "../src/analyze/chunk.js";

const md = (n: number) => `# Title\n\nintro\n\n${Array.from({ length: n }, (_, i) => `## Section ${i}\n\n${"body ".repeat(100)}\n`).join("\n")}`;

describe("splitIntoChunks", () => {
  it("returns one chunk for a short document, with the first heading", () => {
    const chunks = splitIntoChunks("# Pets API\n\nhello\n\n## List\n\nGET /pets\n", { maxChars: 6000, overlap: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("Pets API");
    expect(chunks[0].text).toContain("GET /pets");
  });

  it("splits on headings and never exceeds maxChars", () => {
    const chunks = splitIntoChunks(md(40), { maxChars: 3000, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(3000);
    // 각 청크는 헤딩으로 시작한다(첫 청크는 문서 제목).
    for (const c of chunks.slice(1)) expect(c.text).toMatch(/^## Section \d+/);
  });

  it("carries an overlap tail from the previous chunk when a section itself is too long", () => {
    const long = `## Big\n\n${"word ".repeat(2000)}`; // 10,000자
    const chunks = splitIntoChunks(long, { maxChars: 4000, overlap: 200 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const tail = chunks[0].text.slice(-200);
    expect(chunks[1].text.startsWith(tail)).toBe(true);
    for (const c of chunks) expect(c.heading).toBe("Big");
  });

  it("does not split inside a fenced code block when it can avoid it", () => {
    const doc = `## A\n\n${"x ".repeat(1500)}\n\n\`\`\`json\n${"{\"k\": 1},\n".repeat(200)}\`\`\`\n\n## B\n\nend\n`;
    const chunks = splitIntoChunks(doc, { maxChars: 3500, overlap: 100 });
    for (const c of chunks) {
      const fences = (c.text.match(/^```/gm) ?? []).length;
      expect(fences % 2, `chunk has unbalanced fences:\n${c.text.slice(0, 80)}`).toBe(0);
    }
  });

  it("is deterministic", () => {
    const a = splitIntoChunks(md(12), { maxChars: 2500, overlap: 150 });
    const b = splitIntoChunks(md(12), { maxChars: 2500, overlap: 150 });
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `pnpm vitest run packages/core/test/chunk.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `packages/core/src/analyze/chunk.ts`

```ts
export interface ChunkOptions { maxChars: number; overlap: number }
export const DEFAULT_CHUNK: ChunkOptions = { maxChars: 6000, overlap: 200 };

export interface TextChunk { heading: string; text: string }

interface Section { heading: string; text: string }

/** 헤딩(#..######) 줄 기준으로 섹션을 나눈다. 펜스 코드 블록 안의 `#`은 헤딩이 아니다. */
function sections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const out: Section[] = [];
  let heading = "";
  let buf: string[] = [];
  let inFence = false;
  const flush = () => { if (buf.length) out.push({ heading, text: buf.join("\n").trim() }); buf = []; };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) {
      flush();
      heading = m[1];
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out.filter((s) => s.text.length > 0);
}

/** 긴 텍스트를 maxChars 이하 조각으로 자른다. 자르는 지점은 빈 줄 > 줄 끝 > 강제 순으로 고르고, 펜스가 열린 채 끝나지 않게 한다. */
function hardSplit(text: string, max: number, overlap: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      let cut = window.lastIndexOf("\n\n");
      if (cut < max * 0.5) cut = window.lastIndexOf("\n");
      if (cut < max * 0.5) cut = max;
      // 펜스 균형: 잘린 조각 안의 ``` 개수가 홀수면 마지막 펜스 앞에서 자른다.
      let piece = window.slice(0, cut);
      const fences = piece.match(/^```/gm) ?? [];
      if (fences.length % 2 === 1) {
        const lastFence = piece.lastIndexOf("\n```");
        if (lastFence > max * 0.3) piece = piece.slice(0, lastFence);
      }
      end = start + piece.length;
    }
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return parts.filter((p) => p.length > 0);
}

export function splitIntoChunks(markdown: string, opts: ChunkOptions = DEFAULT_CHUNK): TextChunk[] {
  const secs = sections(markdown.replace(/\r\n/g, "\n"));
  if (secs.length === 0) return [];
  const chunks: TextChunk[] = [];
  let cur: TextChunk | null = null;
  for (const s of secs) {
    if (s.text.length > opts.maxChars) {
      if (cur) { chunks.push(cur); cur = null; }
      for (const piece of hardSplit(s.text, opts.maxChars, opts.overlap)) chunks.push({ heading: s.heading, text: piece });
      continue;
    }
    if (cur && cur.text.length + 2 + s.text.length <= opts.maxChars) {
      cur.text += "\n\n" + s.text;
    } else {
      if (cur) chunks.push(cur);
      cur = { heading: s.heading, text: s.text };
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run packages/core/test/chunk.test.ts`
Expected: PASS. 겹침 테스트가 실패하면 `hardSplit`에서 `trim()`이 꼬리를 바꾸는 것이 원인이다. 그 경우 조각 저장은 `trim()` 없이 하고 테스트의 `slice(-200)` 비교와 맞춘다.

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/analyze/chunk.ts packages/core/test/chunk.test.ts
git commit -m "feat(core): 헤딩 기준 청크 분할 (최대 6,000자, 겹침 200자, 펜스 보존)"
```

---

### Task 4: prepare — 프롬프트 · 출력 스키마 · chunks/ · analyze-request.json

**Files:**
- Create: `packages/core/src/analyze/prompt.ts`, `packages/core/src/analyze/prepare.ts`
- Test: `packages/core/test/prepare.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { prepare } from "../src/analyze/prepare.js";
import { EXTRACTION_PROMPT } from "../src/analyze/prompt.js";
import { AnalyzeRequestSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PETS_MD = path.join(here, "fixtures", "docs", "pets.md");

let dir: string; let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-prepare-")); ws = new Workspace(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("prepare", () => {
  it("writes chunks/NNN.md and analyze-request.json for a markdown input", async () => {
    await ingest(ws, "pets", [PETS_MD]);
    const req = await prepare(ws, "pets", { maxChars: 400, overlap: 50 });
    expect(req.chunks.length).toBeGreaterThan(1);
    const files = (await readdir(path.join(dir, "pets", "chunks"))).sort();
    expect(files[0]).toBe("000.md");
    expect(files).toHaveLength(req.chunks.length);
    const saved = await ws.read("pets", "analyze-request.json", AnalyzeRequestSchema);
    expect(saved.prompt).toBe(EXTRACTION_PROMPT);
    expect(saved.schema.required).toEqual(["endpoints"]);
    expect(saved.chunks[0]).toMatchObject({ index: 0, file: "chunks/000.md", inputIndex: 0 });
    const first = await readFile(path.join(dir, "pets", "chunks", "000.md"), "utf8");
    expect(first).toContain("# Pets API");
  });

  it("skips openapi inputs and counts them", async () => {
    await ingest(ws, "mixed", [PETSTORE, PETS_MD]);
    const req = await prepare(ws, "mixed");
    expect(req.openapiFeatures).toBe(5);
    for (const c of req.chunks) expect(c.inputIndex).toBe(1);
  });

  it("appends harvested pages and interactions as extra sections", async () => {
    await ingest(ws, "pets", [PETS_MD]);
    // 수확 결과를 흉내 낸다.
    const { SourceSchema } = await import("../src/types.js");
    const src = await ws.read("pets", "source.json", SourceSchema);
    src.inputs[0].harvested = {
      pages: [{ url: "https://x.test/more", title: "More", content: "## Update a pet\n\n`PATCH /pets/{petId}`" }],
      interactions: [{ type: "select", label: "Response example = 404", content: '{"code": 404}' }],
      notes: [],
    };
    await ws.write("pets", "source.json", SourceSchema, src);
    const req = await prepare(ws, "pets");
    const all = (await Promise.all(req.chunks.map((c) => readFile(path.join(dir, "pets", c.file), "utf8")))).join("\n");
    expect(all).toContain("## [수확] 페이지: More");
    expect(all).toContain("PATCH /pets/{petId}");
    expect(all).toContain("## [수확] select: Response example = 404");
  });

  it("removes stale chunk files from a previous prepare", async () => {
    await ingest(ws, "pets", [PETS_MD]);
    await prepare(ws, "pets", { maxChars: 300, overlap: 30 });
    const many = (await readdir(path.join(dir, "pets", "chunks"))).length;
    await prepare(ws, "pets");
    const few = (await readdir(path.join(dir, "pets", "chunks"))).length;
    expect(few).toBeLessThan(many);
  });

  it("throws when there is nothing to extract", async () => {
    await ingest(ws, "only", [PETSTORE]);
    await expect(prepare(ws, "only")).rejects.toThrow(/LLM 추출이 필요한 입력이 없습니다/);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `pnpm build:core && pnpm vitest run packages/core/test/prepare.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 프롬프트** — `packages/core/src/analyze/prompt.ts`

```ts
/**
 * 청크 하나를 LLM에 줄 때 앞에 붙이는 지시문. 출력 형식은 JSON 스키마(extractionJsonSchema)로 강제하므로
 * 여기서는 "무엇을 어떻게 채울지"만 말한다. 세션 어댑터(스킬 모드)에서도 같은 문장을 쓴다.
 */
export const EXTRACTION_PROMPT = `당신은 API 문서에서 HTTP 엔드포인트를 추출하는 도구입니다. 아래 "문서 청크"만 보고 답하세요. 추측으로 채우지 말고, 모르면 비워 두세요.

규칙:
1. 청크 안에서 확인되는 엔드포인트만 endpoints에 넣습니다. 없으면 빈 배열입니다.
2. method는 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS 중 하나. path는 "/"로 시작하고 경로 변수는 {name} 형태로 씁니다(":id"나 "<id>"는 {id}로 바꿉니다). base URL(호스트, /v1 같은 공통 접두)은 path에서 제외합니다. 단, 문서가 모든 경로에 접두를 붙여 쓰면 그대로 둡니다.
3. method나 path를 문맥으로 추측했으면 inferred.method / inferred.path를 true로 표시합니다.
4. responses에는 문서가 언급한 상태 코드마다 항목을 만듭니다. 샘플 응답 JSON이 있으면 example에 **원문 그대로** 파싱해 넣습니다(값을 바꾸거나 줄이지 않습니다). 스키마는 알 수 있는 범위에서 JSON Schema(type/properties/items/required/enum)로 적습니다. 모르면 null입니다.
5. pathParams/queryParams/headers/requestBody도 문서에 있는 만큼만 적습니다. 인증 헤더는 auth(bearer/apiKey/basic/none)로 표시하고 headers에는 넣지 않습니다.
6. evidence에는 그 엔드포인트가 있다고 판단한 근거가 된 **원문 문장을 글자 그대로** 1~3개 복사합니다. 바꿔 쓰지 않습니다. 이 인용은 나중에 원문과 대조됩니다.
7. confidence는 0~1. method와 path가 문서에 명시돼 있고 응답 예시까지 있으면 0.9 이상, 설명만 있으면 0.6~0.8, 추측이 섞이면 0.5 이하.
8. title은 한 줄 이름(문서의 소제목이 있으면 그것), summary는 한두 문장, group은 문서의 상위 섹션 이름이나 리소스 이름(없으면 빈 문자열).

문서 청크:
`;

export function buildChunkPrompt(chunkText: string): string {
  return `${EXTRACTION_PROMPT}\n<<<\n${chunkText}\n>>>\n`;
}
```

- [ ] **Step 4: prepare** — `packages/core/src/analyze/prepare.ts`

```ts
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { AnalyzeRequestSchema, SourceSchema, type AnalyzeRequest, type ChunkInfo, type SourceInput } from "../types.js";
import type { Workspace } from "../workspace.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { DEFAULT_CHUNK, splitIntoChunks, type ChunkOptions } from "./chunk.js";
import { extractionJsonSchema } from "../types.js";
import { EXTRACTION_PROMPT } from "./prompt.js";

export const CHUNKS_DIR = "chunks";
export const EXTRACTED_DIR = "extracted";

export function chunkFileName(index: number): string {
  return `${String(index).padStart(3, "0")}.md`;
}
export function extractedFileName(index: number): string {
  return `${String(index).padStart(3, "0")}.json`;
}

/** 본문 뒤에 수확 결과를 섹션으로 이어 붙인다. 청크 분할이 헤딩을 기준으로 하므로 "## [수확] ..." 헤딩을 쓴다. */
export function documentText(input: SourceInput): string {
  const parts = [input.content.trimEnd()];
  for (const p of input.harvested?.pages ?? []) {
    parts.push(`## [수확] 페이지: ${p.title || p.url}\n\n<!-- ${p.url} -->\n\n${p.content.trim()}`);
  }
  for (const it of input.harvested?.interactions ?? []) {
    parts.push(`## [수확] ${it.type}: ${it.label}\n\n${it.content.trim()}`);
  }
  return parts.join("\n\n") + "\n";
}

export function needsLlm(input: SourceInput): boolean {
  return input.kind !== "openapi";
}

export async function prepare(ws: Workspace, system: string, chunkOpts: ChunkOptions = DEFAULT_CHUNK): Promise<AnalyzeRequest> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const docInputs = source.inputs.map((input, inputIndex) => ({ input, inputIndex })).filter(({ input }) => needsLlm(input));
  if (docInputs.length === 0) {
    throw new Error("LLM 추출이 필요한 입력이 없습니다. OpenAPI만 있으면 specmock analyze <system>으로 충분합니다.");
  }
  const openapiFeatures = source.inputs
    .filter((i) => i.kind === "openapi")
    .reduce((n, i) => n + analyzeOpenApiDocument(JSON.parse(i.content)).length, 0);

  const chunksDir = ws.file(system, CHUNKS_DIR);
  await rm(chunksDir, { recursive: true, force: true });
  await mkdir(chunksDir, { recursive: true });

  const chunks: ChunkInfo[] = [];
  for (const { input, inputIndex } of docInputs) {
    for (const c of splitIntoChunks(documentText(input), chunkOpts)) {
      const index = chunks.length;
      const file = path.posix.join(CHUNKS_DIR, chunkFileName(index));
      await ws.writeText(system, file, c.text.endsWith("\n") ? c.text : c.text + "\n");
      chunks.push({ index, file, inputIndex, heading: c.heading, chars: c.text.length });
    }
  }

  const request: AnalyzeRequest = {
    system, createdAt: new Date().toISOString(), prompt: EXTRACTION_PROMPT, schema: extractionJsonSchema(), chunks, openapiFeatures,
  };
  await ws.write(system, "analyze-request.json", AnalyzeRequestSchema, request);
  return request;
}

/** 현재 request의 청크 수보다 큰 번호의 extracted 파일은 이전 prepare의 잔재다. 지운다. */
export async function pruneExtracted(ws: Workspace, system: string, chunkCount: number): Promise<string[]> {
  const dir = ws.file(system, EXTRACTED_DIR);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const removed: string[] = [];
  for (const n of names) {
    const m = n.match(/^(\d{3})\.json$/);
    if (m && Number(m[1]) >= chunkCount) { await rm(path.join(dir, n), { force: true }); removed.push(n); }
  }
  return removed;
}
```

`Workspace.writeText`는 하위 디렉터리를 `mkdir -p` 하므로 `chunks/000.md` 경로를 그대로 넘겨도 된다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm build:core && pnpm vitest run packages/core/test/prepare.test.ts`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add packages/core/src/analyze/prompt.ts packages/core/src/analyze/prepare.ts packages/core/test/prepare.test.ts
git commit -m "feat(core): analyze prepare — 청크 파일, 추출 프롬프트, 출력 JSON 스키마, analyze-request.json"
```

---

### Task 5: merge — 검증 · 근거 대조 · 신뢰도 보정 · 병합 · 카탈로그, 그리고 analyze 디스패치

**Files:**
- Create: `packages/core/src/analyze/inferSchema.ts`, `packages/core/src/analyze/merge.ts`, `packages/core/src/analyze/diff.ts`
- Modify: `packages/core/src/analyze/index.ts`, `packages/core/src/index.ts`
- Create: `packages/core/test/fixtures/docs/extracted/000.json` (손으로 쓴 "녹음" 응답)
- Test: `packages/core/test/inferSchema.test.ts`, `packages/core/test/merge.test.ts`, `packages/core/test/diff.test.ts`

- [ ] **Step 1: inferSchema 테스트**

```ts
import { describe, expect, it } from "vitest";
import { inferSchema } from "../src/analyze/inferSchema.js";

describe("inferSchema", () => {
  it("infers object properties without required", () => {
    expect(inferSchema({ id: 1, name: "Rex", tags: ["a"], owner: { id: 2 }, gone: null })).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } },
        owner: { type: "object", properties: { id: { type: "integer" } } }, gone: { type: "null" },
      },
    });
  });
  it("uses the first element for arrays and number for non-integers", () => {
    expect(inferSchema([{ price: 1.5 }])).toEqual({ type: "array", items: { type: "object", properties: { price: { type: "number" } } } });
    expect(inferSchema([])).toEqual({ type: "array" });
  });
  it("handles scalars and booleans", () => {
    expect(inferSchema(true)).toEqual({ type: "boolean" });
    expect(inferSchema("x")).toEqual({ type: "string" });
  });
});
```

- [ ] **Step 2: inferSchema 구현** — `packages/core/src/analyze/inferSchema.ts`

```ts
import type { JsonSchema } from "../types.js";

/** 샘플 값에서 느슨한 JSON Schema를 만든다. required는 넣지 않는다(샘플 하나로 필수 여부를 알 수 없다). */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return value.length === 0 ? { type: "array" } : { type: "array", items: inferSchema(value[0]) };
  switch (typeof value) {
    case "boolean": return { type: "boolean" };
    case "number": return { type: Number.isInteger(value) ? "integer" : "number" };
    case "string": return { type: "string" };
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = inferSchema(v);
      return { type: "object", properties };
    }
    default: return {};
  }
}
```

Run: `pnpm vitest run packages/core/test/inferSchema.test.ts` → PASS.

- [ ] **Step 3: 녹음 응답 픽스처** — `packages/core/test/fixtures/docs/extracted/000.json`

`pets.md`를 기본 청크 설정(6,000자)으로 prepare하면 청크가 하나다. 그 청크에 대한 그럴듯한 LLM 응답을 손으로 쓴다. 일부러 함정을 넣는다: (a) 근거 인용이 원문에 없는 항목, (b) 같은 method+path가 두 번(하나는 스키마, 하나는 예시), (c) 잘못된 path, (d) 추측된 method.

```json
{
  "endpoints": [
    { "method": "GET", "path": "/pets", "title": "List pets", "summary": "returns an array of pets", "group": "pets", "auth": "bearer",
      "queryParams": [{ "name": "limit", "required": false, "schema": { "type": "integer", "maximum": 100 }, "description": "" }],
      "responses": [{ "status": 200, "schema": null, "example": [{ "id": 1, "name": "Rex", "tag": "dog" }], "description": "" }],
      "evidence": ["`GET /pets` returns an array of pets."], "confidence": 0.9 },
    { "method": "GET", "path": "/pets/{petId}", "title": "Get a pet", "summary": "", "group": "pets", "auth": "bearer",
      "pathParams": [{ "name": "petId", "required": true, "schema": { "type": "string" }, "description": "" }],
      "responses": [{ "status": 200, "schema": null, "example": { "id": 1, "name": "Rex", "tag": "dog" }, "description": "" }],
      "evidence": ["`GET /pets/{petId}` returns one pet."], "confidence": 0.9 },
    { "method": "GET", "path": "/pets/{petId}", "title": "Get a pet (errors)", "summary": "", "group": "pets", "auth": "unknown",
      "responses": [{ "status": 404, "schema": { "type": "object", "properties": { "code": { "type": "integer" }, "message": { "type": "string" } } }, "example": { "code": 404, "message": "not found" }, "description": "" }],
      "evidence": ["Responds `404` with `{\"code\": 404, \"message\": \"not found\"}` when missing."], "confidence": 0.8 },
    { "method": "POST", "path": "/pets", "title": "Create a pet", "summary": "", "group": "pets", "auth": "bearer",
      "requestBody": { "type": "object", "properties": { "name": { "type": "string" }, "tag": { "type": "string" } }, "required": ["name"] },
      "responses": [{ "status": 201, "schema": null, "description": "the created pet" }],
      "evidence": ["`POST /pets` with body `{\"name\": string, \"tag\"?: string}`. Returns `201` and the created pet."], "confidence": 0.85 },
    { "method": "DELETE", "path": "/pets/{petId}", "title": "Delete a pet", "summary": "", "group": "pets", "auth": "bearer",
      "responses": [{ "status": 204, "schema": null, "description": "" }],
      "evidence": ["this sentence does not exist in the document"], "confidence": 0.9 },
    { "method": "PUT", "path": "/pets/{petId}", "title": "Update a pet", "summary": "guessed", "group": "pets", "auth": "unknown",
      "responses": [{ "status": 200, "schema": null, "description": "" }],
      "evidence": ["`GET /pets/{petId}` returns one pet."], "confidence": 0.7, "inferred": { "method": true, "path": false } },
    { "method": "GET", "path": "pets/bad", "title": "broken path", "summary": "", "group": "", "auth": "unknown",
      "responses": [], "evidence": [], "confidence": 0.4 }
  ]
}
```

- [ ] **Step 4: merge 테스트** — `packages/core/test/merge.test.ts`

```ts
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { merge, verifyEvidence, adjustConfidence } from "../src/analyze/merge.js";
import { prepare } from "../src/analyze/prepare.js";
import { ingest } from "../src/ingest/index.js";
import { CatalogSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { PETSTORE } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, "fixtures", "docs");

describe("verifyEvidence", () => {
  it("matches after whitespace and backtick normalization", () => {
    const text = "Call   `GET /pets`\nreturns a list.";
    expect(verifyEvidence(["GET /pets returns a list."], text)).toEqual({ found: 1, total: 1 });
    expect(verifyEvidence(["nothing like this"], text)).toEqual({ found: 0, total: 1 });
    expect(verifyEvidence([], text)).toEqual({ found: 0, total: 0 });
  });
});

describe("adjustConfidence", () => {
  it("applies the design table", () => {
    expect(adjustConfidence(0.9, { evidenceFound: 1, evidenceTotal: 1, hasExample: false, inferred: false })).toBeCloseTo(0.9);
    expect(adjustConfidence(0.9, { evidenceFound: 0, evidenceTotal: 1, hasExample: false, inferred: false })).toBeCloseTo(0.27);
    expect(adjustConfidence(0.95, { evidenceFound: 1, evidenceTotal: 1, hasExample: true, inferred: false })).toBe(1);
    expect(adjustConfidence(0.9, { evidenceFound: 1, evidenceTotal: 1, hasExample: true, inferred: true })).toBe(0.5);
    expect(adjustConfidence(0.9, { evidenceFound: 0, evidenceTotal: 0, hasExample: false, inferred: false })).toBeCloseTo(0.9 * 0.7);
  });
});

describe("merge", () => {
  let dir: string; let ws: Workspace;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "specmock-merge-")); ws = new Workspace(dir);
    await ingest(ws, "pets", [path.join(DOCS, "pets.md")]);
    await prepare(ws, "pets");
    await cp(path.join(DOCS, "extracted"), path.join(dir, "pets", "extracted"), { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("builds a catalog with doc-extracted features, merged by method+path", async () => {
    const result = await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const ids = catalog.features.map((f) => `${f.method} ${f.path}`).sort();
    expect(ids).toEqual(["DELETE /pets/{petId}", "GET /pets", "GET /pets/{petId}", "POST /pets", "PUT /pets/{petId}"]);
    const get = catalog.features.find((f) => f.method === "GET" && f.path === "/pets/{petId}")!;
    expect(get.id).toBe("pets.get");
    expect(get.group).toBe("pets");
    expect(get.provenance).toBe("doc-extracted");
    expect(Object.keys(get.responses).sort()).toEqual(["200", "404"]);         // 두 항목이 합쳐짐
    expect(get.responses["200"].examples[0]).toEqual({ source: "doc-sample", body: { id: 1, name: "Rex", tag: "dog" } });
    expect(get.responses["200"].schema).toEqual({ type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, tag: { type: "string" } } }); // 샘플에서 유추
    expect(get.hasExample).toBe(true);
    expect(get.confidence).toBe(1);                                             // 0.9 + 0.1
    expect(get.evidence[0]).toMatchObject({ chunk: 0, quote: expect.stringContaining("returns one pet") });
    expect(get.request.params.petId).toEqual({ schema: { type: "string" }, required: true });
    expect(result.features).toBe(5);
  });

  it("lowers confidence and notes evidence mismatch, caps inferred at 0.5, rejects bad paths", async () => {
    await merge(ws, "pets");
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    const del = catalog.features.find((f) => f.method === "DELETE")!;
    expect(del.confidence).toBeCloseTo(0.27);
    expect(del.notes).toContain("근거 불일치: 인용 1건 중 0건을 원문에서 찾지 못함");
    const put = catalog.features.find((f) => f.method === "PUT")!;
    expect(put.confidence).toBeLessThanOrEqual(0.5);
    expect(put.provenance).toBe("inferred");
    expect(put.notes).toContain("method 추론됨");
    expect(catalog.rejected).toHaveLength(1);
    expect(catalog.rejected[0].reason).toMatch(/path/);
    expect(catalog.rejected[0].chunk).toBe(0);
  });

  it("prefers openapi features when both exist and marks doc-only ones", async () => {
    await ingest(ws, "mixed", [PETSTORE, path.join(DOCS, "pets.md")]);
    await prepare(ws, "mixed");
    await cp(path.join(DOCS, "extracted"), path.join(dir, "mixed", "extracted"), { recursive: true });
    await merge(ws, "mixed");
    const catalog = await ws.read("mixed", "catalog.json", CatalogSchema);
    const get = catalog.features.find((f) => f.method === "GET" && f.path === "/pets/{petId}")!;
    expect(get.id).toBe("getPet");                 // operationId 유지
    expect(get.provenance).toBe("openapi");
    expect(get.confidence).toBe(1);
    expect(catalog.features.filter((f) => f.provenance !== "openapi").map((f) => f.method)).toEqual(["PUT"]); // 문서에만 있는 것
    expect(catalog.features).toHaveLength(6);
  });

  it("proceeds with missing extracted files and records it", async () => {
    await rm(path.join(dir, "pets", "extracted"), { recursive: true, force: true });
    const result = await merge(ws, "pets");
    expect(result.features).toBe(0);
    expect(result.missingChunks).toEqual([0]);
    const catalog = await ws.read("pets", "catalog.json", CatalogSchema);
    expect(catalog.rejected[0].reason).toContain("미추출");
  });

  it("rejects a file that does not match the schema but keeps going", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "pets", "extracted", "000.json"), JSON.stringify({ endpoints: [{ method: "GET" }] }));
    const result = await merge(ws, "pets");
    expect(result.features).toBe(0);
    expect(result.invalidChunks).toEqual([0]);
  });
});
```

- [ ] **Step 5: 실행해 실패 확인**

Run: `pnpm build:core && pnpm vitest run packages/core/test/merge.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 6: merge 구현** — `packages/core/src/analyze/merge.ts`

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv } from "ajv";
import { AnalyzeRequestSchema, CatalogSchema, ExtractionResultSchema, SourceSchema, type Catalog, type ExtractedEndpoint, type Feature, type HttpMethod, type JsonSchema } from "../types.js";
import type { Workspace } from "../workspace.js";
import { deriveFeatureId, deriveGroup, FeatureIdRegistry } from "./featureId.js";
import { inferSchema } from "./inferSchema.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { EXTRACTED_DIR, extractedFileName } from "./prepare.js";

/* ---------- 근거 대조 ---------- */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[`*_>#|]/g, "").replace(/\s+/g, " ").trim();
}

export function verifyEvidence(quotes: string[], chunkText: string): { found: number; total: number } {
  const hay = normalize(chunkText);
  let found = 0;
  for (const q of quotes) {
    const needle = normalize(q);
    if (needle.length >= 8 && hay.includes(needle)) found += 1;
  }
  return { found, total: quotes.length };
}

/* ---------- 신뢰도 보정 (설계 3.2 표) ---------- */

export interface ConfidenceSignals { evidenceFound: number; evidenceTotal: number; hasExample: boolean; inferred: boolean }

export function adjustConfidence(raw: number, s: ConfidenceSignals): number {
  let c = raw;
  if (s.evidenceTotal === 0) c *= 0.7;                       // 근거 없음
  else if (s.evidenceFound === 0) c *= 0.3;                  // 근거 불일치
  if (s.hasExample) c = Math.min(1, c + 0.1);
  if (s.inferred) c = Math.min(c, 0.5);
  return Math.round(c * 100) / 100;
}

/* ---------- 스키마 정리 ---------- */

const ajv = new Ajv({ strict: false, allErrors: false });

/** LLM이 준 스키마가 컴파일되지 않으면 null. 컴파일 가능하면 그대로. */
function sanitizeSchema(schema: JsonSchema | null, notes: string[], where: string): JsonSchema | null {
  if (!schema) return null;
  try { ajv.compile(schema); return schema; } catch (e) {
    notes.push(`${where} 스키마 무시: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

/* ---------- path 정규화 ---------- */

export function normalizePath(p: string): string | null {
  let s = p.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, "");               // 호스트 제거
  s = s.replace(/:(\w+)/g, "{$1}").replace(/<(\w+)>/g, "{$1}");
  s = s.replace(/\?.*$/, "");                              // 쿼리 제거
  if (!s.startsWith("/")) return null;
  if (/\s/.test(s)) return null;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

/* ---------- 병합 ---------- */

interface Bucket {
  method: HttpMethod; path: string;
  items: { ep: ExtractedEndpoint; chunk: number; evidenceFound: number; evidenceTotal: number }[];
}

function paramRecord(list: ExtractedEndpoint["pathParams"], notes: string[], where: string): Feature["request"]["params"] {
  const out: Feature["request"]["params"] = {};
  for (const p of list) out[p.name] = { schema: sanitizeSchema(p.schema, notes, `${where}.${p.name}`), required: p.required };
  return out;
}

function toFeature(bucket: Bucket, registry: FeatureIdRegistry): Feature {
  const notes: string[] = [];
  const items = [...bucket.items].sort((a, b) => b.ep.confidence - a.ep.confidence);
  const primary = items[0].ep;
  const anyInferred = items.some((i) => i.ep.inferred.method || i.ep.inferred.path);
  if (items.some((i) => i.ep.inferred.method)) notes.push("method 추론됨");
  if (items.some((i) => i.ep.inferred.path)) notes.push("path 추론됨");

  const request: Feature["request"] = { params: {}, query: {}, headers: {}, body: null };
  const responses: Feature["responses"] = {};
  const evidence: Feature["evidence"] = [];
  let evidenceFound = 0, evidenceTotal = 0;
  let hasExample = false;

  for (const { ep, chunk, evidenceFound: f, evidenceTotal: t } of items) {
    Object.assign(request.params, paramRecord(ep.pathParams, notes, "pathParams"));
    Object.assign(request.query, paramRecord(ep.queryParams, notes, "queryParams"));
    Object.assign(request.headers, paramRecord(ep.headers, notes, "headers"));
    if (!request.body && ep.requestBody) request.body = sanitizeSchema(ep.requestBody, notes, "requestBody");
    for (const r of ep.responses) {
      const key = String(r.status);
      const slot = (responses[key] ??= { schema: null, examples: [] });
      if (!slot.schema) slot.schema = sanitizeSchema(r.schema, notes, `responses.${key}`);
      if (r.example !== undefined && r.example !== null) {
        slot.examples.push({ source: "doc-sample", body: r.example });
        if (r.status >= 200 && r.status < 300) hasExample = true;
      }
    }
    for (const q of ep.evidence) evidence.push({ chunk, quote: q });
    evidenceFound += f; evidenceTotal += t;
  }
  // 스키마 없이 샘플만 있으면 샘플에서 유추한다(설계 5.3).
  for (const [key, slot] of Object.entries(responses)) {
    if (!slot.schema && slot.examples.length > 0) {
      slot.schema = inferSchema(slot.examples[0].body);
      notes.push(`${key} 응답 스키마는 샘플에서 유추`);
    }
  }
  // 경로 변수인데 pathParams에 없으면 문자열로 채운다.
  for (const m of bucket.path.matchAll(/\{([^}]+)\}/g)) request.params[m[1]] ??= { schema: { type: "string" }, required: true };

  if (evidenceTotal > 0 && evidenceFound === 0) notes.push(`근거 불일치: 인용 ${evidenceTotal}건 중 ${evidenceFound}건을 원문에서 찾지 못함`);
  else if (evidenceTotal === 0) notes.push("근거 인용 없음");
  const confidence = adjustConfidence(Math.max(...items.map((i) => i.ep.confidence)), { evidenceFound, evidenceTotal, hasExample, inferred: anyInferred });

  const tags = primary.group ? [primary.group] : undefined;
  return {
    id: registry.claim(deriveFeatureId({ method: bucket.method, path: bucket.path })),
    group: deriveGroup({ path: bucket.path, tags }),
    title: primary.title || `${bucket.method} ${bucket.path}`,
    summary: items.map((i) => i.ep.summary).find((s) => s) ?? "",
    method: bucket.method, path: bucket.path, request, responses,
    auth: items.map((i) => i.ep.auth).find((a) => a !== "unknown") ?? "unknown",
    provenance: anyInferred ? "inferred" : "doc-extracted",
    confidence, hasExample, evidence, notes,
  };
}

export interface MergeResult {
  catalogFile: string;
  features: number;
  rejected: number;
  missingChunks: number[];
  invalidChunks: number[];
}

export async function merge(ws: Workspace, system: string): Promise<MergeResult> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);

  // 1) OpenAPI 입력은 결정적으로 먼저. id 레지스트리를 공유해 문서 추출 id가 충돌하지 않게 한다.
  const registry = new FeatureIdRegistry();
  const features: Feature[] = [];
  for (const input of source.inputs) if (input.kind === "openapi") features.push(...analyzeOpenApiDocument(JSON.parse(input.content), registry));
  const known = new Set(features.map((f) => `${f.method} ${f.path}`));

  // 2) extracted/NNN.json 읽기 → 스키마 검증 → path 정규화 → 근거 대조 → 버킷
  const rejected: Catalog["rejected"] = [];
  const buckets = new Map<string, Bucket>();
  const missingChunks: number[] = [];
  const invalidChunks: number[] = [];
  for (const chunk of request.chunks) {
    const file = ws.file(system, path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index)));
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, "utf8")); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { missingChunks.push(chunk.index); rejected.push({ raw: null, reason: `청크 ${chunk.index} 미추출 (${path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index))} 없음)`, chunk: chunk.index }); continue; }
      invalidChunks.push(chunk.index); rejected.push({ raw: null, reason: `청크 ${chunk.index} JSON 파싱 실패: ${(e as Error).message}`, chunk: chunk.index }); continue;
    }
    const parsed = ExtractionResultSchema.safeParse(raw);
    if (!parsed.success) { invalidChunks.push(chunk.index); rejected.push({ raw, reason: `청크 ${chunk.index} 스키마 불일치: ${parsed.error.issues[0]?.message ?? ""}`, chunk: chunk.index }); continue; }
    const chunkText = await readFile(ws.file(system, chunk.file), "utf8");
    for (const ep of parsed.data.endpoints) {
      const p = normalizePath(ep.path);
      if (!p) { rejected.push({ raw: ep, reason: `path 형식 불일치: '${ep.path}'`, chunk: chunk.index }); continue; }
      const key = `${ep.method} ${p}`;
      if (known.has(key)) continue;                                 // OpenAPI가 우선
      const ev = verifyEvidence(ep.evidence, chunkText);
      const b = buckets.get(key) ?? { method: ep.method, path: p, items: [] };
      b.items.push({ ep: { ...ep, path: p }, chunk: chunk.index, evidenceFound: ev.found, evidenceTotal: ev.total });
      buckets.set(key, b);
    }
  }

  // 3) 버킷 → Feature. 순서를 고정해 id 접미사가 안정적이게 한다.
  for (const key of [...buckets.keys()].sort()) features.push(toFeature(buckets.get(key)!, registry));

  const catalogFile = await ws.write(system, "catalog.json", CatalogSchema, { system, generatedAt: new Date().toISOString(), features, rejected });
  return { catalogFile, features: features.length, rejected: rejected.length, missingChunks, invalidChunks };
}
```

`Catalog["rejected"]` 타입에 `chunk?: number`가 Task 1에서 추가돼 있어야 한다.

- [ ] **Step 7: 카탈로그 diff** — `packages/core/src/analyze/diff.ts` + 테스트 `packages/core/test/diff.test.ts`

```ts
// diff.ts
import { hashJson } from "../util/hash.js";
import type { Catalog, CatalogDiff } from "../types.js";

export function diffCatalogs(prev: Catalog | null, next: Catalog): CatalogDiff {
  if (!prev) return { previousAt: null, added: next.features.map((f) => f.id), removed: [], changed: [] };
  const a = new Map(prev.features.map((f) => [f.id, hashJson({ ...f, confidence: undefined })]));
  const b = new Map(next.features.map((f) => [f.id, hashJson({ ...f, confidence: undefined })]));
  return {
    previousAt: prev.generatedAt,
    added: [...b.keys()].filter((id) => !a.has(id)).sort(),
    removed: [...a.keys()].filter((id) => !b.has(id)).sort(),
    changed: [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id)).sort(),
  };
}
```

```ts
// diff.test.ts
import { describe, expect, it } from "vitest";
import { diffCatalogs } from "../src/analyze/diff.js";
import type { Catalog, Feature } from "../src/types.js";

const f = (id: string, extra: Partial<Feature> = {}): Feature => ({
  id, group: "g", title: id, summary: "", method: "GET", path: `/${id}`, request: { params: {}, query: {}, headers: {}, body: null },
  responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], ...extra,
});
const cat = (...features: Feature[]): Catalog => ({ system: "s", generatedAt: "t", features, rejected: [] });

describe("diffCatalogs", () => {
  it("reports added, removed and changed ids, ignoring confidence-only changes", () => {
    const prev = cat(f("a"), f("b"), f("c", { confidence: 0.5 }));
    const next = cat(f("a", { summary: "new" }), f("c", { confidence: 0.9 }), f("d"));
    expect(diffCatalogs(prev, next)).toEqual({ previousAt: "t", added: ["d"], removed: ["b"], changed: ["a"] });
  });
  it("treats everything as added when there is no previous catalog", () => {
    expect(diffCatalogs(null, cat(f("a"))).added).toEqual(["a"]);
  });
});
```

- [ ] **Step 8: analyze 디스패치** — `packages/core/src/analyze/index.ts` 전체 교체

```ts
import { CatalogDiffSchema, CatalogSchema, SourceSchema, type Catalog, type CatalogDiff, type Feature } from "../types.js";
import type { Workspace } from "../workspace.js";
import { diffCatalogs } from "./diff.js";
import { FeatureIdRegistry } from "./featureId.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { needsLlm } from "./prepare.js";

export interface AnalyzeOutcome {
  /** "openapi": LLM 없이 끝남. "needs-llm": 문서 입력이 있어 prepare → extract → merge가 필요. */
  mode: "openapi" | "needs-llm";
  catalogFile?: string;
  diff?: CatalogDiff;
}

/** 입력이 전부 OpenAPI면 바로 카탈로그를 쓴다. 문서 입력이 하나라도 있으면 호출자가 prepare/extract/merge를 돌려야 한다. */
export async function analyze(ws: Workspace, system: string): Promise<AnalyzeOutcome> {
  const source = await ws.read(system, "source.json", SourceSchema);
  if (source.inputs.some(needsLlm)) return { mode: "needs-llm" };
  const features: Feature[] = [];
  const registry = new FeatureIdRegistry();
  for (const input of source.inputs) features.push(...analyzeOpenApiDocument(JSON.parse(input.content), registry));
  const next: Catalog = { system, generatedAt: new Date().toISOString(), features, rejected: [] };
  const diff = await writeCatalogWithDiff(ws, system, next);
  return { mode: "openapi", catalogFile: ws.file(system, "catalog.json"), diff };
}

/** 이전 catalog.json이 있으면 비교 결과를 catalog-diff.json에 남기고 덮어쓴다. merge도 이 함수를 쓴다. */
export async function writeCatalogWithDiff(ws: Workspace, system: string, next: Catalog): Promise<CatalogDiff> {
  const prev = (await ws.exists(system, "catalog.json")) ? await ws.read(system, "catalog.json", CatalogSchema) : null;
  const diff = diffCatalogs(prev, next);
  await ws.write(system, "catalog.json", CatalogSchema, next);
  await ws.write(system, "catalog-diff.json", CatalogDiffSchema, diff);
  return diff;
}
```

`merge.ts`의 마지막 `ws.write(... catalog.json ...)`을 `writeCatalogWithDiff(ws, system, catalog)`로 바꾸고 `MergeResult`에 `diff: CatalogDiff`를 추가한다. 순환 import를 피하려면 `writeCatalogWithDiff`를 `analyze/catalogWrite.ts`로 빼고 `index.ts`와 `merge.ts`가 둘 다 거기서 import한다.

**호출부 영향:** 1A의 `analyze()`는 `Promise<string>`이었다. `packages/cli/src/commands/analyze.ts`, `run.ts`, `packages/core/test/*.test.ts`(analyze.test, e2e, petstore-roundtrip, select, generate 등 `await analyze(ws, ...)`를 쓰는 곳)는 반환값을 쓰지 않으면 그대로 동작한다. 반환값을 쓰는 곳은 `.catalogFile`로 바꾼다. CLI는 Task 7에서 `needs-llm`을 처리한다. 이 Task에서는 CLI가 `needs-llm`을 받으면 "문서 입력은 --llm 옵션이 필요합니다(Task 7 전까지)" 오류를 내도록 임시 분기만 넣는다.

- [ ] **Step 9: index.ts 공개 API 추가**

```ts
export { analyze, writeCatalogWithDiff, type AnalyzeOutcome } from "./analyze/index.js";
export { prepare, pruneExtracted, documentText, needsLlm, CHUNKS_DIR, EXTRACTED_DIR, chunkFileName, extractedFileName } from "./analyze/prepare.js";
export { merge, verifyEvidence, adjustConfidence, normalizePath, type MergeResult } from "./analyze/merge.js";
export { splitIntoChunks, DEFAULT_CHUNK, type ChunkOptions, type TextChunk } from "./analyze/chunk.js";
export { EXTRACTION_PROMPT, buildChunkPrompt } from "./analyze/prompt.js";
export { inferSchema } from "./analyze/inferSchema.js";
export { diffCatalogs } from "./analyze/diff.js";
```

- [ ] **Step 10: 테스트 통과와 전체 회귀**

Run: `pnpm build:core && pnpm vitest run packages/core/test/merge.test.ts packages/core/test/diff.test.ts packages/core/test/inferSchema.test.ts && pnpm test && pnpm typecheck`
Expected: 모두 PASS. `fixtures.ts`의 `buildFixtures`는 `examples[0].source`를 그대로 fixture `source`로 쓰므로 `doc-sample`이 자연스럽게 흐른다(확인만 한다).

- [ ] **Step 11: 커밋**

```bash
git add packages/core/src/analyze packages/core/src/index.ts packages/core/test/merge.test.ts packages/core/test/diff.test.ts packages/core/test/inferSchema.test.ts packages/core/test/fixtures/docs/extracted packages/cli/src/commands/analyze.ts packages/cli/src/commands/run.ts
git commit -m "feat(core): analyze merge — LLM 추출 검증·근거 대조·신뢰도 보정·병합, 샘플 스키마 유추, 카탈로그 diff, analyze 디스패치"
```

---

### Task 6: LLM 어댑터(claude-code · session)와 extract

**Files:**
- Create: `packages/core/src/llm/adapter.ts`, `claudeCode.ts`, `session.ts`, `index.ts`
- Create: `packages/core/src/analyze/extract.ts`
- Create: `packages/core/test/bin/claude` (실행 권한, 가짜 CLI), `packages/core/test/bin/claude-fail`
- Test: `packages/core/test/llm.test.ts`, `packages/core/test/extract.test.ts`

- [ ] **Step 1: 가짜 claude 실행 파일** — `packages/core/test/bin/claude`

실제 `claude --print --output-format json`의 출력 모양을 흉내 낸다. stdin으로 받은 프롬프트에 `/pets/{petId}`가 들어 있으면 그 엔드포인트를, 아니면 빈 배열을 돌려준다. 인자를 `$ARGS_LOG` 파일에 남겨 테스트가 옵션을 검사할 수 있게 한다.

```bash
#!/usr/bin/env bash
# 테스트용 가짜 claude. 실제 CLI와 같은 JSON 봉투를 출력한다.
set -euo pipefail
if [ -n "${ARGS_LOG:-}" ]; then printf '%s\n' "$@" > "$ARGS_LOG"; fi
input=$(cat)
if printf '%s' "$input" | grep -q '/pets/{petId}'; then
  so='{"endpoints":[{"method":"GET","path":"/pets/{petId}","title":"Get a pet","responses":[{"status":200,"example":{"id":1}}],"evidence":["`GET /pets/{petId}` returns one pet."],"confidence":0.9}]}'
else
  so='{"endpoints":[]}'
fi
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":%s,"structured_output":%s}\n' "$(printf '%s' "$so" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$so"
```

`packages/core/test/bin/claude-fail`:

```bash
#!/usr/bin/env bash
cat > /dev/null
printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in. Please run /login"}\n'
exit 1
```

`chmod +x packages/core/test/bin/claude packages/core/test/bin/claude-fail`. git은 실행 비트를 보존한다(`git add` 후 `git ls-files -s`로 100755 확인).

- [ ] **Step 2: 실패하는 테스트 — 어댑터** — `packages/core/test/llm.test.ts`

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { createAdapter } from "../src/llm/index.js";
import { SessionAdapter } from "../src/llm/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin");
const schema = { type: "object", required: ["endpoints"], properties: { endpoints: { type: "array" } } };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-llm-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ClaudeCodeAdapter", () => {
  it("spawns claude with --print --output-format json --json-schema and returns structured_output", async () => {
    const argsLog = path.join(dir, "args.txt");
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude"), model: "sonnet", env: { ARGS_LOG: argsLog } });
    const out = await adapter.extract({ prompt: "find `GET /pets/{petId}` returns one pet.", schema });
    expect(out).toMatchObject({ endpoints: [{ method: "GET", path: "/pets/{petId}" }] });
    const args = (await readFile(argsLog, "utf8")).trim().split("\n");
    expect(args).toContain("--print");
    expect(args).toContain("--output-format"); expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--json-schema"); expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(schema);
    expect(args).toContain("--model"); expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--tools"); expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("surfaces the CLI error message when claude fails", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "claude-fail") });
    await expect(adapter.extract({ prompt: "x", schema })).rejects.toThrow(/Not logged in/);
  });

  it("fails fast when the command does not exist", async () => {
    const adapter = new ClaudeCodeAdapter({ command: path.join(BIN, "nope") });
    await expect(adapter.extract({ prompt: "x", schema })).rejects.toThrow(/claude CLI를 실행할 수 없습니다/);
  });

  it("times out", async () => {
    const adapter = new ClaudeCodeAdapter({ command: "sleep", extraArgs: ["5"], timeoutMs: 200 });
    await expect(adapter.extract({ prompt: "x", schema })).rejects.toThrow(/시간 초과/);
  }, 5_000);
});

describe("SessionAdapter", () => {
  it("does not call anything and explains what to do", async () => {
    const a = new SessionAdapter();
    await expect(a.extract({ prompt: "x", schema })).rejects.toThrow(/세션 모드/);
    expect(a.name).toBe("session");
  });
});

describe("createAdapter", () => {
  it("maps names and rejects unknown ones", () => {
    expect(createAdapter("claude-code").name).toBe("claude-code");
    expect(createAdapter("session").name).toBe("session");
    expect(() => createAdapter("gpt" as never)).toThrow(/알 수 없는 LLM 어댑터/);
  });
});
```

- [ ] **Step 3: 어댑터 구현**

`packages/core/src/llm/adapter.ts`:

```ts
export interface ExtractRequest {
  /** 지시문 + 청크 본문이 합쳐진 완성 프롬프트. */
  prompt: string;
  /** 출력이 따라야 하는 JSON Schema. */
  schema: Record<string, unknown>;
}

export interface LlmAdapter {
  readonly name: "claude-code" | "session" | "api";
  /** 스키마를 만족하는 JSON 값을 돌려준다. 검증은 호출자(merge)가 다시 한다. */
  extract(req: ExtractRequest): Promise<unknown>;
}

export type AdapterName = LlmAdapter["name"];
```

`packages/core/src/llm/claudeCode.ts`:

```ts
import { spawn } from "node:child_process";
import type { ExtractRequest, LlmAdapter } from "./adapter.js";

export interface ClaudeCodeOptions {
  command?: string;        // 기본 "claude"
  model?: string;          // 기본: CLI 기본 모델
  timeoutMs?: number;      // 기본 180_000
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

interface ResultEnvelope { is_error?: boolean; subtype?: string; result?: unknown; structured_output?: unknown }

/**
 * 로컬 Claude Code 구독으로 추출한다. `claude --print --output-format json --json-schema <schema> --tools ""`를
 * 자식 프로세스로 띄우고 프롬프트를 stdin으로 준다. 도구를 비워 파일 접근 없이 텍스트만 보게 한다.
 */
export class ClaudeCodeAdapter implements LlmAdapter {
  readonly name = "claude-code" as const;
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async extract(req: ExtractRequest): Promise<unknown> {
    const args = ["--print", "--output-format", "json", "--json-schema", JSON.stringify(req.schema), "--tools", ""];
    if (this.opts.model) args.push("--model", this.opts.model);
    args.push(...(this.opts.extraArgs ?? []));
    const command = this.opts.command ?? "claude";
    const timeoutMs = this.opts.timeoutMs ?? 180_000;

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.opts.env } });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude 호출 시간 초과 (${timeoutMs}ms)`)); }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude CLI를 실행할 수 없습니다 (${command}): ${e.message}. Claude Code가 설치돼 있고 PATH에 있는지 확인하세요.`)); });
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        // 실패해도 JSON 봉투를 내는 경우가 있으므로 메시지를 뽑아 본다.
        const message = tryParse(out)?.result;
        reject(new Error(`claude 종료 코드 ${code}: ${typeof message === "string" ? message : err.trim() || out.trim().slice(0, 300)}`));
      });
      child.stdin.on("error", () => { /* 자식이 먼저 죽으면 EPIPE. close에서 처리된다. */ });
      child.stdin.end(req.prompt);
    });

    const envelope = tryParse(stdout);
    if (!envelope) throw new Error(`claude 출력을 JSON으로 읽을 수 없습니다: ${stdout.slice(0, 300)}`);
    if (envelope.is_error) throw new Error(`claude 오류: ${String(envelope.result ?? envelope.subtype)}`);
    if (envelope.structured_output === undefined) {
      // 구버전 CLI 호환: result 문자열이 JSON일 수 있다.
      if (typeof envelope.result === "string") { try { return JSON.parse(envelope.result); } catch { /* 아래에서 오류 */ } }
      throw new Error("claude 출력에 structured_output이 없습니다. Claude Code 2.1 이상이 필요합니다 (claude --version).");
    }
    return envelope.structured_output;
  }
}

function tryParse(text: string): ResultEnvelope | null {
  try { return JSON.parse(text) as ResultEnvelope; } catch { return null; }
}
```

`packages/core/src/llm/session.ts`:

```ts
import type { ExtractRequest, LlmAdapter } from "./adapter.js";

/**
 * Claude Code 스킬 모드. 코어는 LLM을 호출하지 않는다. Claude(세션 자신)가 analyze-request.json을 읽고
 * chunks/NNN.md마다 extracted/NNN.json을 쓴 뒤 `specmock analyze <system> --merge`를 실행한다.
 * extract()가 불리면 그 절차를 설명하는 오류를 낸다.
 */
export class SessionAdapter implements LlmAdapter {
  readonly name = "session" as const;
  async extract(_req: ExtractRequest): Promise<unknown> {
    throw new Error("세션 모드에서는 코어가 LLM을 호출하지 않습니다. analyze-request.json의 chunks를 읽어 extracted/NNN.json을 쓴 뒤 `specmock analyze <system> --merge`를 실행하세요.");
  }
}
```

`packages/core/src/llm/index.ts`:

```ts
import type { AdapterName, LlmAdapter } from "./adapter.js";
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from "./claudeCode.js";
import { SessionAdapter } from "./session.js";

export type { AdapterName, ExtractRequest, LlmAdapter } from "./adapter.js";
export { ClaudeCodeAdapter, type ClaudeCodeOptions } from "./claudeCode.js";
export { SessionAdapter } from "./session.js";

export const ADAPTER_NAMES: AdapterName[] = ["session", "claude-code"];

export function createAdapter(name: AdapterName, opts: { claude?: ClaudeCodeOptions } = {}): LlmAdapter {
  switch (name) {
    case "claude-code": return new ClaudeCodeAdapter(opts.claude);
    case "session": return new SessionAdapter();
    case "api": throw new Error("API 키 어댑터는 3단계에서 제공합니다.");
    default: throw new Error(`알 수 없는 LLM 어댑터: ${String(name)} (가능: ${ADAPTER_NAMES.join(", ")})`);
  }
}
```

Run: `pnpm vitest run packages/core/test/llm.test.ts` → PASS.

- [ ] **Step 4: 실패하는 테스트 — extract** — `packages/core/test/extract.test.ts`

```ts
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extract } from "../src/analyze/extract.js";
import { prepare } from "../src/analyze/prepare.js";
import { ingest } from "../src/ingest/index.js";
import type { LlmAdapter } from "../src/llm/adapter.js";
import { ClaudeCodeAdapter } from "../src/llm/claudeCode.js";
import { Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PETS_MD = path.join(here, "fixtures", "docs", "pets.md");
const FAKE_CLAUDE = path.join(here, "bin", "claude");

let dir: string; let ws: Workspace;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-extract-")); ws = new Workspace(dir);
  await ingest(ws, "pets", [PETS_MD]);
  await prepare(ws, "pets", { maxChars: 400, overlap: 50 });   // 청크 여러 개
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fakeAdapter(calls: string[]): LlmAdapter {
  return { name: "claude-code", async extract(req) { calls.push(req.prompt); return { endpoints: [] }; } };
}

describe("extract", () => {
  it("writes one extracted/NNN.json per chunk and reports progress", async () => {
    const calls: string[] = []; const progress: string[] = [];
    const result = await extract(ws, "pets", fakeAdapter(calls), { onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
    const files = (await readdir(path.join(dir, "pets", "extracted"))).sort();
    expect(files[0]).toBe("000.json");
    expect(files).toHaveLength(result.total);
    expect(calls).toHaveLength(result.total);
    expect(calls[0]).toContain("# Pets API");                   // 청크 본문이 프롬프트에 들어감
    expect(progress[progress.length - 1]).toBe(`${result.total}/${result.total}`);
    expect(result.skipped).toBe(0);
  });

  it("skips chunks that already have a result unless refresh", async () => {
    const calls: string[] = [];
    await extract(ws, "pets", fakeAdapter(calls));
    const n = calls.length;
    await extract(ws, "pets", fakeAdapter(calls));
    expect(calls).toHaveLength(n);
    const r = await extract(ws, "pets", fakeAdapter(calls), { refresh: true });
    expect(calls).toHaveLength(2 * n);
    expect(r.skipped).toBe(0);
  });

  it("continues after a failing chunk and reports it", async () => {
    let i = 0;
    const flaky: LlmAdapter = { name: "claude-code", async extract() { if (i++ === 1) throw new Error("boom"); return { endpoints: [] }; } };
    const r = await extract(ws, "pets", flaky);
    expect(r.failed).toEqual([{ chunk: 1, error: "boom" }]);
    expect((await readdir(path.join(dir, "pets", "extracted"))).includes("001.json")).toBe(false);
  });

  it("does not write a result that fails schema validation", async () => {
    const bad: LlmAdapter = { name: "claude-code", async extract() { return { nope: true }; } };
    const r = await extract(ws, "pets", bad);
    expect(r.failed[0].error).toMatch(/스키마/);
    expect(r.written).toBe(0);
  });

  it("works end to end with the fake claude binary", async () => {
    const r = await extract(ws, "pets", new ClaudeCodeAdapter({ command: FAKE_CLAUDE }));
    expect(r.written).toBe(r.total);
    const all = await Promise.all((await readdir(path.join(dir, "pets", "extracted"))).map((f) => readFile(path.join(dir, "pets", "extracted", f), "utf8")));
    expect(all.some((t) => t.includes("/pets/{petId}"))).toBe(true);
  });
});
```

- [ ] **Step 5: extract 구현** — `packages/core/src/analyze/extract.ts`

```ts
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AnalyzeRequestSchema, ExtractionResultSchema } from "../types.js";
import type { LlmAdapter } from "../llm/adapter.js";
import type { Workspace } from "../workspace.js";
import { EXTRACTED_DIR, extractedFileName, pruneExtracted } from "./prepare.js";
import { buildChunkPrompt } from "./prompt.js";

export interface ExtractProgress { done: number; total: number; chunk: number; status: "written" | "skipped" | "failed" }
export interface ExtractOptions { refresh?: boolean; onProgress?: (p: ExtractProgress) => void }
export interface ExtractResult { total: number; written: number; skipped: number; failed: { chunk: number; error: string }[] }

/** analyze-request.json의 청크마다 어댑터를 호출해 extracted/NNN.json을 쓴다. 실패는 기록하고 계속 간다. */
export async function extract(ws: Workspace, system: string, adapter: LlmAdapter, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const request = await ws.read(system, "analyze-request.json", AnalyzeRequestSchema);
  await mkdir(ws.file(system, EXTRACTED_DIR), { recursive: true });
  await pruneExtracted(ws, system, request.chunks.length);
  const result: ExtractResult = { total: request.chunks.length, written: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const chunk of request.chunks) {
    const rel = path.posix.join(EXTRACTED_DIR, extractedFileName(chunk.index));
    const report = (status: ExtractProgress["status"]) => opts.onProgress?.({ done: ++done, total: result.total, chunk: chunk.index, status });
    if (!opts.refresh && (await exists(ws.file(system, rel)))) { result.skipped += 1; report("skipped"); continue; }
    try {
      const text = await readFile(ws.file(system, chunk.file), "utf8");
      const raw = await adapter.extract({ prompt: buildChunkPrompt(text), schema: request.schema });
      const parsed = ExtractionResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`출력이 스키마와 맞지 않습니다: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      await ws.writeText(system, rel, JSON.stringify(parsed.data, null, 2) + "\n");
      result.written += 1; report("written");
    } catch (e) {
      result.failed.push({ chunk: chunk.index, error: (e as Error).message }); report("failed");
    }
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
```

- [ ] **Step 6: 공개 API와 테스트**

`packages/core/src/index.ts`에 추가:

```ts
export { extract, type ExtractOptions, type ExtractProgress, type ExtractResult } from "./analyze/extract.js";
export { createAdapter, ADAPTER_NAMES, ClaudeCodeAdapter, SessionAdapter, type AdapterName, type LlmAdapter, type ExtractRequest, type ClaudeCodeOptions } from "./llm/index.js";
```

Run: `pnpm build:core && pnpm vitest run packages/core/test/extract.test.ts packages/core/test/llm.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add packages/core/src/llm packages/core/src/analyze/extract.ts packages/core/src/index.ts packages/core/test/llm.test.ts packages/core/test/extract.test.ts packages/core/test/bin
git commit -m "feat(core): LLM 어댑터(claude --print 구조화 출력, 세션)와 청크별 extract"
```

---

### Task 7: CLI — analyze/ingest/run 옵션, `--json` 전 명령, 카탈로그 diff 출력

**Files:**
- Modify: `packages/cli/src/commands/analyze.ts`, `ingest.ts`, `run.ts`, `select.ts`, `context.ts`
- Test: `packages/cli/test/cli.test.ts` (추가)

목표 인터페이스(설계 5.6 갱신):

```
specmock ingest   <system> <file|url>... [--refresh] [--harvest auto|always|never] [--json]
specmock analyze  <system> [--llm session|claude-code] [--model m] [--prepare] [--merge] [--refresh] [--json]
specmock run      <system> <file|url>... [--select expr] [--llm claude-code] [--lang ts] [--out dir] [--no-verify] [--json]
```

`analyze` 동작 규칙:

| 입력 | 옵션 | 동작 |
|---|---|---|
| OpenAPI만 | (무엇이든) | 바로 카탈로그. diff 출력 |
| 문서 포함 | 없음 | `--llm session`과 같음 |
| 문서 포함 | `--llm session` 또는 `--prepare` | prepare만 하고 "할 일" 안내 출력, 종료 0 |
| 문서 포함 | `--llm claude-code` | prepare → extract(진행 표시 stderr) → merge → 표 출력. extract 실패 청크가 있으면 경고하되 merge는 진행 |
| 문서 포함 | `--merge` | prepare 없이 merge만 (extracted/가 준비됐다고 가정). analyze-request.json 없으면 오류 |
| | `--refresh` | extract가 기존 extracted/NNN.json을 무시 |

`--harvest`는 Task 9 전까지 옵션만 받고 `auto`/`never`만 허용한다(`always`는 Task 9에서).

- [ ] **Step 1: 실패하는 CLI 테스트 추가** — `packages/cli/test/cli.test.ts`

```ts
const PETS_MD = path.resolve(here, "..", "..", "core", "test", "fixtures", "docs", "pets.md");
const EXTRACTED = path.resolve(here, "..", "..", "core", "test", "fixtures", "docs", "extracted");
const FAKE_BIN = path.resolve(here, "..", "..", "core", "test", "bin");

describe("Phase 1B CLI", () => {
  it("ingest --json reports inputs and the cache", async () => {
    const { stdout } = await specmock("ingest", "pets", PETS_MD, "--json");
    const j = JSON.parse(stdout);
    expect(j.inputs[0]).toMatchObject({ kind: "markdown", cached: false });
    const again = JSON.parse((await specmock("ingest", "pets", PETS_MD, "--json")).stdout);
    expect(again.inputs[0].cached).toBe(true);
  });

  it("analyze on a document prepares chunks and tells the session what to do", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const { stdout } = await specmock("analyze", "pets");
    expect(stdout).toContain("analyze-request.json");
    expect(stdout).toContain("chunks/000.md");
    expect(stdout).toContain("specmock analyze pets --merge");
    const { stdout: json } = await specmock("analyze", "pets", "--json");
    expect(JSON.parse(json)).toMatchObject({ mode: "prepared", chunks: expect.any(Number) });
  });

  it("analyze --merge builds the catalog from extracted files and prints the table with doc badges", async () => {
    await specmock("ingest", "pets", PETS_MD);
    await specmock("analyze", "pets", "--prepare");
    await cp(EXTRACTED, path.join(dir, ".specmock", "pets", "extracted"), { recursive: true });
    const { stdout } = await specmock("analyze", "pets", "--merge");
    expect(stdout).toContain("pets — 5개 기능 (openapi 0 · 문서추출 4 · 추론 1)");
    expect(stdout).toMatch(/pets\.get\s+GET\s+\/pets\/\{petId\}\s+doc\s+1\.0\s+●/);
    expect(stdout).toContain("거절 1건");
  });

  it("analyze --llm claude-code runs extract with the configured command", async () => {
    await specmock("ingest", "pets", PETS_MD);
    const { stdout, stderr } = await run(TSX, [CLI, "analyze", "pets", "--llm", "claude-code"], { cwd: dir, env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}` } });
    expect(stderr).toMatch(/추출 1\/1/);
    expect(stdout).toContain("1개 기능");
  });

  it("analyze prints a diff against the previous catalog and select warns with counts", async () => {
    await specmock("ingest", "petstore", PETSTORE);
    await specmock("analyze", "petstore");
    await specmock("select", "petstore", "all");
    // 스펙이 바뀐 상황을 흉내 낸다: 기능 하나를 뺀 사본으로 다시 ingest
    const yaml = await readFile(PETSTORE, "utf8");
    const smaller = path.join(dir, "small.yaml");
    await writeFile(smaller, yaml.replace(/\n  \/store\/inventory:[\s\S]*?(?=\ncomponents:)/, "\n"));
    await specmock("ingest", "petstore", smaller, "--refresh");
    const { stdout } = await specmock("analyze", "petstore");
    expect(stdout).toContain("이전 카탈로그 대비: 추가 0 · 삭제 1 (inventory.list) · 변경 0");
    const { stdout: sel } = await specmock("select", "petstore", "getPet");
    expect(sel).toContain("삭제 1");
  });

  it("run --json emits one JSON document", async () => {
    const { stdout } = await specmock("run", "petstore", PETSTORE, "--select", "getPet", "--no-verify", "--json");
    const j = JSON.parse(stdout);
    expect(j).toMatchObject({ system: "petstore", selected: ["getPet"], generate: { outDir: expect.any(String) } });
  });
});
```

(`cp`, `writeFile`를 `node:fs/promises`에서 import에 추가.)

- [ ] **Step 2: 실행해 실패 확인**

Run: `pnpm build:core && pnpm vitest run packages/cli/test/cli.test.ts`
Expected: 새 테스트 FAIL.

- [ ] **Step 3: context.ts 포맷터 추가**

```ts
import type { CatalogDiff, AnalyzeRequest, MergeResult } from "@specmock/core";

export function formatDiff(diff: CatalogDiff): string {
  if (diff.previousAt === null) return "";
  const list = (ids: string[]) => (ids.length ? ` (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""})` : "");
  return `이전 카탈로그 대비: 추가 ${diff.added.length}${list(diff.added)} · 삭제 ${diff.removed.length}${list(diff.removed)} · 변경 ${diff.changed.length}${list(diff.changed)}`;
}

/** 세션 모드 안내. Claude Code 스킬이 이 출력을 그대로 따라간다. */
export function formatPrepared(system: string, req: AnalyzeRequest, wsDir: string): string {
  const lines = [
    `LLM 추출 준비 완료: ${req.chunks.length}개 청크 (${wsDir}/analyze-request.json)`,
    "",
    "다음 중 하나:",
    `  a) specmock analyze ${system} --llm claude-code     # 로컬 claude CLI로 자동 추출`,
    `  b) Claude Code 세션에서 직접 추출:`,
    `     1. ${wsDir}/analyze-request.json 의 prompt 와 schema 를 읽는다`,
    `     2. 청크마다 ${wsDir}/${req.chunks[0]?.file ?? "chunks/000.md"} … 를 읽고 schema 대로 ${wsDir}/extracted/NNN.json 을 쓴다 (한 번에 하나)`,
    `     3. specmock analyze ${system} --merge`,
    "",
    "청크:",
    ...req.chunks.map((c) => `  ${c.file}  ${c.heading}  (${c.chars.toLocaleString()}자)`),
  ];
  return lines.join("\n");
}

export function formatMerge(r: MergeResult): string {
  const parts = [`기능 ${r.features}개`];
  if (r.rejected) parts.push(`거절 ${r.rejected}건 (catalog.json의 rejected 참고)`);
  if (r.missingChunks.length) parts.push(`미추출 청크 ${r.missingChunks.length}개`);
  if (r.invalidChunks.length) parts.push(`형식 오류 청크 ${r.invalidChunks.length}개`);
  return parts.join(" · ");
}
```

- [ ] **Step 4: analyze 명령** — `packages/cli/src/commands/analyze.ts` 전체 교체

```ts
import { analyze, CatalogSchema, createAdapter, extract, formatCatalog, merge, prepare, type AdapterName, type CatalogDiff } from "@specmock/core";
import type { Command } from "commander";
import { EXPR_HELP, fail, formatDiff, formatMerge, formatPrepared, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

interface Opts { llm?: AdapterName; model?: string; prepare: boolean; merge: boolean; refresh: boolean; json: boolean }

export function registerAnalyze(program: Command): void {
  program
    .command("analyze")
    .description("source.json을 분석해 기능 카탈로그(catalog.json)를 만든다. 문서 입력은 LLM 추출을 거친다")
    .argument("<system>", SYSTEM_ARG_HELP)
    .option("--llm <adapter>", "문서 입력의 LLM 어댑터: session(기본, Claude Code 세션이 직접) | claude-code(로컬 claude CLI)")
    .option("--model <model>", "claude-code 어댑터의 모델 (예: sonnet, opus)")
    .option("--prepare", "청크와 analyze-request.json만 만든다", false)
    .option("--merge", "extracted/*.json을 합쳐 카탈로그만 만든다", false)
    .option("--refresh", "이미 있는 extracted/*.json을 무시하고 다시 추출한다", false)
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: Opts, cmd: Command) => {
      const ws = workspaceFrom(cmd);
      if (opts.prepare && opts.merge) fail("--prepare와 --merge는 함께 쓸 수 없습니다.");
      const llm: AdapterName = opts.llm ?? "session";
      if (llm !== "session" && llm !== "claude-code") fail(`알 수 없는 LLM 어댑터: ${llm} (session | claude-code)`);

      const printCatalog = (diff: CatalogDiff | undefined, extra?: Record<string, unknown>) => ws.read(system, "catalog.json", CatalogSchema).then((catalog) => {
        printJsonOr(opts.json, { mode: "catalog", ...extra, diff, catalog }, () => {
          const d = diff ? formatDiff(diff) : "";
          return [formatCatalog(catalog), d, extra?.summary as string | undefined, "", `다음: specmock select ${system} <표현식>`, `표현식: ${EXPR_HELP}`].filter((x) => x !== undefined && x !== "").join("\n");
        });
      });

      if (opts.merge) {
        const r = await merge(ws, system);
        return printCatalog(r.diff, { summary: formatMerge(r), merge: r });
      }

      const outcome = await analyze(ws, system);
      if (outcome.mode === "openapi") return printCatalog(outcome.diff);

      const req = await prepare(ws, system);
      if (llm === "session" || opts.prepare) {
        return printJsonOr(opts.json, { mode: "prepared", chunks: req.chunks.length, request: ws.file(system, "analyze-request.json"), chunkFiles: req.chunks.map((c) => c.file) }, () => formatPrepared(system, req, ws.dir(system)));
      }

      const adapter = createAdapter("claude-code", { claude: { model: opts.model } });
      const ex = await extract(ws, system, adapter, {
        refresh: opts.refresh,
        onProgress: (p) => process.stderr.write(`추출 ${p.done}/${p.total} (청크 ${p.chunk}: ${p.status})\n`),
      });
      if (ex.failed.length) process.stderr.write(`경고: 청크 ${ex.failed.length}개 추출 실패. 첫 오류: ${ex.failed[0].error}\n`);
      const r = await merge(ws, system);
      await printCatalog(r.diff, { summary: formatMerge(r), extract: ex, merge: r });
      if (ex.failed.length) process.exitCode = 2;
    });
}
```

`formatCatalog`의 첫 줄은 이미 `문서추출 N · 추론 M`을 센다. 테스트가 기대하는 "거절 1건"은 `formatMerge`에서 나온다.

- [ ] **Step 5: ingest 명령**

```ts
import { ingest, SourceSchema } from "@specmock/core";
import type { Command } from "commander";
import { fail, printJsonOr, SYSTEM_ARG_HELP, workspaceFrom } from "../context.js";

export function registerIngest(program: Command): void {
  program
    .command("ingest")
    .description("스펙 파일/URL(OpenAPI · HTML · Markdown · PDF · 텍스트)을 읽어 .specmock/<system>/source.json 으로 정규화한다")
    .argument("<system>", `${SYSTEM_ARG_HELP}. 디렉터리 이름으로 쓰인다`)
    .argument("<origins...>", "파일 경로 또는 URL")
    .option("--refresh", "이전에 읽은 원문 캐시를 무시하고 다시 읽는다", false)
    .option("--harvest <mode>", "웹 문서의 숨은 콘텐츠 수확(ego-browser): auto | always | never", "auto")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, origins: string[], opts: { refresh: boolean; harvest: string; json: boolean }, cmd: Command) => {
      if (!["auto", "always", "never"].includes(opts.harvest)) fail(`--harvest 값이 올바르지 않습니다: ${opts.harvest}`);
      const ws = workspaceFrom(cmd);
      const logs: string[] = [];
      const file = await ingest(ws, system, origins, { refresh: opts.refresh, harvest: opts.harvest as "auto" | "always" | "never", onLog: (m) => { logs.push(m); if (!opts.json) process.stderr.write(m + "\n"); } });
      const src = await ws.read(system, "source.json", SourceSchema);
      const inputs = src.inputs.map((i) => ({ kind: i.kind, origin: i.origin, chars: i.content.length, cached: logs.some((l) => l.startsWith(`${i.origin}: 캐시 재사용`)), harvestCandidate: i.harvestCandidate?.reasons ?? [], harvested: Boolean(i.harvested) }));
      printJsonOr(opts.json, { system, file, inputs }, () => {
        const lines = [`source.json 작성: ${file}`];
        for (const i of inputs) {
          lines.push(`  ${i.kind.padEnd(8)} ${i.origin}  ${i.chars.toLocaleString()}자${i.cached ? "  (캐시)" : ""}`);
          if (i.harvestCandidate.length && !i.harvested) lines.push(`           숨은 콘텐츠 가능성: ${i.harvestCandidate.join(", ")}. 수확하려면 --harvest always`);
        }
        lines.push(`다음: specmock analyze ${system}`);
        return lines.join("\n");
      });
    });
}
```

`IngestOptions`에 `harvest?: "auto" | "always" | "never"`를 Task 2 코드에 추가해 둔다(Task 9 전까지는 읽기만 하고 동작 없음).

- [ ] **Step 6: run 명령** — `--llm`, `--json` 추가. 문서 입력이면 `analyze()`가 `needs-llm`을 돌려주므로 `--llm claude-code`가 없으면 실패한다.

```ts
.option("--llm <adapter>", "문서 입력일 때 LLM 어댑터 (claude-code만 가능. 세션 모드는 run 대신 단계별 명령을 쓴다)")
.option("--json", "JSON으로 출력", false)
```

action 안:

```ts
const outcome = await analyze(ws, system);
if (outcome.mode === "needs-llm") {
  if (opts.llm !== "claude-code") fail("문서 입력은 run에서 --llm claude-code 가 필요합니다. 세션 모드는 specmock analyze <system> 으로 단계별로 진행하세요.");
  await prepare(ws, system);
  const ex = await extract(ws, system, createAdapter("claude-code"), { onProgress: (p) => process.stderr.write(`추출 ${p.done}/${p.total}\n`) });
  if (ex.failed.length) process.stderr.write(`경고: 청크 ${ex.failed.length}개 추출 실패\n`);
  await merge(ws, system);
}
```

`--json`일 때는 중간 표를 찍지 않고 마지막에 `{ system, catalog: {features: n}, selected, generate: report, verify: result | null, coverage }` 하나를 출력한다. 기존 텍스트 출력은 그대로.

- [ ] **Step 7: select 경고에 diff 수치**

`select.ts`의 `catalogChanged` 경고에 `catalog-diff.json`이 있으면 `formatDiff`를 덧붙인다:

```ts
const diff = (await ws.exists(system, "catalog-diff.json")) ? await ws.read(system, "catalog-diff.json", CatalogDiffSchema) : null;
const warn = result.catalogChanged ? `\n주의: 카탈로그가 이전 선택 이후 바뀌었습니다.${diff ? " " + formatDiff(diff) : ""} specmock list로 확인하세요.` : "";
```

- [ ] **Step 8: 테스트 통과, README 명령 표 갱신은 Task 12로**

Run: `pnpm build:core && pnpm vitest run packages/cli/test/cli.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: 커밋**

```bash
git add packages/cli/src packages/cli/test packages/core/src/ingest/index.ts
git commit -m "feat(cli): analyze --llm/--prepare/--merge/--refresh, ingest --refresh/--harvest, run --llm, 모든 명령 --json, 카탈로그 diff 출력"
```

---

### Task 8: 골든 테스트, 문서 예제, 실제 LLM 점검 스크립트

**Files:**
- Create: `packages/core/test/fixtures/openapi/with-auth.yaml`
- Create: `packages/core/test/golden/{petstore,with-auth,circular,pets-md,pets-html}/` 각 `expected-catalog.json`
- Create: `packages/core/test/golden.test.ts`, `packages/core/test/golden-update.mjs`
- Create: `examples/docs-sample/{README.md,pets-api.md,extracted/000.json}`
- Create: `scripts/live-llm-check.ts`

- [ ] **Step 1: 인증 포함 스펙** — `packages/core/test/fixtures/openapi/with-auth.yaml`

```yaml
openapi: 3.0.3
info: { title: Orders, version: "1.0" }
security: [{ bearerAuth: [] }]
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
    apiKey: { type: apiKey, in: header, name: X-API-Key }
  schemas:
    Order:
      type: object
      required: [id, total]
      properties:
        id: { type: string, format: uuid }
        total: { type: number, minimum: 0 }
        items: { type: array, items: { $ref: "#/components/schemas/Item" } }
    Item:
      type: object
      properties: { sku: { type: string }, qty: { type: integer, minimum: 1 } }
paths:
  /orders:
    get:
      operationId: listOrders
      tags: [orders]
      parameters: [{ name: status, in: query, schema: { type: string, enum: [open, paid] } }]
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Order" } } } } }
    post:
      operationId: createOrder
      tags: [orders]
      security: [{ apiKey: [] }]
      requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
      responses:
        "201": { description: created, content: { application/json: { schema: { $ref: "#/components/schemas/Order" }, example: { id: "6f1c", total: 10.5, items: [] } } } }
        "401": { description: unauthorized }
  /public/health:
    get:
      operationId: health
      security: []
      responses: { "200": { description: ok, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean } } } } } } }
```

- [ ] **Step 2: 골든 러너와 갱신 스크립트**

`packages/core/test/golden.test.ts`:

```ts
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { merge } from "../src/analyze/merge.js";
import { prepare } from "../src/analyze/prepare.js";
import { ingest } from "../src/ingest/index.js";
import { CatalogSchema, type Catalog } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const GOLDEN = path.join(here, "golden");

export interface GoldenCase { name: string; inputs: string[]; extracted?: string }
export const CASES: GoldenCase[] = [
  { name: "petstore", inputs: [path.join(FIX, "petstore.yaml")] },
  { name: "with-auth", inputs: [path.join(FIX, "openapi", "with-auth.yaml")] },
  { name: "circular", inputs: [path.join(FIX, "circular.yaml")] },
  { name: "pets-md", inputs: [path.join(FIX, "docs", "pets.md")], extracted: path.join(FIX, "docs", "extracted") },
  { name: "pets-html", inputs: [path.join(FIX, "docs", "pets.html")], extracted: path.join(FIX, "docs", "extracted-html") },
];

/** generatedAt처럼 실행마다 달라지는 값을 뺀다. */
export function stable(catalog: Catalog): Omit<Catalog, "generatedAt"> {
  const { generatedAt: _g, ...rest } = catalog;
  return rest;
}

export async function produce(c: GoldenCase): Promise<Catalog> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `specmock-golden-${c.name}-`));
  try {
    const ws = new Workspace(dir);
    await ingest(ws, c.name, c.inputs);
    const outcome = await analyze(ws, c.name);
    if (outcome.mode === "needs-llm") {
      await prepare(ws, c.name);
      if (c.extracted) await cp(c.extracted, path.join(dir, c.name, "extracted"), { recursive: true });
      await merge(ws, c.name);
    }
    return await ws.read(c.name, "catalog.json", CatalogSchema);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("golden catalogs", () => {
  for (const c of CASES) {
    it(`${c.name} matches expected-catalog.json`, async () => {
      const actual = stable(await produce(c));
      const expected = JSON.parse(await readFile(path.join(GOLDEN, c.name, "expected-catalog.json"), "utf8"));
      expect(actual, `바뀐 것이 의도한 것이면: node packages/core/test/golden-update.mjs ${c.name}`).toEqual(expected);
    });
  }
});
```

`packages/core/test/golden-update.mjs` — 기대 파일을 다시 쓴다. vitest 밖에서 돌리므로 `tsx`로 TS를 불러온다:

```js
#!/usr/bin/env node
// 사용: pnpm build:core && node --import tsx packages/core/test/golden-update.mjs [case...]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const { CASES, produce, stable } = await import("./golden.test.ts");
const only = new Set(process.argv.slice(2));
for (const c of CASES) {
  if (only.size && !only.has(c.name)) continue;
  const dir = path.join(here, "golden", c.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "expected-catalog.json"), JSON.stringify(stable(await produce(c)), null, 2) + "\n");
  console.log(`updated ${c.name}`);
}
```

`golden.test.ts`를 import하면 `describe`가 평가되므로 vitest 전역이 없어 실패한다. 해결: 러너 함수(`CASES`, `produce`, `stable`)를 `packages/core/test/golden/cases.ts`로 분리하고 `golden.test.ts`와 `golden-update.mjs`가 둘 다 그걸 import한다. 위 코드를 그렇게 나눈다.

- [ ] **Step 3: HTML용 녹음 응답** — `packages/core/test/fixtures/docs/extracted-html/000.json`

`pets.html`은 `htmlToMarkdown` 결과가 `pets.md`와 비슷하지만 탭 패널·select 뒤 내용(`curl`, `Node`, 404 예시)이 본문에 포함된다(`unhide`). 청크가 하나이면 `extracted/000.json`을 복사해 쓰고, 둘 이상이면 나머지 청크는 `{"endpoints":[]}`로 둔다. 실제 청크 수는 `prepare`를 돌려 확인한다.

- [ ] **Step 4: 기대 파일 생성과 검토**

Run: `pnpm build:core && node --import tsx packages/core/test/golden-update.mjs && git diff --stat && pnpm vitest run packages/core/test/golden.test.ts`

생성된 `expected-catalog.json` 다섯 개를 **눈으로** 검토한다. 확인 항목: `with-auth`에서 `listOrders.auth === "bearer"`, `createOrder.auth === "apiKey"`, `health.auth === "none"`; `circular`에 `x-specmock-circular` 표식; `pets-md`의 `pets.get.confidence === 1`, `pets.update.provenance === "inferred"`, `rejected` 1건. 틀리면 코드가 틀린 것이지 기대 파일을 고치는 것이 아니다.

- [ ] **Step 5: 문서 예제** — `examples/docs-sample/`

`pets-api.md`는 `packages/core/test/fixtures/docs/pets.md`의 복사본에 "## Authentication" 섹션을 추가한 것. `extracted/000.json`은 실제 `claude --print`로 한 번 뽑아 넣는다(이 단계에서 구독으로 1회 호출. 결과는 사람이 검토 후 커밋).

`examples/docs-sample/README.md`:

````markdown
# 문서(Markdown) 예제

OpenAPI가 없는 문서에서 기능을 추출해 mock을 만드는 흐름. 저장소 루트에서 실행한다.

## A. 로컬 Claude Code로 자동 추출

```bash
pnpm specmock ingest docs examples/docs-sample/pets-api.md
pnpm specmock analyze docs --llm claude-code        # 청크별로 claude --print 호출 → 표 출력
pnpm specmock select docs all
pnpm specmock generate docs && pnpm specmock verify docs
```

표의 `출처` 열이 `doc`, `신뢰` 열이 1.0 미만인 행은 문서에서 추출한 것이다. `specmock show docs pets.get`으로 근거 인용을 볼 수 있다.

## B. LLM 호출 없이 재현 (녹음된 응답 사용)

```bash
pnpm specmock ingest docs examples/docs-sample/pets-api.md
pnpm specmock analyze docs --prepare
cp examples/docs-sample/extracted/*.json .specmock/docs/extracted/
pnpm specmock analyze docs --merge
```

`extracted/000.json`은 2026-11-05에 `claude --print --model sonnet`이 돌려준 결과 그대로다. 같은 입력이라도 모델 출력은 달라질 수 있으므로 README의 표는 B 기준이다.

## C. Claude Code 세션에서 (스킬)

`claude --plugin-dir ./plugin` 으로 세션을 열고 "examples/docs-sample/pets-api.md 로 mock 만들어줘"라고 하면 스킬이 위 단계를 안내하며 추출을 Claude가 직접 수행한다. [plugin/README.md](../../plugin/README.md) 참고.
````

- [ ] **Step 6: 실제 LLM 점검 스크립트** — `scripts/live-llm-check.ts` (CI 제외, 수동 실행)

```ts
// pnpm build:core && pnpm tsx scripts/live-llm-check.ts [model]
// 로컬 claude CLI가 구조화 출력을 제대로 내는지 1회 확인한다. 구독 호출이 발생한다.
import { ClaudeCodeAdapter, extractionJsonSchema, ExtractionResultSchema, buildChunkPrompt } from "@specmock/core";

const model = process.argv[2];
const adapter = new ClaudeCodeAdapter({ model, timeoutMs: 120_000 });
const chunk = "## Get a pet\n\n`GET /pets/{petId}` returns one pet.\n\n```json\n{\"id\": 1, \"name\": \"Rex\"}\n```\n";
const started = Date.now();
const out = await adapter.extract({ prompt: buildChunkPrompt(chunk), schema: extractionJsonSchema() });
const parsed = ExtractionResultSchema.safeParse(out);
console.log(JSON.stringify(out, null, 2));
console.log(parsed.success ? `OK (${Date.now() - started}ms, model=${model ?? "default"})` : `스키마 불일치: ${parsed.error.message}`);
process.exit(parsed.success && parsed.data.endpoints.some((e) => e.path === "/pets/{petId}") ? 0 : 1);
```

루트 `package.json` scripts에 `"llm:check": "pnpm -s build:core && tsx scripts/live-llm-check.ts"` 추가. `tsx`가 루트 devDependency에 있으므로 `@specmock/core`를 루트에서 resolve하려면 루트 `package.json` devDependencies에 `"@specmock/core": "workspace:*"`를 추가한다.

Run: `pnpm llm:check` → `OK (...)`. 결과를 계획 실행 기록에 적는다(시간, 모델).

- [ ] **Step 7: 전체 테스트와 커밋**

Run: `pnpm test && pnpm typecheck`

```bash
git add packages/core/test/golden packages/core/test/golden.test.ts packages/core/test/golden-update.mjs packages/core/test/fixtures/openapi packages/core/test/fixtures/docs/extracted-html examples/docs-sample scripts package.json pnpm-lock.yaml
git commit -m "test: 골든 카탈로그 5종(OpenAPI 3 · 인증 · 순환 · Markdown · HTML), 문서 예제, 실제 LLM 점검 스크립트"
```

---

## Part B — 수확 · 스킬 · 대화형 선택 · 문서

### Task 9: ego-browser 수확 스크립트와 ingest 통합

**Files:**
- Create: `packages/core/src/harvest/pageScript.ts`, `packages/core/src/harvest/script.ts`, `packages/core/src/harvest/index.ts`
- Modify: `packages/core/src/ingest/index.ts` (`harvest` 옵션 동작), `packages/core/src/index.ts`
- Test: `packages/core/test/harvest-page.test.ts`(항상), `packages/core/test/harvest-ego.test.ts`(ego-browser 있을 때만)

설계 5.1의 7단계 중 1~6을 자동화한다. 7(수동 탐색)은 스킬 문서(Task 10)에 둔다.

**구조:** 브라우저 안에서 도는 코드는 `pageScript.ts`에 **문자열이 아니라 함수**로 쓰고, `script.ts`가 `Function.prototype.toString()`으로 소스를 꺼내 `ego-browser nodejs` 스크립트 본문에 끼워 넣는다. 그래서 같은 함수를 linkedom으로 단위 테스트할 수 있다. `pageScript.ts`의 함수는 외부 변수를 참조하지 않고 `document`만 쓴다(`page.evaluate` 제약).

- [ ] **Step 1: 실패하는 테스트 — 페이지 스크립트** — `packages/core/test/harvest-page.test.ts`

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { collectInteractives, expandAll, panelHtml, referenceLinks } from "../src/harvest/pageScript.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async () => parseHTML(await readFile(path.join(here, "fixtures", "docs", "pets.html"), "utf8"));

describe("harvest pageScript", () => {
  it("expandAll opens details and aria-expanded=false", async () => {
    const { document } = await load();
    const n = expandAll(document as unknown as Document);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("collectInteractives lists tabs with their panel ids and selects with options", async () => {
    const { document } = await load();
    const r = collectInteractives(document as unknown as Document);
    expect(r.tabs).toEqual([
      { selector: "[role='tab'][aria-controls='tab-curl']", label: "curl", panel: "tab-curl" },
      { selector: "[role='tab'][aria-controls='tab-node']", label: "Node", panel: "tab-node" },
    ]);
    expect(r.selects).toEqual([{ selector: "#resp", label: "Response example", options: [{ value: "200", label: "200" }, { value: "404", label: "404" }] }]);
    expect(r.listboxes).toEqual([]);
  });

  it("panelHtml returns the panel markup", async () => {
    const { document } = await load();
    expect(panelHtml(document as unknown as Document, "tab-node")).toContain('await fetch("https://api.example.com/v1/pets")');
  });

  it("referenceLinks keeps same-origin api/docs/reference links only", async () => {
    const { document } = await load();
    const links = referenceLinks(document as unknown as Document, "https://x.test/docs/pets");
    expect(links).toEqual(["https://x.test/docs"]);
  });
});
```

- [ ] **Step 2: 페이지 스크립트 구현** — `packages/core/src/harvest/pageScript.ts`

```ts
/**
 * 브라우저 문서 안에서 실행되는 순수 함수들. `page.evaluate(fn, arg)`로 넘기므로
 * 모듈 스코프의 다른 식별자를 참조하면 안 된다(각 함수는 자기 완결).
 */

export function expandAll(document: Document): number {
  let n = 0;
  for (const d of Array.from(document.querySelectorAll("details"))) { if (!d.hasAttribute("open")) { d.setAttribute("open", ""); n++; } }
  for (const el of Array.from(document.querySelectorAll("[aria-expanded='false']"))) { el.setAttribute("aria-expanded", "true"); n++; }
  return n;
}

export interface TabInfo { selector: string; label: string; panel: string }
export interface SelectInfo { selector: string; label: string; options: { value: string; label: string }[] }
export interface ListboxInfo { selector: string; label: string; optionCount: number }
export interface Interactives { tabs: TabInfo[]; selects: SelectInfo[]; listboxes: ListboxInfo[] }

export function collectInteractives(document: Document): Interactives {
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const labelFor = (el: Element): string => {
    const id = el.getAttribute("id");
    const byFor = id ? document.querySelector(`label[for='${id}']`) : null;
    if (byFor) return text(byFor).replace(text(el), "").trim();
    const wrap = el.closest("label");
    if (wrap) return text(wrap).replace(text(el), "").trim();
    return el.getAttribute("aria-label") ?? el.getAttribute("name") ?? id ?? "";
  };
  const cssId = (el: Element, fallback: string) => (el.getAttribute("id") ? `#${el.getAttribute("id")}` : fallback);

  const tabs: TabInfo[] = Array.from(document.querySelectorAll("[role='tab']")).map((t, i) => {
    const panel = t.getAttribute("aria-controls") ?? "";
    return { selector: panel ? `[role='tab'][aria-controls='${panel}']` : `[role='tab'] >> nth=${i}`, label: text(t), panel };
  });
  const selects: SelectInfo[] = Array.from(document.querySelectorAll("select")).map((s, i) => ({
    selector: cssId(s, `select >> nth=${i}`), label: labelFor(s),
    options: Array.from((s as HTMLSelectElement).options).map((o) => ({ value: o.value, label: text(o) })),
  }));
  const listboxes: ListboxInfo[] = Array.from(document.querySelectorAll("[role='combobox'], [role='listbox']")).map((l, i) => ({
    selector: cssId(l, `[role='combobox'], [role='listbox'] >> nth=${i}`), label: labelFor(l), optionCount: l.querySelectorAll("[role='option']").length,
  }));
  return { tabs, selects, listboxes };
}

export function panelHtml(document: Document, panelId: string): string {
  return document.getElementById(panelId)?.outerHTML ?? "";
}

/** 본문(main/article/body) HTML. 수확 전후 비교용. */
export function bodyHtml(document: Document): string {
  return (document.querySelector("main, article") ?? document.body)?.innerHTML ?? "";
}

export function referenceLinks(document: Document, currentUrl: string): string[] {
  const base = new URL(currentUrl);
  const out = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    let u: URL;
    try { u = new URL(a.getAttribute("href") ?? "", currentUrl); } catch { continue; }
    if (u.origin !== base.origin) continue;
    u.hash = "";
    if (u.href === base.href) continue;
    if (/\/(api|reference|docs?|endpoints?)(\/|$)/i.test(u.pathname)) out.add(u.href);
  }
  return Array.from(out).sort();
}
```

Run: `pnpm vitest run packages/core/test/harvest-page.test.ts` → PASS. (`>> nth=` 셀렉터는 ego-browser가 지원하는 Playwright 부분집합이다.)

- [ ] **Step 3: 스크립트 생성기** — `packages/core/src/harvest/script.ts`

```ts
import { bodyHtml, collectInteractives, expandAll, panelHtml, referenceLinks } from "./pageScript.js";

export interface HarvestParams { url: string; outFile: string; maxPages: number; maxDepth: number; spaceName: string; perPageTimeoutMs: number }

/**
 * `ego-browser nodejs`에 넘길 스크립트 본문. 환경변수와 cwd를 상속하지 않으므로 모든 값을 리터럴로 박는다.
 * 결과는 outFile에 JSON으로 쓴다: { pages: [{url,title,html}], interactions: [{type,label,html}], notes: [] }
 * HTML → Markdown 변환은 코어(Node 쪽)에서 htmlToMarkdown으로 한다.
 */
export function buildHarvestScript(p: HarvestParams): string {
  const fns = [expandAll, collectInteractives, panelHtml, bodyHtml, referenceLinks].map((f) => f.toString()).join("\n");
  return `
const PARAMS = ${JSON.stringify(p)};
${fns}
const { writeFile } = await import("node:fs/promises");
const result = { pages: [], interactions: [], notes: [] };
const task = await taskSpace(PARAMS.spaceName);
const page = task.page("p1");
const seen = new Set();
const queue = [{ url: PARAMS.url, depth: 0 }];

async function diffAfter(action, label, type) {
  const before = await page.evaluate(bodyHtml);
  try { await action(); } catch (e) { result.notes.push(label + ": " + (e && e.message ? e.message : String(e))); return; }
  await new Promise((r) => setTimeout(r, 300));
  const after = await page.evaluate(bodyHtml);
  if (after !== before) result.interactions.push({ type, label, html: after });
}

while (queue.length && seen.size < PARAMS.maxPages) {
  const { url, depth } = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);
  try { await page.goto(url, { timeout: PARAMS.perPageTimeoutMs }); } catch (e) { result.notes.push("goto 실패 " + url + ": " + e.message); continue; }
  await page.evaluate(expandAll);
  const title = await page.title();
  const inter = await page.evaluate(collectInteractives);
  for (const t of inter.tabs) {
    await diffAfter(() => page.click(t.selector, { label: "open tab " + t.label }), (title || url) + " / 탭: " + t.label, "tab");
    const html = await page.evaluate(panelHtml, t.panel);
    if (html) result.interactions.push({ type: "tab", label: (title || url) + " / 탭 패널: " + t.label, html });
  }
  for (const s of inter.selects) {
    for (const o of s.options) {
      await diffAfter(() => page.selectOption(s.selector, o.value), (title || url) + " / " + (s.label || s.selector) + " = " + o.label, "select");
    }
  }
  for (const l of inter.listboxes) result.notes.push("커스텀 드롭다운 " + (l.label || l.selector) + " (옵션 " + l.optionCount + "개)는 자동 수확하지 않음. 수동 탐색 필요");
  result.pages.push({ url, title, html: await page.evaluate(bodyHtml) });
  if (depth < PARAMS.maxDepth) for (const link of await page.evaluate(referenceLinks, url)) if (!seen.has(link)) queue.push({ url: link, depth: depth + 1 });
}
if (queue.length) result.notes.push("페이지 상한 " + PARAMS.maxPages + " 도달. 미방문 " + queue.length + "개");
await writeFile(PARAMS.outFile, JSON.stringify(result), "utf8");
console.log("harvest done: pages=" + result.pages.length + " interactions=" + result.interactions.length);
`;
}
```

`page.evaluate(fn, arg)`에 넘기는 함수는 스크립트 문자열 안에 이름 있는 함수 선언으로 들어가므로 그대로 참조된다. TypeScript가 `export function` 소스를 `toString()`으로 꺼낼 때 ESM 빌드 결과는 `function expandAll(document) {...}` 형태다(타입 주석은 빌드 시 제거). tsx로 돌릴 때도 esbuild가 주석을 떼므로 같다. 테스트에서 `buildHarvestScript(...)`가 `function expandAll(` 을 포함하고 `: Document`를 포함하지 않음을 확인한다.

- [ ] **Step 4: 러너와 ingest 통합** — `packages/core/src/harvest/index.ts`

```ts
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { htmlToMarkdown } from "../ingest/html.js";
import { hashText } from "../util/hash.js";
import type { Harvested } from "../types.js";
import { buildHarvestScript } from "./script.js";

export interface HarvestOptions { command?: string; maxPages?: number; maxDepth?: number; timeoutMs?: number; onLog?: (m: string) => void }

export async function isEgoBrowserAvailable(command = "ego-browser"): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

interface RawResult { pages: { url: string; title: string; html: string }[]; interactions: { type: Harvested["interactions"][number]["type"]; label: string; html: string }[]; notes: string[] }

export async function harvest(url: string, opts: HarvestOptions = {}): Promise<Harvested> {
  const command = opts.command ?? "ego-browser";
  const tmp = await mkdtemp(path.join(os.tmpdir(), "specmock-harvest-"));
  const outFile = path.join(tmp, "result.json");
  const script = buildHarvestScript({
    url, outFile, maxPages: opts.maxPages ?? 50, maxDepth: opts.maxDepth ?? 2, perPageTimeoutMs: 20_000,
    spaceName: `specmock harvest ${new URL(url).host}`,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`ego-browser 수확 시간 초과 (${opts.timeoutMs ?? 300_000}ms)`)); }, opts.timeoutMs ?? 300_000);
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`ego-browser를 실행할 수 없습니다: ${e.message}`)); });
      child.stdout.on("data", (d) => opts.onLog?.(String(d).trim()));
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ego-browser 종료 코드 ${code}: ${err.trim().slice(0, 500)}`)); });
      child.stdin.end(script);
    });
    const raw = JSON.parse(await readFile(outFile, "utf8")) as RawResult;
    // HTML → Markdown, 내용 해시로 중복 제거
    const seen = new Set<string>();
    const dedupe = (md: string) => { const h = hashText(md.trim()); if (seen.has(h)) return false; seen.add(h); return true; };
    const pages = raw.pages.map((p) => ({ url: p.url, title: p.title, content: htmlToMarkdown(p.html, p.url).markdown })).filter((p) => dedupe(p.content));
    const interactions = raw.interactions.map((i) => ({ type: i.type, label: i.label, content: htmlToMarkdown(i.html, url).markdown })).filter((i) => i.content.trim().length > 0 && dedupe(i.content));
    return { pages, interactions, notes: raw.notes };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
```

`htmlToMarkdown`은 조각 HTML(패널 하나)도 받아야 한다. Readability가 null을 돌려주면 폴백이 `body`를 쓰므로 동작하지만, 짧은 조각에 `<!-- source -->` 주석이 붙는 것은 괜찮다.

`ingest/index.ts`의 `ingest()`에 수확을 붙인다(`IngestOptions.harvest`, 기본 `"auto"`):

```ts
const mode = opts.harvest ?? "auto";
for (const origin of origins) {
  ...
  const input = await ingestOne(origin);
  if (input.kind === "html" && /^https?:\/\//.test(origin) && mode !== "never" && (mode === "always" || input.harvestCandidate)) {
    if (await isEgoBrowserAvailable()) {
      opts.onLog?.(`${origin}: ego-browser 수확 시작 (${input.harvestCandidate?.reasons.join(", ") ?? "always"})`);
      try {
        input.harvested = await harvest(origin, { onLog: opts.onLog });
        opts.onLog?.(`${origin}: 수확 완료 — 페이지 ${input.harvested.pages.length}, 상호작용 ${input.harvested.interactions.length}`);
      } catch (e) {
        input.harvested = { pages: [], interactions: [], notes: [`수확 실패: ${(e as Error).message}. 숨은 콘텐츠 누락 가능`] };
        opts.onLog?.(`${origin}: 수확 실패, 일반 fetch 결과로 진행 (${(e as Error).message})`);
      }
    } else {
      input.harvested = { pages: [], interactions: [], notes: ["ego-browser 미설치. 수확 미수행, 숨은 콘텐츠 누락 가능"] };
      opts.onLog?.(`${origin}: ego-browser가 없어 수확을 건너뜀`);
    }
  }
  inputs.push(input);
}
```

`harvested.notes`는 merge가 카탈로그에 넣지 않지만 coverage에 보여야 한다. `renderCoverage`는 mockspec만 보므로 **select가 `assumptions`에 source의 `harvested.notes`를 복사**한다(`select/index.ts`에서 `source.json`을 읽어 `assumptions.unshift(...notes.map(n => "입력: " + n))`). 테스트: `select.test.ts`에 한 케이스 추가.

- [ ] **Step 5: ego-browser 통합 테스트** — `packages/core/test/harvest-ego.test.ts`

```ts
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harvest, isEgoBrowserAvailable } from "../src/harvest/index.js";
import { buildHarvestScript } from "../src/harvest/script.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("buildHarvestScript", () => {
  it("inlines the page functions without type annotations", () => {
    const s = buildHarvestScript({ url: "https://x.test/", outFile: "/tmp/o.json", maxPages: 1, maxDepth: 0, spaceName: "t", perPageTimeoutMs: 1000 });
    expect(s).toContain("function expandAll(");
    expect(s).toContain("function collectInteractives(");
    expect(s).not.toMatch(/:\s*Document\b/);
    expect(s).toContain('"outFile":"/tmp/o.json"');
  });
});

const available = await isEgoBrowserAvailable();

describe.skipIf(!available)("harvest with a real ego-browser", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    const html = await readFile(path.join(here, "fixtures", "docs", "pets.html"), "utf8");
    server = createServer((req, res) => {
      if (req.url === "/docs/pets") { res.setHeader("content-type", "text/html"); res.end(html); return; }
      if (req.url === "/docs") { res.setHeader("content-type", "text/html"); res.end("<html><body><main><h1>Index</h1><a href='/docs/pets'>Pets</a></main></body></html>"); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("captures tab panels, select options and follows reference links", async () => {
    const h = await harvest(`${base}/docs/pets`, { maxPages: 3, maxDepth: 1, timeoutMs: 120_000 });
    expect(h.pages.map((p) => p.url)).toEqual(expect.arrayContaining([`${base}/docs/pets`, `${base}/docs`]));
    const all = h.interactions.map((i) => `${i.type}|${i.label}|${i.content}`).join("\n");
    expect(all).toContain('await fetch("https://api.example.com/v1/pets")');     // 숨은 탭 패널
    expect(all).toContain('"code": 404');                                          // select 404 선택 후 드러난 내용
    expect(h.interactions.some((i) => i.type === "select" && /404/.test(i.label))).toBe(true);
  }, 180_000);
});
```

이 기기에는 ego-browser가 설치돼 있으므로 실제로 돈다. 첫 실행에서 Ego Lite 앱이 뜰 수 있다. 실패하면 `ego-browser skill` 출력에서 `help("page.selectOption")`로 시그니처를 확인하고 스크립트를 고친다. 셀렉터 문법(`>> nth=`)이 거부되면 `collectInteractives`가 요소에 `data-specmock-i` 속성을 붙이고 그 속성 셀렉터를 쓰도록 바꾼다.

- [ ] **Step 6: 공개 API, 전체 테스트, 커밋**

`index.ts`: `export { harvest, isEgoBrowserAvailable, type HarvestOptions } from "./harvest/index.js"; export { buildHarvestScript } from "./harvest/script.js";`

Run: `pnpm test && pnpm typecheck`

```bash
git add packages/core/src/harvest packages/core/src/ingest/index.ts packages/core/src/select/index.ts packages/core/src/index.ts packages/core/test/harvest-page.test.ts packages/core/test/harvest-ego.test.ts packages/core/test/select.test.ts
git commit -m "feat(core): ego-browser 수확 — details 펼치기, 탭·select 순회, 참조 링크 깊이 2, ingest --harvest 통합"
```

---

### Task 10: Claude Code 플러그인과 specmock 스킬

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/README.md`, `plugin/skills/specmock/SKILL.md`, `plugin/skills/specmock/references/extraction.md`, `plugin/skills/specmock/references/manual-harvest.md`
- Test: `packages/cli/test/plugin.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `packages/cli/test/plugin.test.ts`

```ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..", "..", "..", "plugin");
const run = promisify(execFile);

describe("Claude Code plugin", () => {
  it("has a valid manifest", async () => {
    const m = JSON.parse(await readFile(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    expect(m).toMatchObject({ name: "specmock", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it("skill has frontmatter and walks through every CLI step", async () => {
    const skill = await readFile(path.join(PLUGIN, "skills", "specmock", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: specmock\ndescription:")).toBe(true);
    for (const cmd of ["specmock ingest", "specmock analyze", "specmock list", "specmock select", "specmock generate", "specmock verify", "--merge", "analyze-request.json", "extracted/"]) {
      expect(skill, `SKILL.md should mention ${cmd}`).toContain(cmd);
    }
  });

  it("passes `claude plugin validate` when the claude CLI is installed", async () => {
    try { await run("claude", ["--version"]); } catch { return; } // CLI 없으면 건너뜀
    const { stdout, stderr } = await run("claude", ["plugin", "validate", PLUGIN]);
    expect(stdout + stderr).not.toMatch(/error/i);
  });
});
```

- [ ] **Step 2: 매니페스트** — `plugin/.claude-plugin/plugin.json`

```json
{
  "name": "specmock",
  "description": "API 스펙(OpenAPI · 웹 문서 · PDF)에서 기능 목록을 뽑고, 필요한 것만 골라 mock 서버를 생성한다",
  "version": "0.1.0",
  "author": { "name": "geonhos" },
  "homepage": "https://github.com/geonhos/specmock",
  "repository": "https://github.com/geonhos/specmock",
  "license": "MIT",
  "keywords": ["mock", "openapi", "api", "contract-test"]
}
```

- [ ] **Step 3: 스킬 본문** — `plugin/skills/specmock/SKILL.md`

```markdown
---
name: specmock
description: Use when the user wants a mock server for an external API from a spec, docs URL, PDF or Markdown — "이 API mock 만들어줘", "스펙 분석해서 필요한 것만", "연동 테스트용 가짜 서버". Walks ingest → analyze → feature list → user selection → generate → verify with the specmock CLI, doing the LLM extraction in-session for unstructured docs.
---

# specmock

스펙에서 **기능 목록을 먼저 보여주고, 사용자가 고른 것만** mock으로 만든다. 모든 상태는 `.specmock/<system>/` 파일이다. 아래 단계를 순서대로 밟고, 각 단계의 출력을 요약해 보여준다.

## 0. 준비

- CLI 확인: `specmock --version`. 없으면 저장소 루트에서 `pnpm specmock`으로 대신 실행한다(이 저장소 안일 때). 둘 다 안 되면 사용자에게 설치를 안내하고 멈춘다.
- 시스템 이름을 정한다(예: `stripe`, `partner-api`). 사용자가 말하지 않았으면 입력 파일명에서 짧게 만든다.

## 1. ingest — 스펙 읽기

```bash
specmock ingest <system> <파일|URL>... [--harvest auto|always|never]
```

- 출력에 "숨은 콘텐츠 가능성"이 있으면 ego-browser가 수확을 시도한 것이다. "ego-browser 미설치"나 "수확 실패"가 보이면 사용자에게 알리고, 필요하면 [수동 수확](references/manual-harvest.md)으로 보충한다.
- 같은 URL을 다시 읽을 때는 캐시가 쓰인다. 문서가 바뀌었다고 하면 `--refresh`.

## 2. analyze — 기능 카탈로그

```bash
specmock analyze <system>
```

**OpenAPI만 있으면** 바로 표가 나온다. 3단계로 간다.

**문서(HTML/Markdown/PDF/텍스트)가 있으면** "LLM 추출 준비 완료"가 나오고 `analyze-request.json`과 `chunks/NNN.md`가 생긴다. 이때 추출은 **당신(Claude)이 직접** 한다. 절차는 [extraction.md](references/extraction.md). 요약:

1. `.specmock/<system>/analyze-request.json`의 `prompt`와 `schema`를 읽는다.
2. 청크 파일을 **하나씩** 읽고, `prompt`의 규칙대로 `schema`에 맞는 JSON을 `.specmock/<system>/extracted/NNN.json`에 쓴다. 근거 인용은 원문 그대로 복사한다. 엔드포인트가 없으면 `{"endpoints": []}`.
3. 모든 청크가 끝나면 `specmock analyze <system> --merge`.

청크가 20개를 넘으면 사용자에게 수를 알리고, 로컬 CLI 자동 추출(`specmock analyze <system> --llm claude-code`)을 쓸지 묻는다.

## 3. 기능 목록 보여주기와 선택 받기

`analyze`(또는 `specmock list <system>`)의 표를 그대로 보여준다. 함께 설명할 것:

- `출처` 열: `spec`은 확실, `doc`은 문서에서 추출(신뢰도 참고), `inf`는 method/path를 추측한 것.
- `샘플` 열: `●`은 실제 응답 예시가 있어 mock 응답이 진짜와 비슷하다. `○`은 스키마로 임의 생성. `—`는 빈 객체.
- `⚠` 표시 행은 `specmock show <system> <id>`로 근거와 주의를 보여주고 포함 여부를 사용자에게 묻는다.
- `catalog.json`의 `rejected`가 비어 있지 않으면 "추출했지만 버린 항목 N개"와 이유를 요약한다.

사용자에게 **어떤 기능이 필요한지** 묻는다. 번호, id, 그룹(`group:pets`), 패턴, `all`을 받을 수 있다. 사용자가 "다 해줘"라고 해도 `inf`와 신뢰도 0.5 미만 행은 포함할지 한 번 확인한다.

## 4. select → generate → verify

```bash
specmock select <system> <표현식>...
specmock generate <system>          # ./mock/<system>/
specmock verify <system>            # mock 기동 → contract test → coverage.md
```

verify 결과(`contract: 통과 N / 실패 M`)와 `coverage.md` 상단 요약(fixture 출처 비율, 가정 목록)을 보여준다. 실패가 있으면 해당 contract의 오류를 옮겨 적고, 보통 원인(문서 샘플이 스키마와 불일치 등)과 함께 사용자에게 알린다. 고치는 방법은 `mock/<system>/fixtures/<id>/<status>.json` 편집이다.

## 5. 마무리와 추가

- 실행법: `cd mock/<system> && npm install && npm start` (기본 포트 4010).
- 나중에 기능 추가: `specmock select <system> --add <id> && specmock generate <system>`. 선택하지 않은 경로를 호출하면 mock이 501과 함께 이 명령을 알려준다.
- 스펙이 바뀌면 `ingest --refresh` → `analyze`. 출력의 "이전 카탈로그 대비" 줄을 사용자에게 보여준다.

## 하지 말 것

- 카탈로그 표를 건너뛰고 바로 생성하지 않는다. 선택은 사용자의 것이다.
- 추출할 때 청크에 없는 엔드포인트를 상식으로 보태지 않는다. 없으면 빈 배열.
- `extracted/NNN.json`을 손으로 "정리"하지 않는다. merge가 검증한다.
```

- [ ] **Step 4: 참고 문서 두 개**

`plugin/skills/specmock/references/extraction.md`:

```markdown
# 세션 내 추출 절차

`specmock analyze <system>`이 "LLM 추출 준비 완료"를 출력했을 때.

1. `cat .specmock/<system>/analyze-request.json` — `prompt`(규칙), `schema`(출력 형식), `chunks`(파일 목록)를 읽는다.
2. 청크마다:
   - `chunks/NNN.md`를 읽는다. 한 번에 한 파일만.
   - `prompt`의 규칙 1~8을 적용해 JSON을 만든다. 핵심: method/path는 문서에 있는 그대로, 샘플 응답은 원문 JSON 그대로, `evidence`는 원문 문장 복사, 확신이 없으면 `confidence`를 낮춘다.
   - `schema`에 맞는지 스스로 확인한다(필수 키: `endpoints[]`, 각 항목 `method path title responses evidence confidence`).
   - `.specmock/<system>/extracted/NNN.json`에 쓴다(디렉터리가 없으면 만든다).
3. `specmock analyze <system> --merge`.
4. 출력의 "거절 N건"이 있으면 `catalog.json`의 `rejected[].reason`을 읽고, 수정 가능한 것(예: path에 호스트가 섞임)은 해당 `extracted/NNN.json`을 고친 뒤 다시 `--merge`.

청크를 건너뛰면 merge가 "미추출"로 기록하고 그 청크의 기능은 카탈로그에 빠진다. 건너뛴 사실을 사용자에게 말한다.
```

`plugin/skills/specmock/references/manual-harvest.md`:

```markdown
# 수동 수확 (ego-browser)

자동 수확이 안 됐거나(미설치 · 로그인 필요 · 타임아웃) 수확 후에도 기능이 0건일 때. ego-browser 스킬(`ego-browser skill`)의 절차를 따른다.

1. 페이지를 열고 스냅샷을 본다. 탭, 셀렉트박스, "더 보기", 아코디언을 찾는다.
2. 각각 조작하고, 드러난 영역의 텍스트를 `page.evaluate`로 가져온다(코드 블록은 그대로).
3. 가져온 내용을 `.specmock/<system>/source.json`의 해당 input에 추가한다:
   `harvested.interactions.push({ "type": "tab" | "select" | "details" | "listbox", "label": "<무엇을 눌렀는지>", "content": "<Markdown 또는 텍스트>" })`
   (`harvested`가 없으면 `{ "pages": [], "interactions": [], "notes": [] }`로 만든다.)
4. `specmock analyze <system>`을 다시 실행하면 prepare가 수확 내용을 "## [수확] …" 섹션으로 청크에 포함한다.

로그인이 필요한 문서는 사용자에게 ego-browser 창에서 로그인해 달라고 요청한 뒤 진행한다. 자격 증명을 대신 입력하지 않는다.
```

- [ ] **Step 5: plugin/README.md**

```markdown
# specmock Claude Code 플러그인

Claude Code 안에서 "이 스펙으로 mock 만들어줘"라고 하면 `specmock` 스킬이 CLI 단계를 안내하고, 웹 문서처럼 LLM이 읽어야 하는 스펙은 세션의 Claude가 직접 추출한다(추가 API 키 없음).

## 로드

```bash
# 이 저장소를 clone한 뒤, 세션에 한해 로드
claude --plugin-dir ./plugin
```

CLI는 PATH에 `specmock`이 있거나(`pnpm --filter @specmock/cli build && npm link packages/cli`) 저장소 루트에서 `pnpm specmock`으로 실행돼야 한다.

## 구성

- `skills/specmock/SKILL.md` — 흐름과 사용자에게 보여줄 형식
- `skills/specmock/references/extraction.md` — 세션 내 LLM 추출 절차
- `skills/specmock/references/manual-harvest.md` — ego-browser 수동 수확

2단계에서 MCP 서버를 같은 플러그인에 추가한다.
```

- [ ] **Step 6: 검증과 커밋**

Run: `claude plugin validate plugin && pnpm vitest run packages/cli/test/plugin.test.ts`
Expected: validate 출력에 error 없음, 테스트 PASS. 직접 점검: `claude --plugin-dir ./plugin -p "specmock 스킬이 있니? 이름만 답해" --max-turns 1` 로 스킬이 로드되는지 본다(1회 구독 호출).

```bash
git add plugin packages/cli/test/plugin.test.ts
git commit -m "feat(plugin): Claude Code 플러그인과 specmock 스킬 (세션 내 추출, 수동 수확 절차)"
```

---

### Task 11: `select --interactive`

**Files:**
- Create: `packages/core/src/select/interactive.ts` (순수 함수)
- Modify: `packages/cli/src/commands/select.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/interactive.test.ts`, `packages/cli/test/cli.test.ts`(추가)

- [ ] **Step 1: 실패하는 테스트 — 선택지 생성**

```ts
import { describe, expect, it } from "vitest";
import { buildChoices, choiceLabel } from "../src/select/interactive.js";
import type { Catalog, Feature } from "../src/types.js";

const f = (id: string, group: string, extra: Partial<Feature> = {}): Feature => ({
  id, group, title: id, summary: "", method: "GET", path: `/${group}/${id}`, request: { params: {}, query: {}, headers: {}, body: null },
  responses: { "200": { schema: { type: "object" }, examples: [] } }, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], ...extra,
});
const catalog: Catalog = { system: "s", generatedAt: "t", rejected: [], features: [f("b1", "beta"), f("a2", "alpha", { provenance: "doc-extracted", confidence: 0.6, notes: ["근거 인용 없음"] }), f("a1", "alpha", { hasExample: true })] };

describe("buildChoices", () => {
  it("groups in catalog display order with separators and global numbers", () => {
    const rows = buildChoices(catalog, null);
    expect(rows.map((r) => ("separator" in r ? `-- ${r.separator}` : `${r.value}`))).toEqual(["-- alpha (2)", "a1", "a2", "-- beta (1)", "b1"]);
    const a1 = rows.find((r) => "value" in r && r.value === "a1")!;
    expect("name" in a1 && a1.name).toMatch(/^\s*1\s+a1\s+GET\s+\/alpha\/a1\s+spec\s+1\.0\s+●/);
  });
  it("pre-checks the previous selection and puts warnings in the description", () => {
    const rows = buildChoices(catalog, ["a2"]);
    const a2 = rows.find((r) => "value" in r && r.value === "a2")!;
    expect("checked" in a2 && a2.checked).toBe(true);
    expect("description" in a2 && a2.description).toContain("근거 인용 없음");
  });
  it("filters by group but keeps numbering", () => {
    const rows = buildChoices(catalog, null, { group: "beta" });
    expect(rows.map((r) => ("value" in r ? r.value : r.separator))).toEqual(["beta (1)", "b1"]);
    expect(choiceLabel(rows.find((r) => "value" in r)! as never)).toMatch(/^\s*3\s/);
  });
});
```

- [ ] **Step 2: 구현** — `packages/core/src/select/interactive.ts`

```ts
import { orderFeatures } from "../catalog/order.js";
import type { Catalog, Feature } from "../types.js";

const PROVENANCE_LABEL: Record<Feature["provenance"], string> = { openapi: "spec", "doc-extracted": "doc", inferred: "inf" };
const badge = (f: Feature) => (f.hasExample ? "●" : Object.values(f.responses).some((r) => r.schema) ? "○" : "—");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export interface ChoiceRow { value: string; name: string; checked: boolean; description?: string }
export interface SeparatorRow { separator: string }
export type InteractiveRow = ChoiceRow | SeparatorRow;

export function choiceLabel(row: ChoiceRow): string { return row.name; }

/** inquirer checkbox에 줄 행 목록. 번호·정렬은 list/select와 같다(orderFeatures). */
export function buildChoices(catalog: Catalog, previous: string[] | null, opts: { group?: string } = {}): InteractiveRow[] {
  const ordered = orderFeatures(catalog).filter((o) => !opts.group || o.feature.group === opts.group);
  const idW = Math.max(2, ...ordered.map((o) => o.feature.id.length));
  const pathW = Math.max(4, ...ordered.map((o) => o.feature.path.length));
  const prev = new Set(previous ?? []);
  const rows: InteractiveRow[] = [];
  let group: string | null = null;
  for (const { index, feature: f } of ordered) {
    if (f.group !== group) { group = f.group; rows.push({ separator: `${group} (${catalog.features.filter((x) => x.group === group).length})` }); }
    const warn = f.notes.length ? `  ⚠ ${f.notes[0]}` : "";
    rows.push({
      value: f.id,
      name: `${pad(String(index), 3)} ${pad(f.id, idW)}  ${pad(f.method, 7)} ${pad(f.path, pathW)}  ${pad(PROVENANCE_LABEL[f.provenance], 4)} ${f.confidence.toFixed(1)}  ${badge(f)}${warn}`,
      checked: prev.has(f.id),
      description: [f.title, f.summary, f.notes.length ? `주의: ${f.notes.join("; ")}` : ""].filter(Boolean).join(" — "),
    });
  }
  return rows;
}
```

- [ ] **Step 3: CLI 연결** — `packages/cli/src/commands/select.ts`

`<exprs...>`를 `[exprs...]`로 바꾸고(대화형일 때 표현식 없음) 옵션 추가:

```ts
.option("--interactive", "체크박스로 고른다 (TTY 필요)", false)
.option("--group <name>", "--interactive에서 이 그룹만 보여준다")
```

action 앞부분:

```ts
if (opts.interactive) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("--interactive는 터미널에서만 쓸 수 있습니다. 파이프나 스크립트에서는 표현식을 쓰세요.");
  if (exprs.length) fail("--interactive와 표현식은 함께 쓸 수 없습니다.");
  const { default: checkbox, Separator } = await import("@inquirer/checkbox");
  const catalog = await ws.read(system, "catalog.json", CatalogSchema);
  const prev = (await ws.exists(system, "selection.json")) ? (await ws.read(system, "selection.json", SelectionSchema)).resolved : null;
  const rows = buildChoices(catalog, prev, { group: opts.group });
  const picked = await checkbox<string>({
    message: `${system}: mock으로 만들 기능을 고르세요 (space 선택 · a 전체 · i 반전 · enter 확정)`,
    choices: rows.map((r) => ("separator" in r ? new Separator(`── ${r.separator} ──`) : r)),
    pageSize: 20, loop: false, required: true,
  });
  exprs = picked;                                  // id 목록을 표현식으로 넘긴다
}
if (exprs.length === 0) fail("선택 표현식을 주거나 --interactive를 쓰세요.");
```

이후는 기존 `select(ws, system, exprs, ...)` 경로 그대로다. `selection.json`의 `selected`에는 id 목록이 저장되므로 재현 가능하다.

- [ ] **Step 4: CLI 테스트 추가**

```ts
it("select --interactive refuses without a TTY and explains", async () => {
  await specmock("ingest", "petstore", PETSTORE);
  await specmock("analyze", "petstore");
  await expect(specmock("select", "petstore", "--interactive")).rejects.toThrow(/터미널에서만/);
});
```

수동 확인(계획 실행 기록에 적는다): `pnpm specmock select petstore --interactive` 를 터미널에서 실행해 그룹 구분선, 번호, 사전 체크를 본다.

- [ ] **Step 5: 테스트, 커밋**

Run: `pnpm build:core && pnpm test && pnpm typecheck`

```bash
git add packages/core/src/select/interactive.ts packages/core/src/index.ts packages/core/test/interactive.test.ts packages/cli/src/commands/select.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): select --interactive — 그룹별 체크박스, 이전 선택 사전 체크, --group 필터"
```

---

### Task 12: 문서 — README, 설계 문서 §12, architecture.md, 계획 실행 기록

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-11-04-specmock-design.md`, 이 계획 파일
- Modify: `examples/petstore/README.md` (링크만)

- [ ] **Step 1: README**

바꿀 곳:
- 첫 문단: "확장할 예정(Phase 1B)" → 현재 지원으로. 두 번째 문장: "웹 문서·Markdown·PDF는 Claude Code(구독)가 읽어 기능을 추출하고, 추출 결과는 근거 대조와 신뢰도로 표시된다."
- 빠른 시작 아래에 **문서 입력 빠른 시작** 4줄 추가 (`examples/docs-sample` A 경로).
- "사용 방식 → CLI" 명령 블록을 Task 7의 인터페이스로 교체. `select --interactive` 추가.
- "Claude Code 스킬 (Phase 1B, 예정)" → 실제 사용법: `claude --plugin-dir ./plugin`, 대화 예시 6줄(사용자: "이 문서로 mock 만들어줘" → Claude: 표 → 사용자: "1-3이랑 pets 그룹" → Claude: 생성·검증 요약).
- "입력 형식" 표: 웹 문서 URL / Markdown / PDF / 텍스트를 "지원"으로, LLM 열은 "필요(Claude Code 구독 또는 세션)". 비고에 "탭·select 뒤 내용은 ego-browser 설치 시 자동 수확, 아니면 누락 가능(리포트에 표시)".
- "기능 목록과 선택" 표 출력 예시 아래에 문서 추출 행 예시 하나 추가(`doc  0.8  ●  ⚠ 404 응답 스키마는 샘플에서 유추`) 와 `신뢰도` 의미 3줄(1.0 spec / 0.6~0.9 문서 명시 / ≤0.5 추측 또는 근거 불일치).
- 새 절 **"LLM은 어디에 쓰이나"**: 비구조 문서의 청크 추출에만. 어댑터 표(session / claude-code / api(3단계)). 호출 횟수 = 청크 수, 청크는 6,000자. `analyze --prepare`로 호출 전에 청크를 볼 수 있다. 추출 결과는 `extracted/`에 남아 재현 가능.
- "제한 사항" 절을 **1B 기준**으로 다시 쓴다. 남는 것: 생성 언어 TS만, 상태 없는 응답, 4xx fixture 미생성, 마스킹 불완전, `2XX` 범위 키·cookie 파라미터 미지원, 커스텀 드롭다운(listbox) 자동 수확 안 됨, PDF는 텍스트만(표 구조 손실), `select --interactive`에 그룹 접기·검색 없음, `run`은 세션 모드 미지원.
- 로드맵 표: 1B ← 현재.

- [ ] **Step 2: docs/architecture.md**

"입력별 처리 경로" 다이어그램 아래에 **LLM 추출 3단계** 시퀀스 다이어그램 추가(prepare → [session | claude-code] → merge, 파일 이름 포함). 상태 파일 표에 `analyze-request.json`, `chunks/`, `extracted/`, `catalog-diff.json` 행 추가.

- [ ] **Step 3: 설계 문서 보강**

- 상태 줄: "1B 구현 완료 (날짜)".
- §3.1 `source.json`: `title`, `harvestCandidate`, `harvested.notes` 추가. `content`가 HTML일 때 Markdown임을 명시.
- §4.3: 축소된 대화형 선택 설명으로 교체.
- §5.1 표: HTML → Markdown, PDF 페이지 헤딩.
- §5.2: `analyze-request.json` 구조와 `--merge` 부분 진행 규칙.
- §12 "구현 중 변경" 표에 1B 행 추가. 최소 항목: HTML→Markdown 보존, 수확 결과를 섹션으로 병합, 얇은 추출 스키마 + ajv 컴파일 검사, 샘플→스키마 유추 구현, 대화형 선택 축소, `--refresh` 의미 분리, catalog-diff.json, 미추출 청크 계속 진행, listbox 자동 수확 제외, 실제 실행에서 발견한 것들.

- [ ] **Step 4: 이 계획 파일에 "실행 기록" 절 추가** — 1A 계획과 같은 표 형식. Task별 달라진 점과 이유, 최종 테스트 수, `pnpm llm:check` 결과, 수동 확인(interactive, 플러그인 로드, ego-browser 수확) 결과.

- [ ] **Step 5: 링크 점검과 커밋**

Run: `grep -rn "Phase 1B" README.md docs/architecture.md | grep -i "예정"` → 없음. `pnpm test && pnpm typecheck` → PASS.

```bash
git add README.md docs examples/petstore/README.md
git commit -m "docs: 1B 반영 — 문서 입력·LLM 어댑터·스킬·대화형 선택 사용법, 제한 사항, 설계 변경 기록"
```

---

## 실행 순서와 의존 관계

```
Task 1 (타입) → Task 2 (ingest) → Task 3 (chunk) → Task 4 (prepare) → Task 5 (merge, analyze 디스패치)
       → Task 6 (어댑터, extract) → Task 7 (CLI) → Task 8 (골든, 예제, llm:check)
       → Task 9 (수확) → Task 10 (플러그인/스킬) → Task 11 (interactive) → Task 12 (문서)
```

Task 9와 10, 11은 서로 독립이지만 같은 worktree에서 순서대로 진행한다(SDD는 병렬 구현을 피한다). Task 8의 실제 LLM 호출(`llm:check`, 예제 녹음)과 Task 9의 ego-browser 테스트, Task 10의 플러그인 로드 확인은 **이 기기에서만** 되는 수동 검증이다. 구현 서브에이전트가 돌릴 수 없으면 컨트롤러가 직접 돌리고 결과를 실행 기록에 적는다.

## 완료 기준 (설계 §10 1단계)

- [x] 문서 예제 e2e: 녹음본(B 경로)으로 ingest → analyze --merge → select all → generate → verify, contract 4/4 통과. (A 경로 `--llm claude-code` 라이브는 `llm:check` OK 4136ms로 어댑터만 확인)
- [x] 로컬 HTML(탭·select)에서 ego-browser 수확이 숨은 내용을 가져옴(ego-browser 수확 테스트 통과, 실측 상호작용 2).
- [ ] `claude --plugin-dir ./plugin` 세션에서 스킬 로드 → `extracted/` 작성 → `--merge`까지(수동 1회). **사용자 수동 확인 필요.** (`claude plugin validate`와 plugin.test는 통과)
- [ ] `select --interactive` TTY 동작(수동 1회). **사용자 수동 확인 필요.** (병합 로직은 단위 테스트 통과)
- [x] 골든 5종, 전체 테스트(34 files / 244 tests), typecheck 통과. README 명령은 `--help` 옵션과 일치(plugin.test drift 검사).

## 후속 (이 계획 밖, 2단계 전에 정리할 것)

- `2XX`/`4XX` 범위 응답 키, `in: cookie`, 응답 content-type 보존 (1A 이월).
- 커스텀 드롭다운(`role=listbox/combobox`) 자동 수확.
- PDF 표 구조 보존(`pdf-parse`의 `getTable()` 검토).
- 어댑터 동시 호출(현재 순차). 청크 50개 이상 문서에서 체감.
- `run`의 세션 모드(prepare에서 멈추고 재개하는 2단계 run).
- `core/index.ts` 공개 API 정리(2단계 MCP가 쓰는 것만 남기기).

---

## 실행 기록 (2026-11-05)

12개 Task를 Task마다 구현 서브에이전트(Sonnet)가 만들고, 스펙 준수 → 코드 품질 2단계 리뷰(Opus)를 거쳐 진행했다. 리뷰 지적은 같은 Task의 후속 커밋으로 반영했다. 계획 본문과 실제 코드가 다른 지점은 다음과 같다.

| Task | 계획과 달라진 점 | 이유 |
|---|---|---|
| 1 | turndown 예외 설정(`minimumReleaseAgeExclude`)을 넣었다가 `^7.2.4`로 올려 제거. zod 4.6.7은 `reused: "inline"` 없이도 `$ref` 없음. nullable 필드 후처리 불필요 | 실제 `claude` 2.1.318 + sonnet probe에서 structured_output이 정상. merge는 항목 단위 파싱 |
| 2 | 1A의 "non-openapi 거부" 테스트를 "문서로 수용"으로 변경. Readability `keepClasses`, bare `<pre>` 펜스, H1 보존, charset 디코딩, 내용 sniff는 마지막 | 코드 펜스 언어와 제목 보존, 한글 문서 인코딩 |
| 3 | CommonMark 펜스 매칭, 공백 구간 1글자 전진 버그 수정, `HEADING_RE` 보정(`# C#`), 속성 테스트 | 청크 분할이 펜스를 잘못 끊거나 무한히 진행 못 하는 경로 |
| 4 | heading 폴백은 `input.title \|\| origin`(그룹명으로 쓰지 않음), 프롬프트 규칙 2·4·5·6 명확화, 청크 계산 후 wipe | 모델이 base URL과 요청 스키마/예시를 섞어 쓰던 문제 |
| 5 | 근거 불일치 노트를 "못 찾은 건수"로, `util/ajv.ts` 공용화(merge마다 새 ajv·루트 `$id`/`$schema` 제거), `inferSchema` 깊이 32·저장 값 64 캡, 프로토타입 키 안전 | ajv 인스턴스 오염과 거대 샘플, `__proto__` 키 |
| 6 | claude-code 어댑터 `--no-session-persistence --tools ""`, `.tmp`→rename 원자적 쓰기, `ChunkInfo.contentHash` + `extracted/manifest.json` | 중단 시 반쪽 파일과 낡은 추출 재사용 방지 |
| 7 | `llmFlow.ts`의 `runLlmAnalyze`를 analyze/run이 공유, `run`은 세션 모드 거부·전부 실패 시 exit 1, `SelectionSchema.catalogIds`로 선택 diff 경고 | 두 명령의 추출 흐름 중복 제거, 설계 §4.4 diff |
| 8 | `claude` 자식 프로세스를 임시 cwd에서 실행(d2258fc), 골든 5종·예제·`llm:check`, `analyze --prepare`가 `extracted/` 생성(README의 `mkdir` 제거), `tsconfig.scripts.json` | 저장소 파일 접근 차단, 예제 B 경로 단순화 |
| 9 | 수확 스크립트를 문자열 `evaluate`로, 시작 페이지 제외, select는 새로 보인 블록만·탭은 숨은 패널만, `data-specmock-i`, bare `/api/` 링크 제외, `page.url()` 기준, **수확 결과 마스킹 누락(리뷰 Critical) 수정** | `page.evaluate`가 `document`를 못 넘김. 로그인 쿠키로 앱 API를 방문하는 사고 방지 |
| 10 | 플러그인·스킬·참고문서, `plugin.test`에 종료 코드·옵션 drift 검사, `claude plugin validate` 통과, 근거 없는 merge 종료 코드 서술 제거 | 스킬 문서가 CLI와 어긋나지 않게 |
| 11 | `select --interactive`(그룹 구분선·사전 체크·`--group`), 병합을 core `mergeInteractivePick`으로 분리·테스트(리뷰 Major 수정), `literalIds`, Task 10 잔여(세션 모드 `--refresh`가 `extracted/` 삭제, 실패 로그 마스킹) | `--group` 보존 로직과 로그 마스킹이 무테스트였음. 저장은 id 목록으로 평탄화(의도) |
| 12 | README(문서 입력 빠른 시작, LLM/수확 고지, 종료 코드 표, 스킬 사용법, 1B 제한 사항), architecture(LLM 3단계 시퀀스, 상태 파일), 설계 §3.1·3.3·4.3·5.1·5.2·5.6·12, 이 기록 | `examples/petstore/README.md` 링크 변경은 불필요해 생략 |
| 최종 | 33 test files / 243 tests, `pnpm typecheck` 통과. 라이브: `pnpm llm:check` OK 4136ms(sonnet), 예제 녹음 기능 4개(청크 1, 신뢰도 1.0/1.0/0.8/0.8), ego-browser 실측 수확 페이지 1·상호작용 2(Node 탭, select=404, 약 2.3s) | 수동 확인 필요 항목 2개 미실시: 플러그인 세션 실행, `select --interactive` TTY 실행(완료 기준 `[ ]`). 최종 리뷰 반영: README 실제 출력·신뢰도 설명 정정, HTML 제목·origin 마스킹(+1 test) |

### 후속 과제

- 전부 추출 실패 시 빈 `catalog.json`으로 덮어쓰지 않기(쓰기 생략 검토).
- 로그아웃·레이트리밋 시 청크마다 같은 실패를 반복하므로 조기 중단.
- 어댑터 격리 강화(`--strict-mcp-config`, `--setting-sources`는 OAuth 영향 검증 후), 타임아웃 시 손자 프로세스 정리, 동시 호출(현재 순차, 청크 50개 이상에서 체감).
- `--json` 실패 시 JSON 오류 봉투 없음(MCP 단계 전에 결정).
- select diff에 `changed`(내용 변경) 감지 추가. interactive가 저장한 id가 `all`·숫자일 때 `--add`/`@file`에서 표현식으로 재해석되는 문제(드묾).
- `select --interactive`: 그룹 접기·검색, TTY 수동 확인.
- 커스텀 드롭다운(listbox/combobox) 자동 수확, PDF 표 구조 보존(`getTable()` 검토).
- `run`의 세션 모드(prepare에서 멈추고 재개하는 2단계 run).
- 정적 토글 사이트에서 수확 내용이 본문과 중복될 수 있음(prepare에서 중복 섹션 생략), `show more` 감지가 script/nav를 포함하는 오탐.
- 로컬 파일 캐시 키 정규화·mtime 검사, PDF title(메타데이터), `application/xhtml+xml` 등 content-type.
- `hasExample` 기준 통일(openapi.ts vs merge 2xx), OpenAPI feature 추출 3회 중복 헬퍼화, `core/index.ts` 공개 API 정리(2단계 MCP가 쓰는 것만).
- 플러그인 marketplace 배포 안내.
