# Flow Simulator Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the selected OpenAPI features of one service (GitHub first), infer per-resource call flows, let the user or Claude Code fill the bindings the rules could not find, and run each flow against the generated TS mock and the real test server with value passing, a server-side safety switch, own-resource-only DELETE and reverse-order teardown. Show it all in a two-screen web UI.

**Architecture:** New `packages/core/src/flow/` module: `infer.ts` (pure, features → flows), `store.ts` (`flows.json`, `flow-runs/<flowId>/<target>.json` in the workspace), `run.ts` (one flow on one target, built on `runContract`). A service wrapper `core/src/service/flow.ts` adds workspace I/O and mock start-up. ui-server exposes flow routes, runs flows as a `flow` job, and keeps the safety switch in memory. MCP gets `list_flows` and `fill_flow`. The web app drops the six step screens and keeps a register screen plus a flow screen.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), zod v4 (`z.json()`), Hono (ui-server), `@modelcontextprotocol/server` v2, React 19 + Vite, vitest (+ `@testing-library/react`), Playwright e2e, pnpm workspace.

Conventions used below:
- All commands run from the repo root `/Users/geonho.yeom/workspace/specmock` unless noted.
- Single test file: `pnpm exec vitest run <path>`. ui-server and MCP tests import `@specmock/core` dist, so run `pnpm build:core` first (MCP tests also need `pnpm build:mcp`).
- Full gate per task: `pnpm typecheck && pnpm test`. Expected: all suites pass, 0 failures.
- Korean strings are user-facing (UI, errors, notes). Code identifiers and commit messages are English.
- Commits end with the `Co-Authored-By` trailer the session prescribes; one task = one issue = one PR (`feat/<issue#>-<slug>`).

---

## File structure

| File | Task | New/Mod | Responsibility |
|---|---|---|---|
| `packages/core/src/ingest/mask.ts` | 2 | Mod | add `ghp_` / `github_pat_` patterns |
| `packages/core/src/types.ts` | 2 | Mod | `request.bodyRequired?`, `responses[s].headers?` on `FeatureSchema`/`ResponseSchema` |
| `packages/core/src/analyze/openapi.ts` | 2 | Mod | keep `requestBody.required` and response headers |
| `packages/core/src/select/requiredBody.ts` | 2 | New | `requiredBodyFields(feature)`: required top-level body fields + spec example |
| `packages/core/test/golden/petstore/expected-catalog.json` | 2 | Mod | regenerated golden (`bodyRequired`) |
| `packages/core/test/requiredBody.test.ts` | 2 | New | tests for `requiredBodyFields` |
| `packages/core/test/largeSpec.test.ts` | 2 | New | selected-only processing guard on a synthetic 400-operation spec |
| `packages/core/src/flow/types.ts` | 3 | New | zod schemas: `FlowSource`, `FlowInput` (with `createdBy?`), `FlowStep`, `Flow`, `FlowsFile`; (task 4) `StepState`, `StepResult`, `Leftover`, `FlowRun` |
| `packages/core/src/flow/infer.ts` | 3 | New | six inference rules; `inferFlows`, `mergeFlows`, `parseResourcePath`, `singular`, `linkField`, `responseProperties` (reads through `allOf`) |
| `packages/core/src/flow/store.ts` | 3 | New | read/write `flows.json` and `flow-runs/`; `setInput` (links a created parent once for every step), `emptySlots` (params never cover a created parent), `missingFeatures` |
| `packages/core/src/flow/index.ts` | 3 | New | barrel for `flow/*` |
| `packages/core/src/service/flow.ts` | 3,4 | New | `inferFlowsForSystem` (3), `runFlowTargets` (4) |
| `packages/core/src/service/index.ts` | 3,4 | Mod | export flow services |
| `packages/core/src/service/events.ts` | 3 | Mod | `ServiceStage` gains `"flow"` |
| `packages/core/src/index.ts` | 3,4 | Mod | export flow API |
| `packages/core/test/fixtures/flow/github-issues.yaml` | 3 | New | trimmed GitHub-like spec (repos + issues) |
| `packages/core/test/flowInfer.test.ts` | 3 | New | rule tests + fixed GitHub-like inference |
| `packages/core/test/flowStore.test.ts` | 3 | New | store/setInput/emptySlots tests |
| `packages/core/src/verify/contracts.ts` | 4 | Mod | `ContractRunOptions.body` override (lines 7-21, 76-79) |
| `packages/core/src/record/index.ts` | 4 | Mod | export `maskBody`, `maskValues`, `recordedHeaders` (lines 47-82) |
| `packages/core/src/flow/run.ts` | 4 | New | `runFlow(flow, spec, target, opts)`; teardown does not list a child whose parent was deleted in the same run |
| `packages/core/test/contract-run.test.ts` | 4 | Mod | body override test |
| `packages/core/test/flowRun.test.ts` | 4 | New | runner tests on `startFakeTarget` |
| `packages/core/test/flowService.test.ts` | 4 | New | `runFlowTargets` with injected mock launcher |
| `packages/ui-server/src/safety.ts` | 5 | New | `SafetyStore` (in memory, one service slot) |
| `packages/ui-server/src/flows.ts` | 5 | New | `flowSummaries`, `flowDetail`, `suggestedBaseUrl` |
| `packages/ui-server/src/app.ts` | 5 | Mod | flow + safety routes, `GET /feature-groups` (group summaries), `suggestedBaseUrl` in target info |
| `packages/ui-server/src/security.ts` | 5 | Mod | POST_ONLY regex gains `flows/infer`, `flows/[^/]+/(?:run|inputs)` (line 20) |
| `packages/ui-server/src/api-types.ts` | 5 | Mod | `JobKind` + `"flow"`; `FlowSummary`, `FlowDetail`, `SafetyState`, `FeatureGroups`; `TargetInfo.suggestedBaseUrl` |
| `packages/ui-server/src/jobs.ts` | 5 | Mod | `CANCELLABLE.flow = true` (line 20) |
| `packages/ui-server/test/flows.test.ts` | 5 | New | route tests |
| `packages/mcp/src/tools/flow.ts` | 5 | New | `list_flows`, `fill_flow` |
| `packages/mcp/src/names.ts` | 5 | Mod | 15 tool names |
| `packages/mcp/src/createServer.ts` | 5 | Mod | `registerFlowTools` |
| `packages/mcp/test/tools.test.ts` | 5 | Mod | count 13 → 15 (lines 23-26, 209, 215) + flow tool tests |
| `packages/mcp/test/plugin.test.ts` | 5 | Mod | suffix regex gains `flows?` (line 24) |
| `plugin/skills/specmock/SKILL.md` | 5 | Mod | document `list_flows`, `fill_flow` |
| `packages/web/src/route.ts` | 6 | Mod | screens `home`/`new`/`flows` |
| `packages/web/src/App.tsx` | 6 | Mod | two screens, no StepBar |
| `packages/web/src/api.ts` | 6 | Mod | flow/safety/target calls, `featureGroups` |
| `packages/web/src/flowModel.ts` | 6 | New | `STATE_LABEL`, `stepBadge`, `flowDiff`, `edgeLabel` |
| `packages/web/src/screens/Register.tsx` | 6 | Mod | name + spec URL + token, target, feature picking (group summaries first, a group's rows on demand), infer |
| `packages/web/src/screens/Flows.tsx` | 6 | New | flow screen layout |
| `packages/web/src/components/FlowList.tsx` | 6 | New | left list (empty count, last state) |
| `packages/web/src/components/FlowTopBar.tsx` | 6 | New | target / cleanup / run / safety toggle |
| `packages/web/src/components/FlowChart.tsx` | 6 | New | vertical steps + edge values |
| `packages/web/src/components/StepCard.tsx` | 6 | New | expandable step: request, mock vs real, input editor |
| `packages/web/src/components/InputEditor.tsx` | 6 | New | fill one slot (value or previous step field) + basis badge |
| `packages/web/src/components/Leftovers.tsx` | 6 | New | leftover list |
| `packages/web/src/styles/app.css` | 6 | Mod | state classes `.st-*`, `.topbar.unsafe` (after mockup approval) |
| `packages/web/src/screens/{Analyze,Select,Generate,Verify,Record}.tsx`, `components/StepBar.tsx` | 6 | Delete | six-step UI |
| `packages/web/test/{Analyze,Select,Generate,Verify,Record}.test.tsx` | 6 | Delete | tests of removed screens |
| `packages/web/test/{flowModel.test.ts,Flows.test.tsx}` | 6 | New | state display, input filling, diff |
| `packages/web/test/{Register.test.tsx,App.test.tsx,route.test.ts}` | 6 | Mod | new screens |
| `e2e/ui.spec.ts` | 6 | Mod | register → flows → mock run |

Unchanged on purpose: `generate/*`, `templates/*`, `select/fixtures.ts`, `select/contracts.ts`, `bodyRequired.ts` (`isBodyRequired` stays the TS-mock heuristic), CLI.

---

### Task 2: core fixes (required-only body, Feature keeps body.required and response headers, GitHub token masking, selected-only processing guard)

**Files:**
- Modify: `packages/core/src/ingest/mask.ts:6-11`
- Modify: `packages/core/src/types.ts:14-17` (ResponseSchema), `:31-36` (request)
- Modify: `packages/core/src/analyze/openapi.ts:74-124` (`buildRequest`, `buildResponses`)
- Create: `packages/core/src/select/requiredBody.ts`
- Modify: `packages/core/src/index.ts` (export `requiredBodyFields`)
- Modify: `packages/core/test/golden/petstore/expected-catalog.json` (regenerated)
- Test: `packages/core/test/mask.test.ts`, `packages/core/test/analyze.test.ts`, `packages/core/test/requiredBody.test.ts`, `packages/core/test/largeSpec.test.ts`

- [ ] **Step 1: failing mask test.** Append to `packages/core/test/mask.test.ts` inside `describe("maskSecrets")`:

```ts
  it("masks GitHub classic and fine-grained tokens", () => {
    const classic = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const fine = "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    expect(maskSecrets(`token ${classic} end`)).toBe("token ghp_*** end");
    expect(maskSecrets(`{"t":"${fine}"}`)).toBe(`{"t":"github_pat_***"}`);
    expect(maskSecrets("ghp_short")).toBe("ghp_short");
  });
```

- [ ] **Step 2: run, see it fail.** `pnpm exec vitest run packages/core/test/mask.test.ts` → 1 failed (`expected 'token ghp_A1b2… end'`).

- [ ] **Step 3: implement.** In `packages/core/src/ingest/mask.ts` add two entries to `PATTERNS` (after the `sk_` line) and extend the doc comment ("GitHub `ghp_`·`github_pat_` 토큰"):

```ts
  [/\bghp_[A-Za-z0-9]{20,}/g, "ghp_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
```

- [ ] **Step 4: run, pass.** Same command → all pass.

- [ ] **Step 5: commit.** `git commit -am "fix(core): mask GitHub ghp_ and github_pat_ tokens"`

- [ ] **Step 6: failing analyze test for `bodyRequired` and response headers.** Append to `packages/core/test/analyze.test.ts`:

```ts
describe("analyzeOpenApiDocument keeps requestBody.required and response headers", () => {
  const doc = {
    openapi: "3.0.3", info: { title: "t", version: "1" },
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } },
          responses: { "201": { description: "ok", headers: { Location: { required: true, schema: { type: "string" } } }, content: { "application/json": { schema: { type: "object" } } } } },
        },
        get: { operationId: "listItems", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array" } } } } } },
      },
    },
  } as const;

  it("sets bodyRequired from requestBody.required and keeps headers", () => {
    const [create, list] = analyzeOpenApiDocument(doc as never);
    expect(create!.request.bodyRequired).toBe(true);
    expect(create!.responses["201"]!.headers).toEqual({ Location: { schema: { type: "string" }, required: true } });
    expect(list!.request.bodyRequired).toBeUndefined();
    expect(list!.responses["200"]!.headers).toBeUndefined();
  });

  it("v2 in:body param required → bodyRequired", () => {
    const v2 = { swagger: "2.0", info: { title: "t", version: "1" }, paths: { "/x": { post: { operationId: "px", parameters: [{ in: "body", name: "b", required: true, schema: { type: "object" } }], responses: { "200": { description: "ok", headers: { "X-Rate": { type: "integer" } } } } } } } };
    const [f] = analyzeOpenApiDocument(v2 as never);
    expect(f!.request.bodyRequired).toBe(true);
    expect(f!.responses["200"]!.headers).toEqual({ "X-Rate": { schema: { type: "integer" }, required: false } });
  });
});
```

- [ ] **Step 7: run, see it fail.** `pnpm exec vitest run packages/core/test/analyze.test.ts` → 2 failed (TS: property `bodyRequired` does not exist is a vitest runtime `undefined` mismatch; the `toBe(true)` assertion fails).

- [ ] **Step 8: implement types.** In `packages/core/src/types.ts`:

```ts
export const ParamSchema = z.object({          // move above ResponseSchema (it is used there)
  schema: JsonSchema.nullable(),
  required: z.boolean(),
});

export const ResponseSchema = z.object({
  schema: JsonSchema.nullable(),
  examples: z.array(ExampleSchema),
  /** OpenAPI 응답 헤더. 선언이 없으면 키를 두지 않는다(옛 catalog·문서 추출과 같은 모양). */
  headers: z.record(z.string(), ParamSchema).optional(),
});
```

and in `FeatureSchema.request` add after `body`:

```ts
    /** OpenAPI `requestBody.required`(v2는 `in: body`의 required). 선언이 있을 때만 둔다. TS mock은 계속 `isBodyRequired`를 쓴다. */
    bodyRequired: z.boolean().optional(),
```

- [ ] **Step 9: implement analyze.** In `packages/core/src/analyze/openapi.ts`:
  - `buildRequest` v2 branch (line 87): `else if (p.in === "body") { request.body = stripSchema((p as OpenAPIV2.InBodyParameterObject).schema); if (p.required !== undefined) request.bodyRequired = Boolean(p.required); }`
  - V3 block (lines 97-101):

```ts
  if (isV3(doc)) {
    const body = (op as OpenAPIV3.OperationObject).requestBody as OpenAPIV3.RequestBodyObject | undefined;
    const media = jsonContent(body?.content);
    if (media?.schema) request.body = stripSchema(media.schema);
    if (body && body.required !== undefined) request.bodyRequired = body.required;
  }
```

  - Add helper and use it in `buildResponses`:

```ts
function responseHeaders(doc: AnyDoc, raw: unknown): Feature["responses"][string]["headers"] {
  const hs = (raw as { headers?: Record<string, Record<string, unknown>> }).headers;
  if (!hs || Object.keys(hs).length === 0) return undefined;
  return Object.fromEntries(Object.entries(hs).map(([name, h]) => [name, isV3(doc)
    ? { schema: stripSchema(h.schema as never), required: h.required === true }
    : { schema: v2ParamSchema(h as never), required: false }]));
}
```

    V3: `out[status] = { schema, examples: collectExamples(media, schema), ...(headers ? { headers } : {}) }` with `const headers = responseHeaders(doc, res);`; v2 the same with `{ schema, examples, ...(headers ? { headers } : {}) }`.

- [ ] **Step 10: run, pass; then see the golden fail.** `pnpm exec vitest run packages/core/test/analyze.test.ts` → pass. `pnpm build:core && pnpm exec vitest run packages/core/test/golden.test.ts` → petstore catalog differs (`createPet.request.bodyRequired: true`).

- [ ] **Step 11: regenerate golden.** `pnpm build:core && node --import tsx packages/core/test/golden-update.mjs` (all cases; script usage at `test/golden-update.mjs:2`). `git diff packages/core/test/golden` must show only added `"bodyRequired": …` / `"headers": …` lines in OpenAPI cases (`petstore`, `circular`, `with-auth`); `pets-md`/`pets-html` (doc-extracted) unchanged. Any other diff line is a regression. Then `pnpm exec vitest run packages/core/test/golden.test.ts packages/core/test/snapshot.test.ts` → pass (TS templates do not embed Feature objects, so the snapshot hash is unchanged).

- [ ] **Step 12: commit.** `git commit -am "feat(core): keep requestBody.required and response headers in Feature"`

- [ ] **Step 13: failing test for `requiredBodyFields`.** Create `packages/core/test/requiredBody.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requiredBodyFields } from "../src/select/requiredBody.js";
import type { Feature } from "../src/types.js";

const feature = (body: Feature["request"]["body"]): Feature => ({
  id: "f", group: "g", title: "", summary: "", method: "POST", path: "/x",
  request: { params: {}, query: {}, headers: {}, body }, responses: {},
  auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
});

describe("requiredBodyFields", () => {
  it("lists required top-level fields with spec examples only", () => {
    const f = feature({ type: "object", required: ["title", "labels"], properties: { title: { type: "string", example: "Found a bug" }, labels: { type: "array" }, body: { type: "string", example: "x" } } });
    expect(requiredBodyFields(f)).toEqual([{ name: "title", example: "Found a bug" }, { name: "labels" }]);
  });
  it("uses `examples[0]` when `example` is absent and ignores generated values", () => {
    const f = feature({ type: "object", required: ["name"], properties: { name: { type: "string", examples: ["Hello-World"] } } });
    expect(requiredBodyFields(f)).toEqual([{ name: "name", example: "Hello-World" }]);
  });
  it("no body, no required, or non-object body → []", () => {
    expect(requiredBodyFields(feature(null))).toEqual([]);
    expect(requiredBodyFields(feature({ type: "object", properties: { a: { type: "string" } } }))).toEqual([]);
    expect(requiredBodyFields(feature({ type: "array", items: {} }))).toEqual([]);
  });
});
```

- [ ] **Step 14: run, see it fail.** `pnpm exec vitest run packages/core/test/requiredBody.test.ts` → fails: cannot find module `../src/select/requiredBody.js`.

- [ ] **Step 15: implement.** Create `packages/core/src/select/requiredBody.ts`:

```ts
import type { Feature } from "../types.js";

export interface RequiredBodyField { name: string; example?: unknown }

/**
 * 요청 본문의 필수 최상위 필드(설계 §2 규칙 6). 값은 스펙의 `example`·`examples[0]`만 쓰고, 없으면 비운다.
 * 생성기(faker)는 쓰지 않는다 — 계약 fixture(`select/fixtures.ts`)는 그대로 둔다.
 */
export function requiredBodyFields(feature: Feature): RequiredBodyField[] {
  const body = feature.request.body;
  if (!body || body.type !== "object" || !Array.isArray(body.required)) return [];
  const props = (body.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return (body.required as unknown[]).filter((n): n is string => typeof n === "string").map((name) => {
    const p = props[name];
    const ex = p?.example !== undefined ? p.example : Array.isArray(p?.examples) && p.examples.length > 0 ? p.examples[0] : undefined;
    return ex === undefined ? { name } : { name, example: ex };
  });
}
```

  Export from `packages/core/src/index.ts`: `export { requiredBodyFields, type RequiredBodyField } from "./select/requiredBody.js";`

- [ ] **Step 16: run, pass.** Same command → 3 passed.

- [ ] **Step 17: commit.** `git commit -am "feat(core): add requiredBodyFields for required-only request bodies"`

- [ ] **Step 18: large spec, selected-only guard test.** This step pins the phase-1 policy "only the selected features are processed after selection": `generate`, `verify`, `record` and (tasks 3-4) flows read `mockspec.json` only, which `select` builds from `selection.resolved` (`select/index.ts:36,81-94`). Create `packages/core/test/largeSpec.test.ts`:

```ts
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string;
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** 400개 operation이 큰 공유 스키마 하나를 $ref로 쓴다(공유 $ref가 파일마다 펼쳐지는 경우). */
function bigSpec(n: number) {
  const props = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { type: "string", description: "x".repeat(40) }]));
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) paths[`/r${i}/{id}`] = { get: { operationId: `get${i}`, tags: [`t${i % 20}`], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Big" } } } } } } };
  return { openapi: "3.0.3", info: { title: "big", version: "1" }, paths, components: { schemas: { Big: { type: "object", properties: props } } } };
}

it("select writes only the selected features of a large spec to mockspec.json", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-big-"));
  const spec = path.join(dir, "big.json");
  await writeFile(spec, JSON.stringify(bigSpec(400)));
  const ws = new Workspace(path.join(dir, ".specmock"));
  await ingest(ws, "big", [spec]);
  await analyze(ws, "big");
  await select(ws, "big", ["get1", "get2"], { literalIds: true });
  const mock = await ws.read("big", "mockspec.json", MockSpecSchema);
  expect(mock.features.map((f) => f.id).sort()).toEqual(["get1", "get2"]);
  expect(mock.contracts.every((c) => c.featureId === "get1" || c.featureId === "get2")).toBe(true);
  const catalogBytes = (await stat(ws.file("big", "catalog.json"))).size;
  const mockBytes = (await stat(ws.file("big", "mockspec.json"))).size;
  expect(mockBytes * 50).toBeLessThan(catalogBytes);
}, 60_000);
```

  (Check `ingest`/`analyze` signatures against `test/analyze.test.ts` imports; both are already used there with `(ws, system, origins)` / `(ws, system)`.)

- [ ] **Step 19: run, expect pass.** `pnpm exec vitest run packages/core/test/largeSpec.test.ts` → 1 passed. This is a regression guard on existing behaviour, so it passes without code change; if it fails, `select` leaks unselected features, which is a bug to fix in this task before moving on.

- [ ] **Step 20: full gate and commit.** `pnpm typecheck && pnpm test` → all pass (Stripe workspace is doc-extracted: no `bodyRequired`/`headers` keys appear; TS/Java generator tests unchanged). `git add packages/core/test/largeSpec.test.ts && git commit -m "test(core): pin selected-only processing for large specs"`

#### Measurement result (task 1, issue #29, commit 7b7c3de)

Measured on the real GitHub spec (OpenAPI 3.0.3, 14,283,088 B, 842 paths, 1,281 operations; M4 Pro 48GB, Node v26.10.0, default heap, no failure, no workaround): ingest 4.09 s, peak RSS 1.88 GB, `source.json` 56,778,732 B; analyze 1.11 s, 1.12 GB, `catalog.json` 37,316,645 B, 1,281 features, 46 groups (repos 204, actions 200, orgs 116, issues 66); select 6 ops 0.92 s, `mockspec.json` 2,266,577 B; select all 1.72 s, 1.60 GB, 87,220,959 B. The four questions the first draft left open are closed:

1. **Processing limit: none in phase 1.** The eager pipeline handles the largest target spec without failure, so there is no limit check and no size error copy. See "Not in this plan".
2. **Catalog stays eager.** `CatalogSchema` and `catalogHash` do not change. What 1,281 features cost is a UI problem (rendering and shipping all rows), handled in Task 5 (group summary route) and Task 6 (Register loads a group's rows on demand).
3. **`source.json` keeps the dereferenced document** (`ingest/index.ts:99`), unchanged.
4. **No `links`, no `security`/`securitySchemes`** (catalog `auth` is `none` for all features). No `links` rule; auth comes only from `target.json` headers. `requestBody.required` is present on 366 of 370 bodies, so steps 6-12 above (keep `body.required`) matter for GitHub. `issues_update` 200 is an `allOf` with empty top-level `properties`, which Task 3 handles (`responseProperties`).

---

### Task 3: `flow/infer` and `flow/store`

**Files:**
- Create: `packages/core/src/flow/types.ts`, `packages/core/src/flow/infer.ts`, `packages/core/src/flow/store.ts`, `packages/core/src/flow/index.ts`, `packages/core/src/service/flow.ts`
- Create: `packages/core/test/fixtures/flow/github-issues.yaml`
- Modify: `packages/core/src/service/events.ts:1` (`ServiceStage` + `"flow"`), `packages/core/src/service/index.ts` (export), `packages/core/src/index.ts` (export)
- Test: `packages/core/test/flowInfer.test.ts`, `packages/core/test/flowStore.test.ts`

Rule mapping used by `infer.ts` (spec §2; deviations listed under "Conflicts with spec" C2):
- **R1 resource:** `parseResourcePath(path)` strips trailing `{params}`; the last static segment `S` is the resource. No trailing params = list path; one or more = item path. Paths are grouped by the normalized prefix up to `S` (params → `{}`). An item-only group joins a list group with a POST when exactly one such group has the same `S` and no item path of its own (GitHub: `/user/repos` + `/repos/{owner}/{repo}`).
- **R2 order:** group P is the parent of R when R's prefix starts with P's normalized item path + `/`. The nearest such P wins. Flows are emitted parents first.
- **R3 skeleton:** one flow per group that has a selected POST on its list path. Steps: ancestors' creates (role `prep`, outermost first) → `create_<s>` → `get_<s>` → `update_<s>` (PATCH, then PUT; a second gets `_2`) → `delete_<s>` (role `cleanup`) → ancestors' deletes (role `cleanup`, innermost first). Only selected features appear. `<s>` = `singular(S)`.
- **R4 link:** in a run of path params after static segment `S`, the last param belongs to resource `S`; earlier params in the same run are scope params with no owner (`/repos/{owner}/{repo}`: `repo` → repo, `owner` → none). An owned param's value comes from the step in this flow whose `creates` is `singular(S)`, and the input records that step as `createdBy`. `linkField(param, singular(S), createFeature)` normalizes (lowercase, drop `_`/`-`), strips the singular prefix (`issue_number` → `number`), maps `id`/`<s>_id` → `id`, and compares against the top-level scalar properties of the create step's lowest 2xx response schema, read through `allOf` (`responseProperties` merges the `properties` of the schema and of every `allOf` member, recursively; measured: GitHub `issues_update` 200 is an `allOf` with empty top-level `properties`). There is no `links` rule: the measured GitHub spec declares none.
- **R5 empty:** zero or ≥ 2 candidates, a param equal to the singular name (`repo`), or no creating step in the flow → `{ kind: "empty" }`. An empty input with `createdBy` names a parent created in this flow (C6): `target.params` never covers it, it counts in `emptySlots` and shows "입력 필요" until someone links it once (`repo <- create_repo.name`). An empty input without `createdBy` (`owner`) is covered by `target.params` when the name is there.
- **R6 body:** one input per `requiredBodyFields(feature)` entry (task 2). With a spec example → `{ kind: "fixed", value }`; otherwise `empty`.

- [ ] **Step 1: write flow types (no test yet; compiled by step 3 tests).** Create `packages/core/src/flow/types.ts`:

```ts
import { z } from "zod";

/** 흐름·단계 id. 파일 경로(`flow-runs/<flowId>/`)에 쓰므로 문자·숫자·`-`·`_`만. */
export const FLOW_ID = /^[A-Za-z0-9_-]+$/;
/** 입력 자리: `path.<경로 변수>` 또는 `body.<최상위 필드>`. */
export const FLOW_SLOT = /^(path|body)\.[^.\s]+$/;

export const FlowRole = z.enum(["prep", "main", "cleanup"]);
export type FlowRole = z.infer<typeof FlowRole>;
/** 근거: 규칙이 채움 | Claude Code(MCP)가 채움 | 사용자가 화면에서 채움. */
export const FlowBasis = z.enum(["rule", "claude", "user"]);
export type FlowBasis = z.infer<typeof FlowBasis>;

/** 출처: 앞 단계 응답 | 사용자 값 | 고정 값(스펙 예시) | 비어 있음. `field`는 응답 본문의 점 경로(`owner.login`). */
export const FlowSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), step: z.string().regex(FLOW_ID), field: z.string().min(1) }),
  z.object({ kind: z.literal("user"), value: z.json() }),
  z.object({ kind: z.literal("fixed"), value: z.json() }),
  z.object({ kind: z.literal("empty") }),
]);
export type FlowSource = z.infer<typeof FlowSourceSchema>;

export const FlowInputSchema = z.object({
  slot: z.string().regex(FLOW_SLOT),
  source: FlowSourceSchema,
  basis: FlowBasis,
  /** 경로 변수가 가리키는 자원을 이 흐름에서 만드는 단계 id. 있으면 target.params가 채우지 않는다(C6). */
  createdBy: z.string().regex(FLOW_ID).optional(),
});
export type FlowInput = z.infer<typeof FlowInputSchema>;

export const FlowStepSchema = z.object({
  id: z.string().regex(FLOW_ID),
  featureId: z.string().min(1),
  role: FlowRole,
  inputs: z.array(FlowInputSchema),
  /** 이 단계가 만드는 자원(단수형, 예: "issue"). 정리와 DELETE 범위 제한이 쓴다. */
  creates: z.string().min(1).optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowSchema = z.object({
  id: z.string().regex(FLOW_ID),
  name: z.string().min(1),
  resource: z.string().min(1),
  steps: z.array(FlowStepSchema).min(1),
});
export type Flow = z.infer<typeof FlowSchema>;

/** `.specmock/<system>/flows.json`. */
export const FlowsFileSchema = z.object({
  system: z.string().min(1),
  /** 추론 시점의 selection.catalogHash. */
  catalogHash: z.string(),
  inferredAt: z.string(),
  flows: z.array(FlowSchema),
  /** 사람이 읽는 추론 메모(흐름을 못 만든 이유, 삭제 API 없음 등). */
  notes: z.array(z.string()),
});
export type FlowsFile = z.infer<typeof FlowsFileSchema>;
```

- [ ] **Step 2: GitHub-like fixture.** Create `packages/core/test/fixtures/flow/github-issues.yaml` (trimmed by hand from the GitHub REST description's repos/issues operations; small on purpose):

```yaml
openapi: 3.0.3
info: { title: github-trimmed, version: "1" }
servers: [{ url: https://api.github.com }]
paths:
  /user/repos:
    post:
      operationId: repos/create-for-authenticated-user
      tags: [repos]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, required: [name], properties: { name: { type: string }, private: { type: boolean } } } } }
      responses: { "201": { description: created, content: { application/json: { schema: { $ref: "#/components/schemas/repository" } } } } }
  /repos/{owner}/{repo}:
    parameters:
      - { name: owner, in: path, required: true, schema: { type: string } }
      - { name: repo, in: path, required: true, schema: { type: string } }
    get:
      operationId: repos/get
      tags: [repos]
      responses: { "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/repository" } } } } }
    patch:
      operationId: repos/update
      tags: [repos]
      requestBody: { content: { application/json: { schema: { type: object, properties: { description: { type: string } } } } } }
      responses: { "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/repository" } } } } }
    delete:
      operationId: repos/delete
      tags: [repos]
      responses: { "204": { description: deleted } }
  /repos/{owner}/{repo}/issues:
    parameters:
      - { name: owner, in: path, required: true, schema: { type: string } }
      - { name: repo, in: path, required: true, schema: { type: string } }
    get:
      operationId: issues/list-for-repo
      tags: [issues]
      responses: { "200": { description: ok, content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/issue" } } } } } }
    post:
      operationId: issues/create
      tags: [issues]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, required: [title], properties: { title: { oneOf: [{ type: string }, { type: integer }] }, body: { type: string } } } } }
      # allOf on purpose: rule 4 must find `number` through allOf members (measured shape, task 1)
      responses: { "201": { description: created, content: { application/json: { schema: { allOf: [{ $ref: "#/components/schemas/issue" }, { type: object, properties: { html_url: { type: string } } }] } } } } }
  /repos/{owner}/{repo}/issues/{issue_number}:
    parameters:
      - { name: owner, in: path, required: true, schema: { type: string } }
      - { name: repo, in: path, required: true, schema: { type: string } }
      - { name: issue_number, in: path, required: true, schema: { type: integer } }
    get:
      operationId: issues/get
      tags: [issues]
      responses: { "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/issue" } } } } }
    patch:
      operationId: issues/update
      tags: [issues]
      requestBody: { content: { application/json: { schema: { type: object, properties: { state: { type: string, enum: [open, closed] } } } } } }
      # measured GitHub shape: allOf with empty top-level properties
      responses: { "200": { description: ok, content: { application/json: { schema: { type: object, properties: {}, allOf: [{ $ref: "#/components/schemas/issue" }] } } } } }
components:
  schemas:
    repository:
      type: object
      required: [id, node_id, name, full_name, owner, url]
      properties:
        id: { type: integer }
        node_id: { type: string }
        name: { type: string }
        full_name: { type: string }
        owner: { type: object, required: [login], properties: { login: { type: string } } }
        url: { type: string }
    issue:
      type: object
      required: [id, node_id, number, title, url]
      properties:
        id: { type: integer }
        node_id: { type: string }
        number: { type: integer }
        title: { type: string }
        url: { type: string }
```

- [ ] **Step 3: failing inference tests.** Create `packages/core/test/flowInfer.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { analyzeOpenApiDocument } from "../src/analyze/openapi.js";
import { inferFlows, linkField, mergeFlows, parseResourcePath, responseProperties, singular } from "../src/flow/infer.js";
import { dereferenceOpenApi } from "../src/ingest/openapi.js";
import { FLOW_ID, FlowsFileSchema, type Flow, type FlowsFile } from "../src/flow/types.js";
import type { Feature } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GITHUB = path.join(here, "fixtures", "flow", "github-issues.yaml");

/** 작은 가짜 기능. responses["201"]의 최상위 속성만 정한다. */
function feat(method: Feature["method"], p: string, props: Record<string, unknown> = {}, body: Feature["request"]["body"] = null): Feature {
  const params = Object.fromEntries([...p.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, { schema: { type: "string" }, required: true }]));
  return {
    id: `${method.toLowerCase()}${p.replace(/[^A-Za-z0-9]+/g, "_")}`, group: "g", title: "", summary: "", method, path: p,
    request: { params, query: {}, headers: {}, body }, responses: { [method === "POST" ? "201" : "200"]: { schema: { type: "object", properties: props }, examples: [] } },
    auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [],
  };
}

describe("parseResourcePath / singular", () => {
  it("finds the resource as the last static segment and the kind", () => {
    expect(parseResourcePath("/repos/{owner}/{repo}/issues/{issue_number}")).toEqual({ resource: "issues", kind: "item", params: ["issue_number"], prefix: "/repos/{}/{}/issues" });
    expect(parseResourcePath("/repos/{owner}/{repo}/issues")).toEqual({ resource: "issues", kind: "list", params: [], prefix: "/repos/{}/{}/issues" });
    expect(parseResourcePath("/repos/{owner}/{repo}")).toEqual({ resource: "repos", kind: "item", params: ["owner", "repo"], prefix: "/repos" });
    expect(parseResourcePath("/{id}")).toBeNull();
  });
  it("singular", () => {
    expect(singular("issues")).toBe("issue");
    expect(singular("repositories")).toBe("repository");
    expect(singular("status")).toBe("statu"); // 단순 규칙(문서화된 한계): 끝 s만 뗀다
  });
});

describe("linkField (R4, R5)", () => {
  const create = feat("POST", "/issues", { id: { type: "integer" }, node_id: { type: "string" }, number: { type: "integer" }, owner: { type: "object" } });
  it("strips the resource prefix and matches exactly one scalar field", () => {
    expect(linkField("issue_number", "issue", create)).toBe("number");
  });
  it("{id} and {<s>_id} map to id", () => {
    expect(linkField("id", "issue", create)).toBe("id");
    expect(linkField("issue_id", "issue", create)).toBe("id");
  });
  it("no candidate, object candidate, or the singular name itself → null", () => {
    expect(linkField("slug", "issue", create)).toBeNull();
    expect(linkField("owner", "issue", create)).toBeNull();
    expect(linkField("issue", "issue", create)).toBeNull();
  });
  it("two candidates after normalization → null", () => {
    const two = feat("POST", "/things", { number: { type: "integer" }, Number: { type: "string" } });
    expect(linkField("thing_number", "thing", two)).toBeNull();
  });
  it("reads candidate fields through allOf (measured: GitHub issue responses)", () => {
    const viaAllOf = feat("POST", "/issues");
    viaAllOf.responses["201"]!.schema = { type: "object", properties: {}, allOf: [
      { type: "object", properties: { id: { type: "integer" }, number: { type: "integer" } } },
      { allOf: [{ type: "object", properties: { html_url: { type: "string" } } }] },
    ] };
    expect(Object.keys(responseProperties(viaAllOf.responses["201"]!.schema))).toEqual(["id", "number", "html_url"]);
    expect(linkField("issue_number", "issue", viaAllOf)).toBe("number");
    expect(linkField("id", "issue", viaAllOf)).toBe("id");
  });
});

describe("inferFlows", () => {
  it("R2 parent before child, R3 skeleton with prep and cleanup", () => {
    const fs = [
      feat("POST", "/projects", { id: { type: "integer" } }),
      feat("DELETE", "/projects/{project_id}"),
      feat("POST", "/projects/{project_id}/cards", { id: { type: "integer" } }),
      feat("GET", "/projects/{project_id}/cards/{card_id}"),
      feat("PATCH", "/projects/{project_id}/cards/{card_id}"),
      feat("PUT", "/projects/{project_id}/cards/{card_id}"),
    ];
    const { flows } = inferFlows(fs);
    expect(flows.map((f) => f.id)).toEqual(["projects", "cards"]);
    const cards = flows[1]!;
    expect(cards.steps.map((s) => [s.id, s.role])).toEqual([
      ["create_project", "prep"], ["create_card", "main"], ["get_card", "main"], ["update_card", "main"], ["update_card_2", "main"], ["delete_project", "cleanup"],
    ]);
    expect(cards.steps[2]!.inputs).toEqual([
      { slot: "path.project_id", source: { kind: "step", step: "create_project", field: "id" }, basis: "rule", createdBy: "create_project" },
      { slot: "path.card_id", source: { kind: "step", step: "create_card", field: "id" }, basis: "rule", createdBy: "create_card" },
    ]);
    expect(cards.steps[0]!.creates).toBe("project");
  });

  it("R6 body: required fields only, example → fixed, otherwise empty", () => {
    const body = { type: "object", required: ["title", "kind"], properties: { title: { type: "string" }, kind: { type: "string", example: "bug" }, extra: { type: "string", example: "x" } } };
    const { flows } = inferFlows([feat("POST", "/tickets", { id: { type: "integer" } }, body)]);
    expect(flows[0]!.steps[0]!.inputs).toEqual([
      { slot: "body.title", source: { kind: "empty" }, basis: "rule" },
      { slot: "body.kind", source: { kind: "fixed", value: "bug" }, basis: "rule" },
    ]);
  });

  it("no create among the selection → no flows and a note", () => {
    const r = inferFlows([feat("GET", "/tickets/{id}")]);
    expect(r.flows).toEqual([]);
    expect(r.notes).toContain("tickets: 생성 기능(목록 경로의 POST)이 선택에 없어 흐름을 만들지 않았습니다.");
  });

  it("GitHub-like spec: issues flow as the spec expects (§2 '예상하는 결과')", async () => {
    // ingest와 같은 순서: dereference 뒤 analyze(analyzeOpenApiDocument는 $ref를 풀지 않는다, src/analyze/openapi.ts:17)
    const doc = await dereferenceOpenApi(GITHUB, YAML.parse(await readFile(GITHUB, "utf8")));
    const features = analyzeOpenApiDocument(doc);
    const at = new Map(features.map((f) => [f.id, `${f.method} ${f.path}`]));
    const { flows, notes } = inferFlows(features);
    expect(flows.map((f) => [f.id, f.name, f.resource])).toEqual([["repos", "repo 다루기", "repo"], ["issues", "issue 다루기", "issue"]]);
    const issues = flows[1]!;
    expect(issues.steps.map((s) => [s.id, s.role, at.get(s.featureId), s.creates ?? null])).toEqual([
      ["create_repo", "prep", "POST /user/repos", "repo"],
      ["create_issue", "main", "POST /repos/{owner}/{repo}/issues", "issue"],
      ["get_issue", "main", "GET /repos/{owner}/{repo}/issues/{issue_number}", null],
      ["update_issue", "main", "PATCH /repos/{owner}/{repo}/issues/{issue_number}", null],
      ["delete_repo", "cleanup", "DELETE /repos/{owner}/{repo}", null],
    ]);
    const input = (stepId: string, slot: string) => issues.steps.find((s) => s.id === stepId)!.inputs.find((i) => i.slot === slot)!;
    // issue_number: create_issue 응답이 allOf라도 number를 찾는다
    expect(input("get_issue", "path.issue_number")).toEqual({ slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" });
    // owner: 어느 단계도 만들지 않는다 → createdBy 없음, target.params가 채운다
    expect(input("create_issue", "path.owner")).toEqual({ slot: "path.owner", source: { kind: "empty" }, basis: "rule" });
    // repo: create_repo가 만든다(C6) → 후보가 하나가 아니라 empty로 두고 createdBy를 남긴다
    for (const id of ["create_issue", "get_issue", "update_issue", "delete_repo"]) {
      expect(input(id, "path.repo")).toEqual({ slot: "path.repo", source: { kind: "empty" }, basis: "rule", createdBy: "create_repo" });
    }
    expect(input("create_issue", "body.title").source).toEqual({ kind: "empty" });
    expect(input("create_repo", "body.name").source).toEqual({ kind: "empty" });
    expect(notes).toContain('issue: 삭제 기능이 없어 상위 자원 repo을(를) 지울 때 함께 지워진다고 봅니다. 상위 삭제가 실패하거나 정리를 끄면 "남은 자원"으로 알립니다.');
  });
});

const asFile = (flows: ReturnType<typeof inferFlows>["flows"]) => ({ system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows });

describe("inferFlows ids from raw path segments", () => {
  it("keeps the file valid for segments with . : @ { }", () => {
    const cases: Feature[][] = [
      [feat("POST", "/chat.postMessage", { ts: { type: "string" } })],
      [feat("POST", "/v1/{name}:cancel", { id: { type: "string" } })],
      [feat("POST", "/a/x.y", { id: { type: "string" } }), feat("POST", "/b/x.y", { id: { type: "string" } })],
    ];
    for (const features of cases) {
      const { flows } = inferFlows(features);
      expect(flows.length).toBeGreaterThan(0);
      expect(FlowsFileSchema.safeParse(asFile(flows)).success).toBe(true);
    }
  });
  it("gives distinct ids when different segments sanitize to the same id", () => {
    const { flows } = inferFlows([feat("POST", "/a/x.y", { id: { type: "string" } }), feat("POST", "/b/x_y", { id: { type: "string" } }), feat("POST", "/c/x:y", { id: { type: "string" } })]);
    const ids = flows.map((f) => f.id);
    expect(ids).toEqual(["x_y", "x_y_2", "x_y_3"]);
    for (const f of flows) expect(f.steps.map((s) => s.id)).toEqual(["create_x_y"]);
    expect(flows.map((f) => f.resource)).toEqual(["x.y", "x_y", "x:y"]); // 사람이 읽는 이름은 그대로
  });
  it("makes step ids unique within a flow after sanitizing", () => {
    const { flows } = inferFlows([
      feat("POST", "/a/{a_id}/x.y", { id: { type: "string" } }), feat("POST", "/a", { id: { type: "string" } }),
      feat("POST", "/a/{a_id}/x_y", { id: { type: "string" } }),
    ]);
    for (const f of flows) expect(new Set(f.steps.map((s) => s.id)).size).toBe(f.steps.length);
    expect(FlowsFileSchema.safeParse(asFile(flows)).success).toBe(true);
  });
  it("every flow id and step id matches FLOW_ID for odd paths", () => {
    const paths = ["/chat.postMessage", "/v1/{name}:cancel", "/@me/items", "/x.y/{id}/z.w", "/a%20b", "/{p}/ä", "/m/{id}:verb"];
    for (const p of paths) {
      const { flows } = inferFlows([feat("POST", p, { id: { type: "string" } }), feat("GET", `${p === "/m/{id}:verb" ? "/m" : p}/{id}`), feat("DELETE", `${p === "/m/{id}:verb" ? "/m" : p}/{id}`)]);
      for (const f of flows) {
        expect(f.id).toMatch(FLOW_ID);
        for (const s of f.steps) expect(s.id).toMatch(FLOW_ID);
      }
      expect(FlowsFileSchema.safeParse(asFile(flows)).success).toBe(true);
    }
  });
});

describe("mergeFlows (re-inference keeps claude/user inputs)", () => {
  it("keeps claude and user inputs by flow+step+slot, replaces rule inputs", () => {
    const next = inferFlows([feat("POST", "/tickets", { id: { type: "integer" } }, { type: "object", required: ["title"], properties: { title: { type: "string" } } })]);
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ ...next.flows[0]!, steps: [{ ...next.flows[0]!.steps[0]!, inputs: [{ slot: "body.title", source: { kind: "user", value: "hello" }, basis: "user" }] }] }] };
    const merged = mergeFlows(prev, next.flows);
    expect(merged[0]!.steps[0]!.inputs).toEqual([{ slot: "body.title", source: { kind: "user", value: "hello" }, basis: "user" }]);
    const fromRule: FlowsFile = { ...prev, flows: [{ ...prev.flows[0]!, steps: [{ ...prev.flows[0]!.steps[0]!, inputs: [{ slot: "body.title", source: { kind: "fixed", value: "old" }, basis: "rule" }] }] }] };
    expect(mergeFlows(fromRule, next.flows)[0]!.steps[0]!.inputs[0]!.source).toEqual({ kind: "empty" });
  });
  it("keeps Claude Code (basis claude) inputs and refreshes rule inputs", () => {
    const next = inferFlows([feat("POST", "/tickets", { id: { type: "integer" } }, { type: "object", required: ["title", "body"], properties: { title: { type: "string" }, body: { type: "string" } } })]);
    const step = next.flows[0]!.steps[0]!;
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ ...next.flows[0]!, steps: [{ ...step, inputs: [
      { slot: "body.title", source: { kind: "fixed", value: "from claude" }, basis: "claude" },
      { slot: "body.body", source: { kind: "fixed", value: "stale" }, basis: "rule" },
    ] }] }] };
    const inputs = mergeFlows(prev, next.flows)[0]!.steps[0]!.inputs;
    expect(inputs.find((i) => i.slot === "body.title")).toEqual({ slot: "body.title", source: { kind: "fixed", value: "from claude" }, basis: "claude" });
    expect(inputs.find((i) => i.slot === "body.body")).toEqual({ slot: "body.body", source: { kind: "empty" }, basis: "rule" });
  });
  it("drops a saved step reference whose step is gone from the new inference (#36)", () => {
    const empty = { kind: "empty" } as const;
    const prevFlow: Flow = { id: "issues", name: "n", resource: "issue", steps: [
      { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [] },
      { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
        { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" },
        { slot: "path.owner", source: { kind: "user", value: "octo" }, basis: "user" }] }] };
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [prevFlow] };
    const nextFlow: Flow = { ...prevFlow, steps: [{ id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
      { slot: "path.repo", source: empty, basis: "rule" }, { slot: "path.owner", source: empty, basis: "rule" }] }] };
    const inputs = mergeFlows(prev, [nextFlow])[0]!.steps[0]!.inputs;
    expect(inputs.find((i) => i.slot === "path.repo")).toEqual({ slot: "path.repo", source: empty, basis: "rule" });
    expect(inputs.find((i) => i.slot === "path.owner")!.source).toEqual({ kind: "user", value: "octo" }); // other kinds stay
  });
  it("keeps a saved step reference that still resolves", () => {
    const steps: Flow["steps"] = [
      { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [] },
      { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
        { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "slug" }, basis: "user", createdBy: "create_repo" }] }];
    const prev: FlowsFile = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ id: "issues", name: "n", resource: "issue", steps }] };
    const next: Flow = { id: "issues", name: "n", resource: "issue", steps: [steps[0]!, { ...steps[1]!, inputs: [{ slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "rule", createdBy: "create_repo" }] }] };
    expect(mergeFlows(prev, [next])[0]!.steps[1]!.inputs[0]!.source).toEqual({ kind: "step", step: "create_repo", field: "slug" });
  });
});
```

  (`yaml` ^2.9.1 is a core dependency, `packages/core/package.json:27`, already used by `src/ingest/openapi.ts:3`. `analyzeOpenApiDocument(doc, registry?)` is exported at `src/analyze/openapi.ts:126` and expects a dereferenced document, so the test calls `dereferenceOpenApi(origin, parsed)` (`src/ingest/openapi.ts:21`) first, as ingest does at `src/ingest/index.ts:100`; operationId `issues/create` becomes feature id `issues_create` via `sanitize`, `src/analyze/featureId.ts:6-8,93-94`.)

- [ ] **Step 4: run, see it fail.** `pnpm exec vitest run packages/core/test/flowInfer.test.ts` → fails: cannot find module `../src/flow/infer.js`.

- [ ] **Step 5: implement `infer.ts`.** Create `packages/core/src/flow/infer.ts`:

```ts
import { requiredBodyFields } from "../select/requiredBody.js";
import type { Feature, JsonSchema } from "../types.js";
import { FLOW_SLOT, type Flow, type FlowInput, type FlowStep, type FlowsFile } from "./types.js";

export interface ResourcePath { resource: string; kind: "list" | "item"; params: string[]; prefix: string }
const isParam = (s: string) => /^\{[^}]+\}$/.test(s);
/** 흐름 id로 쓰지 않는 이름(ui-server 경로 `/flows/infer`와 겹침). */
const RESERVED_IDS = new Set(["infer"]);
/** 경로 구간을 흐름·단계 id(`FLOW_ID`)로 바꾼다. 허용 밖 문자는 `_`. 사람이 읽는 이름은 건드리지 않는다. */
const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** R1. 끝의 `{변수}`를 떼고 남은 마지막 고정 구간이 자원이다. 변수만 있는 경로는 null. */
export function parseResourcePath(p: string): ResourcePath | null {
  const segs = p.split("/").filter(Boolean);
  let i = segs.length - 1;
  const params: string[] = [];
  while (i >= 0 && isParam(segs[i]!)) { params.unshift(segs[i]!.slice(1, -1)); i--; }
  if (i < 0) return null;
  const prefix = "/" + segs.slice(0, i + 1).map((s) => (isParam(s) ? "{}" : s)).join("/");
  return { resource: segs[i]!, kind: params.length > 0 ? "item" : "list", params, prefix };
}

/** 단순 단수형: `ies` → `y`, 끝 `s` 제거. 영어 불규칙형은 다루지 않는다. */
export function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
const SCALAR = new Set(["string", "integer", "number", "boolean"]);
function isScalar(s: unknown): boolean {
  const t = (s as { type?: unknown } | null)?.type;
  return (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && SCALAR.has(x));
}
function successSchema(f: Feature): JsonSchema | null {
  const code = Object.keys(f.responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
  return code ? f.responses[code]!.schema : null;
}

/** 최상위 속성. `allOf` 구성원의 properties를 재귀로 합친다(GitHub issue 응답이 allOf, 측정 task 1). 앞선 이름이 이긴다. */
export function responseProperties(schema: JsonSchema | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (x: unknown, depth: number) => {
    if (!x || typeof x !== "object" || depth > 8) return; // 순환 표식·깊은 중첩 방어
    const o = x as { properties?: Record<string, unknown>; allOf?: unknown[] };
    for (const [k, v] of Object.entries(o.properties ?? {})) if (!(k in out)) out[k] = v;
    for (const m of o.allOf ?? []) walk(m, depth + 1);
  };
  walk(schema, 0);
  return out;
}

/** R4·R5. 맞는 최상위 스칼라 응답 필드(allOf 포함)가 정확히 하나일 때만 그 이름. */
export function linkField(param: string, singularName: string, create: Feature): string | null {
  const p = norm(param), r = norm(singularName);
  if (p === r) return null;
  const target = p === "id" || p === `${r}id` ? "id" : p.startsWith(r) ? p.slice(r.length) : p;
  if (target === "") return null;
  const props = responseProperties(successSchema(create));
  const hits = Object.entries(props).filter(([k, s]) => isScalar(s) && norm(k) === target).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}

interface Group {
  key: string; resource: string; s: string;
  listPrefix?: string; itemPath?: string; itemParams: string[];
  create?: Feature; get?: Feature; updates: Feature[]; del?: Feature;
  parent?: Group;
}

function buildGroups(features: Feature[]): Group[] {
  const byKey = new Map<string, Group>();
  const group = (key: string, resource: string) => {
    let g = byKey.get(key);
    if (!g) { g = { key, resource, s: singular(resource), itemParams: [], updates: [] }; byKey.set(key, g); }
    return g;
  };
  for (const f of features) {
    const rp = parseResourcePath(f.path);
    if (!rp) continue;
    const g = group(rp.prefix, rp.resource);
    if (rp.kind === "list") { g.listPrefix = rp.prefix; if (f.method === "POST") g.create ??= f; }
    else {
      g.itemPath = rp.prefix + "/{}".repeat(rp.params.length); g.itemParams = rp.params;
      if (f.method === "GET") g.get ??= f;
      else if (f.method === "PATCH" || f.method === "PUT") g.updates.push(f);
      else if (f.method === "DELETE") g.del ??= f;
    }
  }
  // R1 보조: 개별 경로만 있는 묶음은 같은 자원 이름의 "생성만 있는 목록 묶음"이 정확히 하나일 때 합친다.
  for (const g of [...byKey.values()]) {
    if (g.listPrefix || !g.itemPath) continue;
    const peers = [...byKey.values()].filter((o) => o !== g && o.resource === g.resource && o.create && !o.itemPath);
    if (peers.length !== 1) continue;
    const o = peers[0]!;
    Object.assign(o, { itemPath: g.itemPath, itemParams: g.itemParams, get: g.get, updates: g.updates, del: g.del });
    byKey.delete(g.key);
  }
  const groups = [...byKey.values()];
  for (const g of groups) { // R2: 가장 가까운 부모
    const own = g.listPrefix ?? g.key;
    g.parent = groups.filter((p) => p !== g && p.itemPath && own.startsWith(p.itemPath + "/")).sort((a, b) => b.itemPath!.length - a.itemPath!.length)[0];
  }
  const depth = (g: Group): number => (g.parent ? 1 + depth(g.parent) : 0);
  return groups.sort((a, b) => depth(a) - depth(b));
}

/**
 * 경로 변수 → 그 변수가 가리키는 자원(바로 앞 고정 구간)의 단수형.
 * 고정 구간 뒤에 변수가 여럿 이어지면 마지막 것만 그 자원이고, 앞의 것은 범위 변수라 주인이 없다
 * (`/repos/{owner}/{repo}`: repo → repo, owner → 없음 → target.params가 채운다).
 */
function paramOwners(p: string): Map<string, string> {
  const out = new Map<string, string>();
  let owner: string | null = null;
  let last: string | null = null;
  for (const seg of [...p.split("/").filter(Boolean), "/"]) { // "/"는 끝 표시
    if (isParam(seg)) { last = seg.slice(1, -1); continue; }
    if (owner && last) out.set(last, singular(owner));
    owner = seg; last = null;
  }
  return out;
}

function stepInputs(f: Feature, creators: Map<string, { stepId: string; feature: Feature }>): FlowInput[] {
  const owners = paramOwners(f.path);
  const inputs: FlowInput[] = [];
  for (const m of f.path.matchAll(/\{([^}]+)\}/g)) {
    const param = m[1]!;
    const s = owners.get(param);
    const c = s ? creators.get(s) : undefined;
    const field = c && s ? linkField(param, s, c.feature) : null;
    inputs.push({
      slot: `path.${param}`,
      source: field && c ? { kind: "step", step: c.stepId, field } : { kind: "empty" },
      basis: "rule",
      ...(c ? { createdBy: c.stepId } : {}), // 이 흐름이 만드는 자원: target.params가 채우지 않는다(C6)
    });
  }
  for (const b of requiredBodyFields(f)) {
    const slot = `body.${b.name}`;
    if (!FLOW_SLOT.test(slot)) continue;
    inputs.push({ slot, source: b.example === undefined ? { kind: "empty" } : { kind: "fixed", value: b.example as never }, basis: "rule" });
  }
  return inputs;
}

export interface InferResult { flows: Flow[]; notes: string[] }

/** 고른 기능에서 흐름을 추론한다(설계 §2 규칙 1~6). 순수 함수. */
export function inferFlows(features: Feature[]): InferResult {
  const groups = buildGroups(features);
  const notes: string[] = [];
  const flows: Flow[] = [];
  const usedIds = new Set<string>(RESERVED_IDS);
  for (const g of groups) {
    if (!g.create) { notes.push(`${g.resource}: 생성 기능(목록 경로의 POST)이 선택에 없어 흐름을 만들지 않았습니다.`); continue; }
    const chain: Group[] = [];
    for (let p = g.parent; p; p = p.parent) chain.unshift(p);
    const steps: FlowStep[] = [];
    const creators = new Map<string, { stepId: string; feature: Feature }>();
    const ids = new Set<string>();
    const add = (base: string, feature: Feature, role: FlowStep["role"], creates?: string) => {
      let id = base; for (let n = 2; ids.has(id); n++) id = `${base}_${n}`;
      ids.add(id);
      steps.push({ id, featureId: feature.id, role, inputs: stepInputs(feature, creators), ...(creates ? { creates } : {}) });
      if (creates) creators.set(creates, { stepId: id, feature });
    };
    for (const p of chain) if (p.create) add(`create_${idPart(p.s)}`, p.create, "prep", p.s);
    add(`create_${idPart(g.s)}`, g.create, "main", g.s);
    if (g.get) add(`get_${idPart(g.s)}`, g.get, "main");
    const updates = [...g.updates].sort((a, b) => (a.method === b.method ? 0 : a.method === "PATCH" ? -1 : 1));
    for (const u of updates) add(`update_${idPart(g.s)}`, u, "main");
    const parentDel = [...chain].reverse().find((p) => p.del && p.create); // 지우면 자식도 사라지는 가장 가까운 상위
    if (g.del) add(`delete_${idPart(g.s)}`, g.del, "cleanup");
    else if (parentDel) notes.push(`${g.s}: 삭제 기능이 없어 상위 자원 ${parentDel.s}을(를) 지울 때 함께 지워진다고 봅니다. 상위 삭제가 실패하거나 정리를 끄면 "남은 자원"으로 알립니다.`);
    else notes.push(`${g.s}: 삭제 기능이 없어 실행 뒤 "남은 자원"으로 알립니다.`);
    for (const p of [...chain].reverse()) if (p.del && p.create) add(`delete_${idPart(p.s)}`, p.del, "cleanup");
    const base = idPart(g.resource);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}_${n}`;
    usedIds.add(id);
    flows.push({ id, name: `${g.s} 다루기`, resource: g.s, steps });
  }
  return { flows, notes };
}

/** R 재추론: 이전 파일의 근거 claude·user 입력은 (흐름 id, 단계 id, 자리)가 같으면 출처와 근거를 그대로 둔다. `createdBy`는 새 추론 값을 쓴다. 단계 출처가 새 흐름에 없는 단계를 가리키면 그 입력은 옮기지 않고 새 추론 값을 쓴다(빈 자리는 "입력 필요"). */
export function mergeFlows(prev: FlowsFile | null, next: Flow[]): Flow[] {
  if (!prev) return next;
  const kept = new Map<string, FlowInput>();
  for (const f of prev.flows) for (const s of f.steps) for (const i of s.inputs) if (i.basis !== "rule") kept.set(`${f.id}\u0000${s.id}\u0000${i.slot}`, i);
  return next.map((f) => {
    const stepIds = new Set(f.steps.map((s) => s.id));
    return { ...f, steps: f.steps.map((s) => ({ ...s, inputs: s.inputs.map((i) => {
      const k = kept.get(`${f.id}\u0000${s.id}\u0000${i.slot}`);
      if (!k || (k.source.kind === "step" && !stepIds.has(k.source.step))) return i;
      return { ...i, source: k.source, basis: k.basis };
    }) })) };
  });
}
```

  Notes:
  - The "R2 parent before child" test expects `delete_project` in the cards flow because the parent create is in the chain; a parent delete without a parent create is not added (nothing to clean).
  - `createdBy` is set whenever a creating step for the param's resource exists in the flow, linked or not. `store.emptySlots` and `run.ts` read it to keep `target.params` away from a parent created in the same flow (C6).
  - `responseProperties` stops at depth 8; `stringifyCycleSafe` already replaces true cycles with `{ "x-specmock-circular": true }`, which has no `properties`.

- [ ] **Step 6: run, pass.** `pnpm exec vitest run packages/core/test/flowInfer.test.ts` → all pass. If the GitHub-like test fails on step order, compare with the R3 description above; do not change the expected list, since it encodes spec §2 "GitHub에서 예상하는 결과".

- [ ] **Step 7: commit.** `git add packages/core/src/flow packages/core/test/flowInfer.test.ts packages/core/test/fixtures/flow && git commit -m "feat(core): infer per-resource flows from selected features"`

- [ ] **Step 8: failing store tests.** Create `packages/core/test/flowStore.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptySlots, FLOWS_FILE, missingFeatures, readFlows, setInput, writeFlows } from "../src/flow/store.js";
import type { Flow, FlowsFile } from "../src/flow/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string; let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-flow-")); ws = new Workspace(path.join(dir, ".specmock")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const empty = { kind: "empty" } as const;
const flow: Flow = { id: "issues", name: "issue 다루기", resource: "issue", steps: [
  { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [
    { slot: "body.name", source: empty, basis: "rule" },
  ] },
  { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
    { slot: "path.owner", source: empty, basis: "rule" },
    { slot: "path.repo", source: empty, basis: "rule", createdBy: "create_repo" },
    { slot: "body.title", source: empty, basis: "rule" },
  ] },
  { id: "get_issue", featureId: "issues_get", role: "main", inputs: [
    { slot: "path.owner", source: empty, basis: "rule" },
    { slot: "path.repo", source: empty, basis: "rule", createdBy: "create_repo" },
    { slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" },
  ] },
] };
const file: FlowsFile = { system: "gh", catalogHash: "h", inferredAt: "2026-11-26T00:00:00.000Z", flows: [flow], notes: [] };
const inputOf = (f: FlowsFile, stepId: string, slot: string) => f.flows[0]!.steps.find((s) => s.id === stepId)!.inputs.find((i) => i.slot === slot);

describe("flow store", () => {
  it("writes and reads flows.json", async () => {
    expect(await readFlows(ws, "gh")).toBeNull();
    await writeFlows(ws, "gh", file);
    expect(await readFlows(ws, "gh")).toEqual(file);
    expect(JSON.parse(await readFile(ws.file("gh", FLOWS_FILE), "utf8")).flows[0].id).toBe("issues");
  });
  it("setInput replaces one slot with the given basis; unknown ids throw", () => {
    const next = setInput(file, "issues", "create_issue", "body.title", { kind: "user", value: "flow test" }, "user");
    expect(inputOf(next, "create_issue", "body.title")).toEqual({ slot: "body.title", source: { kind: "user", value: "flow test" }, basis: "user" });
    expect(inputOf(file, "create_issue", "body.title")!.source).toEqual({ kind: "empty" }); // 원본 불변
    expect(() => setInput(file, "nope", "create_issue", "body.title", { kind: "empty" }, "user")).toThrow(/알 수 없는 흐름: nope/);
    expect(() => setInput(file, "issues", "x", "body.title", { kind: "empty" }, "user")).toThrow(/알 수 없는 단계: x/);
    expect(() => setInput(file, "issues", "create_issue", "body.nope", { kind: "empty" }, "user")).toThrow(/알 수 없는 입력 자리: body.nope/);
    expect(() => setInput(file, "issues", "get_issue", "path.issue_number", { kind: "step", step: "get_issue", field: "id" }, "user")).toThrow(/앞 단계만 고를 수 있습니다/);
  });
  it("emptySlots: target params cover only path variables no step of the flow creates (C6)", () => {
    expect(emptySlots(flow, {})).toEqual([
      "create_repo:body.name", "create_issue:path.owner", "create_issue:path.repo", "create_issue:body.title", "get_issue:path.owner", "get_issue:path.repo",
    ]);
    // repo는 params에 있어도 create_repo가 이 흐름에서 만드므로 계속 빈 자리로 센다
    expect(emptySlots(flow, { owner: "octo", repo: "prod-repo" })).toEqual(["create_repo:body.name", "create_issue:path.repo", "create_issue:body.title", "get_issue:path.repo"]);
  });
  it("linking a created parent once fills the same slot in the other steps that are still empty", () => {
    const link = { kind: "step", step: "create_repo", field: "name" } as const;
    const next = setInput(file, "issues", "create_issue", "path.repo", link, "user");
    for (const id of ["create_issue", "get_issue"]) expect(inputOf(next, id, "path.repo")).toEqual({ slot: "path.repo", source: link, basis: "user", createdBy: "create_repo" });
    expect(emptySlots(next.flows[0]!, { owner: "octo" })).toEqual(["create_repo:body.name", "create_issue:body.title"]);
    // 이미 채운 자리는 덮지 않고, 사용자 값은 퍼뜨리지 않는다
    const manual = setInput(file, "issues", "get_issue", "path.repo", { kind: "user", value: "other" }, "user");
    expect(inputOf(setInput(manual, "issues", "create_issue", "path.repo", link, "claude"), "get_issue", "path.repo")!.source).toEqual({ kind: "user", value: "other" });
    expect(inputOf(setInput(file, "issues", "create_issue", "path.repo", { kind: "user", value: "x" }, "user"), "get_issue", "path.repo")!.source).toEqual(empty);
  });
  it("propagation needs the same creating step: same slot name with another createdBy stays empty", () => {
    const nested: Flow = { id: "cards", name: "card 다루기", resource: "card", steps: [
      { id: "create_project", featureId: "p_create", role: "prep", creates: "project", inputs: [] },
      { id: "get_project", featureId: "p_get", role: "prep", inputs: [{ slot: "path.id", source: empty, basis: "rule", createdBy: "create_project" }] },
      { id: "create_card", featureId: "c_create", role: "main", creates: "card", inputs: [] },
      { id: "get_card", featureId: "c_get", role: "main", inputs: [{ slot: "path.id", source: empty, basis: "rule", createdBy: "create_card" }] },
      { id: "update_card", featureId: "c_update", role: "main", inputs: [{ slot: "path.id", source: empty, basis: "rule", createdBy: "create_card" }] },
    ] };
    const f: FlowsFile = { ...file, flows: [nested] };
    const link = { kind: "step", step: "create_card", field: "id" } as const;
    const next = setInput(f, "cards", "get_card", "path.id", link, "user");
    const at = (id: string) => next.flows[0]!.steps.find((s) => s.id === id)!.inputs[0]!;
    expect(at("update_card").source).toEqual(link);
    expect(at("get_project").source).toEqual(empty);
  });
  it("missingFeatures lists feature ids absent from the selection", () => {
    expect(missingFeatures(flow, new Set(["issues_create"]))).toEqual(["repos_create", "issues_get"]);
  });
});
```

- [ ] **Step 9: run, see it fail.** `pnpm exec vitest run packages/core/test/flowStore.test.ts` → cannot find module `../src/flow/store.js`.

- [ ] **Step 10: implement `store.ts`.** Create `packages/core/src/flow/store.ts`:

```ts
import type { Workspace } from "../workspace.js";
import { FlowsFileSchema, type Flow, type FlowBasis, type FlowSource, type FlowsFile } from "./types.js";

export const FLOWS_FILE = "flows.json";

export async function readFlows(ws: Workspace, system: string): Promise<FlowsFile | null> {
  return (await ws.exists(system, FLOWS_FILE)) ? ws.read(system, FLOWS_FILE, FlowsFileSchema) : null;
}

export async function writeFlows(ws: Workspace, system: string, file: FlowsFile): Promise<string> {
  return ws.write(system, FLOWS_FILE, FlowsFileSchema, file);
}

/**
 * 입력 하나를 바꾼 새 파일. 단계 출처는 같은 흐름의 앞 단계만 허용한다. `createdBy`는 그대로 둔다.
 * 이 흐름이 만든 상위 자원을 그 생성 단계에 연결하면(`repo <- create_repo.name`), 같은 `createdBy`의 같은 자리 중
 * 아직 비어 있는 다른 단계에도 같은 연결을 넣는다("한 번만 연결", C6).
 */
export function setInput(file: FlowsFile, flowId: string, stepId: string, slot: string, source: FlowSource, basis: FlowBasis): FlowsFile {
  const flow = file.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`알 수 없는 흐름: ${flowId}`);
  const at = flow.steps.findIndex((s) => s.id === stepId);
  if (at < 0) throw new Error(`알 수 없는 단계: ${stepId} (흐름 ${flowId})`);
  const target = flow.steps[at]!.inputs.find((i) => i.slot === slot);
  if (!target) throw new Error(`알 수 없는 입력 자리: ${slot} (단계 ${stepId})`);
  if (source.kind === "step" && !flow.steps.slice(0, at).some((s) => s.id === source.step)) throw new Error(`출처 단계 ${source.step}: 같은 흐름의 앞 단계만 고를 수 있습니다.`);
  const spread = source.kind === "step" && target.createdBy !== undefined && source.step === target.createdBy;
  return {
    ...file,
    flows: file.flows.map((f) => f.id !== flowId ? f : {
      ...f, steps: f.steps.map((s) => ({ ...s, inputs: s.inputs.map((i) => {
        if (i.slot !== slot) return i;
        if (s.id === stepId) return { ...i, source, basis };
        if (spread && i.createdBy === target.createdBy && i.source.kind === "empty") return { ...i, source, basis };
        return i;
      }) })),
    }),
  };
}

/** 빈 자리(`<단계 id>:<자리>`). target.json `params`는 이 흐름의 어느 단계도 만들지 않는 `path.<이름>`(createdBy 없음)만 채우므로 그것만 뺀다. */
export function emptySlots(flow: Flow, params: Record<string, string>): string[] {
  return flow.steps.flatMap((s) => s.inputs
    .filter((i) => i.source.kind === "empty" && !(i.slot.startsWith("path.") && !i.createdBy && Object.hasOwn(params, i.slot.slice(5))))
    .map((i) => `${s.id}:${i.slot}`));
}

export function missingFeatures(flow: Flow, featureIds: ReadonlySet<string>): string[] {
  return [...new Set(flow.steps.map((s) => s.featureId).filter((id) => !featureIds.has(id)))];
}
```

  (`Workspace.write` returns `Promise<string>`, the written path, `src/workspace.ts:61`; `exists` is at `:31`, `read` at `:40`.)

- [ ] **Step 11: run, pass.** `pnpm exec vitest run packages/core/test/flowStore.test.ts` → 5 passed. The propagation only follows a step source that points at the input's own `createdBy` step, so `delete_repo`'s `path.repo` is linked by the same call and teardown can find the repo's delete step (Task 4).

- [ ] **Step 12: service + exports, with a failing test first.** Append to `packages/core/test/flowStore.test.ts`:

```ts
import { analyze } from "../src/analyze/index.js";
import { ingest } from "../src/ingest/index.js";
import { select } from "../src/select/index.js";
import { inferFlowsForSystem } from "../src/service/flow.js";
import { fileURLToPath } from "node:url";

const GITHUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "flow", "github-issues.yaml");

describe("inferFlowsForSystem", () => {
  it("infers from the selected features only and keeps user inputs on re-infer", async () => {
    await ingest(ws, "gh", [GITHUB]);
    await analyze(ws, "gh");
    await select(ws, "gh", ["issues_*"]); // glob over ids; operationId `issues/create` → `issues_create`
    const first = await inferFlowsForSystem(ws, "gh");
    expect(first.flows.map((f) => f.id)).toEqual(["issues"]);
    expect(first.flows[0]!.steps.some((s) => s.role === "prep")).toBe(false); // repos 기능은 고르지 않음
    await writeFlows(ws, "gh", setInput(first, "issues", "create_issue", "body.title", { kind: "user", value: "t" }, "user"));
    const again = await inferFlowsForSystem(ws, "gh");
    expect(again.flows[0]!.steps[0]!.inputs.find((i) => i.slot === "body.title")!.source).toEqual({ kind: "user", value: "t" });
  });
  it("throws a fix-it message before selection", async () => {
    await ingest(ws, "gh", [GITHUB]);
    await analyze(ws, "gh");
    await expect(inferFlowsForSystem(ws, "gh")).rejects.toThrow(/먼저 기능을 고르세요/);
  });
});
```

  Run: `pnpm exec vitest run packages/core/test/flowStore.test.ts` → fails (module `../src/service/flow.js` missing). Move the new imports to the top of the file. Selection expressions are `all`, numbers/ranges, ids and globs (`test/expression.test.ts:31-40`); there is no tag expression, so the test uses the `issues_*` glob.

- [ ] **Step 13: implement the service.** Create `packages/core/src/service/flow.ts`:

```ts
import { inferFlows, mergeFlows } from "../flow/infer.js";
import { readFlows, writeFlows } from "../flow/store.js";
import type { FlowsFile } from "../flow/types.js";
import { MockSpecSchema, SelectionSchema } from "../types.js";
import type { Workspace } from "../workspace.js";

/** mockspec.json(고른 기능만)에서 흐름을 추론해 flows.json에 쓴다. 근거가 claude·user인 입력은 보존한다. */
export async function inferFlowsForSystem(ws: Workspace, system: string): Promise<FlowsFile> {
  if (!(await ws.exists(system, "selection.json")) || !(await ws.exists(system, "mockspec.json"))) {
    throw new Error(`${system}: 먼저 기능을 고르세요 (선택한 기능이 없어 흐름을 추론할 수 없습니다).`);
  }
  const selection = await ws.read(system, "selection.json", SelectionSchema);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const { flows, notes } = inferFlows(spec.features);
  const file: FlowsFile = {
    system, catalogHash: selection.catalogHash, inferredAt: new Date().toISOString(),
    flows: mergeFlows(await readFlows(ws, system), flows),
    notes: flows.length === 0 && notes.length === 0 ? ["고른 기능에서 자원 경로를 찾지 못했습니다."] : notes,
  };
  await writeFlows(ws, system, file);
  return file;
}
```

  Create `packages/core/src/flow/index.ts`:

```ts
export * from "./types.js";
export { inferFlows, mergeFlows, linkField, parseResourcePath, singular, type InferResult, type ResourcePath } from "./infer.js";
export { FLOWS_FILE, emptySlots, missingFeatures, readFlows, setInput, writeFlows } from "./store.js";
```

  `packages/core/src/service/index.ts`: add `export { inferFlowsForSystem } from "./flow.js";`. `packages/core/src/index.ts`: add `export * from "./flow/index.js";` and make sure `inferFlowsForSystem` is re-exported the same way the other services are. `packages/core/src/service/events.ts:1`: append `| "flow"` to `ServiceStage`.

- [ ] **Step 14: run, pass, full gate.** `pnpm exec vitest run packages/core/test/flowStore.test.ts packages/core/test/flowInfer.test.ts` → pass. `pnpm typecheck && pnpm test` → all pass (no existing file reads `flows.json`).

- [ ] **Step 15: commit.** `git add -A packages/core && git commit -m "feat(core): store flows.json and infer flows per system"`

---

### Task 4: `flow/run`

**Files:**
- Create: `packages/core/src/flow/run.ts`, `packages/core/src/flow/runTypes.ts`, `packages/core/src/service/flowRun.ts`
- Modify: `packages/core/src/verify/contracts.ts:7-21` (`ContractRunOptions.body`), `:76-79` (use it)
- Modify: `packages/core/src/record/index.ts:15,47,62,84` (export `NORMAL_CONTRACT`, `maskValues`, `maskBody`, `recordedHeaders`; widen `recordedHeaders` to `Pick<Target, "headers" | "secrets">`)
- Modify: `packages/core/src/flow/store.ts` (add `FLOW_RUNS_DIR`, `flowRunName`, `readFlowRun`, `writeFlowRun`), `packages/core/src/flow/index.ts`, `packages/core/src/service/index.ts`
- Test: `packages/core/test/contract-run.test.ts` (one new case), `packages/core/test/flowRun.test.ts`, `packages/core/test/flowRunService.test.ts`

Run rules (spec §3), as implemented here:
- Order: steps in file order. `prep` and `main` run first; `cleanup` steps only run in the teardown phase.
- Values: a `step` source reads the dotted `field` from the in-memory JSON response of that step. A path slot with an `empty` source and no `createdBy` falls back to `target.params[<name>]` (`{owner}`). A path slot with `createdBy` names a parent this flow creates, so `target.params` never fills it, even when the name is there (C6: the child uses the resource the prep step made, not an existing one). Anything else still empty stops the run: state `stopped-empty`, `missing` lists the slots.
- Safety (real target only): when on, every non-`GET`/`HEAD` step is `skipped-safety` without a request. Steps that need a value from a skipped step are also `skipped-safety`. The mock target ignores safety.
- DELETE scope: a `DELETE` step is sent only when its last path input is a `step` source pointing at a step with `creates` that succeeded in this run. Otherwise it is `skipped-safety` with reason `NOT_CREATED`. This holds even with safety off.
- Failure: a non-2xx status or a network error makes the step `failed`. 401, 403 and 404 add `FLOW_AUTH_HINT`. The remaining `prep`/`main` steps stay `pending`, then teardown runs. A 2xx with schema or status errors is `diff`, and the run continues.
- Teardown: for each created resource, newest first, run the cleanup step that is linked to it. Success makes the cleanup step `cleaned`. Failure, no linked cleanup step, or cleanup turned off adds a `Leftover` entry with url and id, except for a resource whose parent was deleted in this run: a created step whose path input is a `step` source pointing at another created step is that step's child, and when an ancestor was `cleaned`, the child went with it (GitHub: deleting the repo removes its issues) and is not listed. If the parent delete fails or cleanup is off, parent and child are both listed.
- Name suffix: string values from `user`/`fixed` sources in `body.name` and `body.title` of a step with `creates` get `-<yyyyMMddHHmmss>` (UTC run start).
- Secrets: request headers from the target are stored as `***`. Strings are passed through `redactSecrets(…, target.secrets)` and `maskSecrets`. Raw tokens never reach the run file.

- [ ] **Step 1: failing test for the body override in `runContract`.** Append to `packages/core/test/contract-run.test.ts`, following the file's existing `startFakeTarget` usage:

```ts
it("body option replaces the contract body (null sends no body)", async () => {
  const t = await startFakeTarget(() => ({ status: 201, body: { ok: true } }));
  try {
    const c = { featureId: "f", name: "정상 요청", request: { method: "POST" as const, path: "/x", headers: {}, query: {}, body: { a: 1 } }, expect: { status: 201, schema: null } };
    await runContract(t.url, c, { body: { title: "flow-20261126000000" } });
    expect(JSON.parse(t.requests[0]!.body)).toEqual({ title: "flow-20261126000000" });
    expect(t.requests[0]!.headers["content-type"]).toBe("application/json");
    await runContract(t.url, { ...c, request: { ...c.request, body: null } }, { body: { a: 2 } });
    expect(JSON.parse(t.requests[1]!.body)).toEqual({ a: 2 });
  } finally { await t.close(); }
});
```

  Run: `pnpm exec vitest run packages/core/test/contract-run.test.ts` → the new case fails: the first request body is `{"a":1}`.

- [ ] **Step 2: implement the body option.** In `packages/core/src/verify/contracts.ts`, add to `ContractRunOptions`:

```ts
  /** contract 본문 대신 보낼 값(흐름 실행의 단계별 값). undefined면 contract 본문. null이면 본문 없음. */
  body?: unknown;
```

  and replace lines 76-79 with:

```ts
    const reqBody = opts.body !== undefined ? opts.body : c.request.body;
    const headers = mergeHeaders(reqBody !== null ? { "content-type": "application/json" } : {}, c.request.headers, opts.headers ?? {});
    const body = reqBody === null ? undefined
      : isFormContentType(headers) ? encodeForm(reqBody)
      : JSON.stringify(reqBody);
```

  `encodeForm(body: unknown)` (`src/verify/formEncode.ts:4`) already takes `unknown`, so no cast is needed. Run: `pnpm exec vitest run packages/core/test/contract-run.test.ts packages/core/test/record.test.ts packages/core/test/e2e.test.ts` → all pass. Callers that omit `body` behave as before.

- [ ] **Step 3: commit.** `git commit -am "feat(core): let runContract override the request body per call"`

- [ ] **Step 4: run types.** Create `packages/core/src/flow/runTypes.ts`:

```ts
import { z } from "zod";
import { FlowRole } from "./types.js";

export const FlowTargetName = z.enum(["mock", "real"]);
export type FlowTargetName = z.infer<typeof FlowTargetName>;

/** 단계 상태 8가지(설계 §4). pending=실행 전. */
export const StepState = z.enum(["pending", "success", "diff", "failed", "skipped-safety", "stopped-empty", "cleaned", "leftover"]);
export type StepState = z.infer<typeof StepState>;

export const StepResultSchema = z.object({
  stepId: z.string(),
  featureId: z.string(),
  role: FlowRole,
  state: StepState,
  reason: z.string().nullable(),
  /** stopped-empty일 때 비어 있던 자리. */
  missing: z.array(z.string()),
  request: z.object({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), body: z.json().nullable() }).nullable(),
  response: z.object({ status: z.number().int().nullable(), kind: z.string().nullable(), body: z.json().nullable() }).nullable(),
  schemaErrors: z.array(z.string()),
  /** 이번 실행에서 각 자리에 들어간 값(마스킹 후). 화면의 연결선 값. */
  values: z.record(z.string(), z.json()),
  durationMs: z.number().nonnegative(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const LeftoverSchema = z.object({ resource: z.string(), stepId: z.string(), url: z.string(), id: z.string().nullable(), reason: z.string() });
export type Leftover = z.infer<typeof LeftoverSchema>;

export const FlowRunOutcome = z.enum(["success", "diff", "failed", "stopped", "cancelled"]);
export type FlowRunOutcome = z.infer<typeof FlowRunOutcome>;

/** `.specmock/<system>/flow-runs/<flowId>/<target>.json`. 대상별 마지막 실행 하나. */
export const FlowRunSchema = z.object({
  flowId: z.string(),
  target: FlowTargetName,
  startedAt: z.string(),
  finishedAt: z.string(),
  safety: z.boolean(),
  cleanup: z.boolean(),
  suffix: z.string(),
  outcome: FlowRunOutcome,
  /** 실행 전체를 막은 오류(mock 기동 실패, target.json 오류). */
  error: z.string().nullable(),
  steps: z.array(StepResultSchema),
  leftovers: z.array(LeftoverSchema),
});
export type FlowRun = z.infer<typeof FlowRunSchema>;
```

- [ ] **Step 5: failing runner tests.** Create `packages/core/test/flowRun.test.ts`. It runs against `startFakeTarget`, a tiny GitHub-like server that keeps state in memory:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLOW_AUTH_HINT, NOT_CREATED, runFlow, type FlowTarget } from "../src/flow/run.js";
import type { Flow } from "../src/flow/types.js";
import type { Contract, Feature, MockSpec } from "../src/types.js";
import { startFakeTarget, type FakeReq, type FakeRes, type FakeTarget } from "./fakeTarget.js";

function feature(id: string, method: Feature["method"], p: string): Feature {
  return { id, group: "g", title: id, summary: "", method, path: p, request: { params: {}, query: {}, headers: {}, body: method === "POST" ? { type: "object" } : null },
    responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [] };
}
const contract = (f: Feature, status: number): Contract => ({ featureId: f.id, name: "정상 요청", request: { method: f.method, path: f.path, headers: {}, query: {}, body: f.request.body ? {} : null }, expect: { status, schema: null } });
const F = [
  feature("repos_create", "POST", "/user/repos"), feature("issues_create", "POST", "/repos/{owner}/{repo}/issues"),
  feature("issues_get", "GET", "/repos/{owner}/{repo}/issues/{issue_number}"), feature("repos_delete", "DELETE", "/repos/{owner}/{repo}"),
];
const spec: MockSpec = { system: "gh", baseUrl: "http://x", features: F, notMocked: [], assumptions: [],
  contracts: [contract(F[0]!, 201), contract(F[1]!, 201), contract(F[2]!, 200), contract(F[3]!, 204)] } as MockSpec;

const flow: Flow = { id: "issues", name: "issue 다루기", resource: "issue", steps: [
  { id: "create_repo", featureId: "repos_create", role: "prep", creates: "repo", inputs: [{ slot: "body.name", source: { kind: "user", value: "flowtest" }, basis: "user" }] },
  { id: "create_issue", featureId: "issues_create", role: "main", creates: "issue", inputs: [
    { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
    { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" },
    { slot: "body.title", source: { kind: "fixed", value: "hello" }, basis: "rule" }] },
  { id: "get_issue", featureId: "issues_get", role: "main", inputs: [
    { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
    { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" },
    { slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule", createdBy: "create_issue" }] },
  { id: "delete_repo", featureId: "repos_delete", role: "cleanup", inputs: [
    { slot: "path.owner", source: { kind: "empty" }, basis: "rule" },
    { slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" }, basis: "user", createdBy: "create_repo" }] },
] };

let t: FakeTarget; let fail: Partial<Record<string, number>> = {};
const NOW = () => new Date("2026-11-26T01:02:03.000Z");
function github(r: FakeReq): FakeRes {
  const key = `${r.method} ${r.path.replace(/\/repos\/[^/]+\/[^/]+/, "/repos/R")}`;
  if (fail[key]) return { status: fail[key]!, body: { message: "Bad credentials" } };
  if (key === "POST /user/repos") { const b = JSON.parse(r.body); return { status: 201, body: { id: 1, name: b.name, url: `https://api.github.test/repos/octo/${b.name}` } }; }
  if (key === "POST /repos/R/issues") return { status: 201, body: { id: 9, number: 7, title: JSON.parse(r.body).title, url: "https://api.github.test/issues/7" } };
  if (key === "GET /repos/R/issues/7") return { status: 200, body: { number: 7 } };
  if (key === "DELETE /repos/R") return { status: 204 };
  return { status: 404, body: { message: "Not Found" } };
}
const target = (over: Partial<FlowTarget> = {}): FlowTarget => ({ name: "real", baseUrl: t.url, headers: { authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123" }, params: { owner: "octo" }, timeoutMs: 5_000, secrets: ["ghp_abcdefghijklmnopqrstuvwxyz0123"], ...over });

beforeEach(async () => { fail = {}; t = await startFakeTarget(github); });
afterEach(async () => { await t.close(); });

describe("runFlow", () => {
  it("passes values between steps, suffixes names, tears down; the issue goes with its repo", async () => {
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.outcome).toBe("success");
    expect(run.suffix).toBe("-20261126010203");
    expect(t.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /user/repos", "POST /repos/octo/flowtest-20261126010203/issues", "GET /repos/octo/flowtest-20261126010203/issues/7", "DELETE /repos/octo/flowtest-20261126010203",
    ]);
    expect(JSON.parse(t.requests[1]!.body)).toEqual({ title: "hello-20261126010203" });
    expect(run.steps.map((s) => s.state)).toEqual(["success", "success", "success", "cleaned"]);
    expect(run.steps[2]!.values).toEqual({ "path.owner": "octo", "path.repo": "flowtest-20261126010203", "path.issue_number": 7 });
    expect(run.leftovers).toEqual([]); // repo를 지우면 그 안의 issue도 지워진다(C6)
    expect(JSON.stringify(run)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(run.steps[0]!.request!.headers.authorization).toBe("***");
  });

  it("safety on (real): non-GET skipped, dependents skipped, nothing deleted", async () => {
    const run = await runFlow(flow, spec, target(), { safety: true, cleanup: true, now: NOW });
    expect(t.requests).toEqual([]);
    expect(run.steps.map((s) => s.state)).toEqual(["skipped-safety", "skipped-safety", "skipped-safety", "skipped-safety"]);
    expect(run.outcome).toBe("stopped");
  });

  it("mock target ignores safety", async () => {
    const run = await runFlow(flow, spec, target({ name: "mock", headers: {}, secrets: [] }), { safety: true, cleanup: true, now: NOW });
    expect(run.steps.map((s) => s.state)).toEqual(["success", "success", "success", "cleaned"]);
  });

  it("401 stops with the token hint, then tears down what was created", async () => {
    fail["POST /repos/R/issues"] = 401;
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.outcome).toBe("failed");
    expect(run.steps.map((s) => s.state)).toEqual(["success", "failed", "pending", "cleaned"]);
    expect(run.steps[1]!.reason).toContain(FLOW_AUTH_HINT);
    expect(t.requests.at(-1)!.method).toBe("DELETE");
  });

  it("cleanup off keeps everything and lists leftovers", async () => {
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: false, now: NOW });
    expect(run.steps[3]!.state).toBe("pending");
    expect(run.leftovers.map((l) => l.stepId)).toEqual(["create_issue", "create_repo"]);
    expect(t.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("failed parent delete: the repo and its issue are both leftovers", async () => {
    fail["DELETE /repos/R"] = 403;
    const run = await runFlow(flow, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[3]!.state).toBe("leftover");
    expect(run.leftovers.map((l) => l.stepId)).toEqual(["create_issue", "create_repo"]);
  });

  it("a parent created in this flow is never taken from target params (C6)", async () => {
    const unlinked: Flow = { ...flow, steps: flow.steps.map((s) => s.id !== "create_issue" ? s : { ...s, inputs: s.inputs.map((i) =>
      i.slot === "path.repo" ? { slot: "path.repo", source: { kind: "empty" }, basis: "rule", createdBy: "create_repo" } : i) }) };
    const run = await runFlow(unlinked, spec, target({ params: { owner: "octo", repo: "prod-repo" } }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[1]!.state).toBe("stopped-empty");
    expect(run.steps[1]!.missing).toEqual(["path.repo"]);
    expect(t.requests.some((r) => r.path.includes("prod-repo"))).toBe(false);
    expect(run.steps[3]!.state).toBe("cleaned"); // 만든 repo는 그대로 지운다
  });

  it("DELETE of a resource this run did not create is refused even with safety off", async () => {
    const foreign: Flow = { ...flow, steps: [{ ...flow.steps[3]!, role: "main", inputs: [
      { slot: "path.owner", source: { kind: "empty" }, basis: "rule" }, { slot: "path.repo", source: { kind: "user", value: "prod-repo" }, basis: "user" }] }] };
    const run = await runFlow(foreign, spec, target(), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[0]!.state).toBe("skipped-safety");
    expect(run.steps[0]!.reason).toBe(NOT_CREATED);
    expect(t.requests).toEqual([]);
  });

  it("empty input stops the run and lists the slot", async () => {
    const run = await runFlow(flow, spec, target({ params: {} }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[1]!.state).toBe("stopped-empty");
    expect(run.steps[1]!.missing).toEqual(["path.owner"]);
    expect(run.outcome).toBe("stopped");
    expect(run.steps[3]!.state).toBe("leftover"); // delete_repo also needs owner → cannot tear down
  });

  it("network failure marks the step failed and never throws", async () => {
    const run = await runFlow(flow, spec, target({ baseUrl: "http://127.0.0.1:1" }), { safety: false, cleanup: true, now: NOW });
    expect(run.steps[0]!.state).toBe("failed");
    expect(run.outcome).toBe("failed");
  });
});
```

  Run: `pnpm exec vitest run packages/core/test/flowRun.test.ts` → fails: cannot find module `../src/flow/run.js`.

- [ ] **Step 6: export the record helpers.** In `packages/core/src/record/index.ts`, add `export` to `NORMAL_CONTRACT` (line 15), `maskValues` (47), `maskBody` (57) and `recordedHeaders` (84). Change the parameter `target: Target` of `recordedHeaders` to `target: Pick<Target, "headers" | "secrets">`. Behaviour is unchanged. Run: `pnpm exec vitest run packages/core/test/record.test.ts packages/core/test/recordService.test.ts` → pass.

- [ ] **Step 7: implement the runner.** Create `packages/core/src/flow/run.ts`:

```ts
import { maskSecrets, redactSecrets } from "../ingest/mask.js";
import { MAX_RECORD_BYTES, NORMAL_CONTRACT, maskBody, maskValues, recordedHeaders } from "../record/index.js";
import { applyParams } from "../record/target.js";
import type { Contract, Feature, MockSpec } from "../types.js";
import { makeAjv } from "../util/ajv.js";
import { joinUrl, runContract } from "../verify/contracts.js";
import type { FlowRun, FlowTargetName, Leftover, StepResult } from "./runTypes.js";
import type { Flow, FlowStep } from "./types.js";

export const FLOW_AUTH_HINT = "토큰과 권한 범위(scope)를 확인하세요.";
export const NOT_CREATED = "이번 실행이 만든 자원이 아니라 삭제하지 않았습니다.";
export const CLEANUP_OFF = "정리를 끈 실행이라 남겨 두었습니다.";
export const NO_DELETE = "삭제 기능이 흐름에 없어 남았습니다.";
export const CANCELLED = "취소되었습니다.";
export const CANCELLED_CREATE = "취소되었습니다. 응답을 받지 못해 서버에 만들어졌는지 알 수 없어 삭제하지 못했습니다.";
export const CANCELLED_NOT_RUN = "취소되어 실행하지 않았습니다.";
export const CANCELLED_LEFT = "취소되어 삭제하지 않았습니다.";
export const SAFETY_SKIP = "안전장치가 켜져 있어 보내지 않았습니다(GET만 보냄).";
const NAME_SLOTS = new Set(["body.name", "body.title"]);
const SAFE = new Set(["GET", "HEAD"]);

export interface FlowTarget {
  name: FlowTargetName;
  baseUrl: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  timeoutMs: number;
  secrets: string[];
}
export interface RunFlowOptions { safety: boolean; cleanup: boolean; signal?: AbortSignal; now?: () => Date }

const pad = (n: number) => String(n).padStart(2, "0");
export function runSuffix(d: Date): string {
  return `-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
function pick(body: unknown, field: string): unknown {
  let v: unknown = body;
  for (const k of field.split(".")) { if (!v || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
}
const lastPathInput = (s: FlowStep) => s.inputs.filter((i) => i.slot.startsWith("path.")).at(-1);

interface Created { stepId: string; resource: string; url: string; id: string | null }

/** 흐름 하나를 대상 하나에 실행한다(설계 §3). 예외를 던지지 않는다(취소 제외). 결과는 마스킹을 마친 값이다. */
export async function runFlow(flow: Flow, spec: MockSpec, target: FlowTarget, opts: RunFlowOptions): Promise<FlowRun> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const suffix = runSuffix(started);
  const mask = (s: string) => maskSecrets(redactSecrets(s, target.secrets));
  const ajv = makeAjv();
  const features = new Map(spec.features.map((f) => [f.id, f]));
  const responses = new Map<string, unknown>();
  const results = new Map<string, StepResult>(flow.steps.map((s) => [s.id, blank(s)]));
  const created: Created[] = [];
  const guarded = target.name === "real" && opts.safety;
  let halt: string | null = null;

  function blank(s: FlowStep): StepResult {
    return { stepId: s.id, featureId: s.featureId, role: s.role, state: "pending", reason: null, missing: [], request: null, response: null, schemaErrors: [], values: {}, durationMs: 0 };
  }
  function contractFor(featureId: string): Contract | undefined {
    const cs = spec.contracts.filter((c) => c.featureId === featureId);
    return cs.find((c) => c.name === NORMAL_CONTRACT) ?? cs[0];
  }

  /** signal: 요청을 끊는 신호. 정리 요청에는 이미 취소된 신호를 넘기지 않는다(시간 제한은 유지). */
  async function exec(step: FlowStep, signal: AbortSignal | undefined): Promise<StepResult> {
    const r = blank(step);
    const feature = features.get(step.featureId);
    const c = contractFor(step.featureId);
    if (!feature || !c) return { ...r, state: "failed", reason: `기능 없음: ${step.featureId}` };
    const values: Record<string, unknown> = {};
    for (const input of step.inputs) {
      const src = input.source;
      if (src.kind === "step") {
        const dep = results.get(src.step);
        if (dep?.state === "skipped-safety") return { ...r, state: "skipped-safety", reason: `앞 단계 ${src.step}이(가) 건너뛰어져 값이 없습니다.` };
        const v = responses.has(src.step) ? pick(responses.get(src.step), src.field) : undefined;
        if (v === undefined || v === null) r.missing.push(input.slot); else values[input.slot] = v;
      } else if (src.kind === "empty") {
        const name = input.slot.slice(5);
        // params는 이 흐름이 만들지 않는 경로 변수만 채운다. createdBy가 있으면 앞 단계가 만든 자원을 연결해야 한다(C6).
        if (input.slot.startsWith("path.") && !input.createdBy && Object.hasOwn(target.params, name)) values[input.slot] = target.params[name];
        else r.missing.push(input.slot);
      } else {
        values[input.slot] = step.creates && NAME_SLOTS.has(input.slot) && typeof src.value === "string" ? src.value + suffix : src.value;
      }
    }
    if (guarded && !SAFE.has(feature.method)) return { ...r, state: "skipped-safety", reason: SAFETY_SKIP, missing: [] };
    if (feature.method === "DELETE") {
      const last = lastPathInput(step);
      const ok = last?.source.kind === "step" && created.some((x) => x.stepId === (last.source as { step: string }).step);
      if (!ok) return { ...r, state: "skipped-safety", reason: NOT_CREATED, missing: [] };
    }
    if (r.missing.length > 0) return { ...r, state: "stopped-empty", reason: `입력이 비어 있습니다: ${r.missing.join(", ")}` };

    let p = feature.path;
    for (const [slot, v] of Object.entries(values)) if (slot.startsWith("path.")) p = p.split(`{${slot.slice(5)}}`).join(encodeURIComponent(String(v)));
    const { query } = applyParams(feature, c, target.params);
    const bodyEntries = Object.entries(values).filter(([s]) => s.startsWith("body."));
    const body = feature.request.body === null ? null : Object.fromEntries(bodyEntries.map(([s, v]) => [s.slice(5), v]));
    const t0 = Date.now();
    const run = await runContract(target.baseUrl, c, { headers: target.headers, timeoutMs: target.timeoutMs, signal, ajv, maxBytes: MAX_RECORD_BYTES, path: p, query, body });
    r.durationMs = Date.now() - t0;
    r.values = maskValues(values, mask, target.secrets) as StepResult["values"];
    r.request = {
      method: c.request.method,
      url: mask(run.url || joinUrl(target.baseUrl, p).toString()),
      headers: recordedHeaders(c.request.headers, target),
      body: body === null ? null : (maskValues(body, mask, target.secrets) as StepResult["values"]),
    };
    const shown = run.kind ? maskBody(run.kind, run.body, mask, target.secrets) : null;
    r.response = { status: run.status, kind: shown?.kind ?? run.kind, body: (shown?.body ?? null) as StepResult["values"][string] };
    if (run.failure || run.status === null || run.status < 200 || run.status > 299) {
      const auth = run.status === 401 || run.status === 403 || run.status === 404 ? ` ${FLOW_AUTH_HINT}` : "";
      return { ...r, state: "failed", reason: mask(run.failure ? run.failure.message : `status ${run.status}`) + auth };
    }
    if (run.kind === "json") responses.set(step.id, run.body);
    if (step.creates) {
      const b = (run.kind === "json" ? run.body : null) as Record<string, unknown> | null;
      const id = b && (typeof b.id === "string" || typeof b.number === "number" || typeof b.id === "number") ? String(b.id ?? b.number) : null;
      created.push({ stepId: step.id, resource: step.creates, url: mask(typeof b?.url === "string" ? b.url : run.url), id });
    }
    const errs = run.errors.map(mask);
    return errs.length > 0 ? { ...r, state: "diff", schemaErrors: errs, reason: errs[0]! } : { ...r, state: "success" };
  }

  let cancelled = false;
  for (const step of flow.steps) {
    if (step.role === "cleanup") continue;
    if (cancelled || opts.signal?.aborted) { cancelled = true; results.set(step.id, { ...blank(step), reason: CANCELLED_NOT_RUN }); continue; }
    if (halt) { results.set(step.id, { ...blank(step), reason: halt }); continue; }
    let r: StepResult;
    try { r = await exec(step, opts.signal); } catch (e) {
      r = opts.signal?.aborted
        ? { ...blank(step), state: "failed", reason: step.creates ? CANCELLED_CREATE : CANCELLED }
        : { ...blank(step), state: "failed", reason: mask((e as Error).message) };
    }
    results.set(step.id, r);
    if (opts.signal?.aborted) cancelled = true;
    else if (r.state === "failed" || r.state === "stopped-empty") halt = `앞 단계 ${step.id}에서 멈췄습니다.`;
  }
  if (opts.signal?.aborted) cancelled = true;

  const cleanupSteps = flow.steps.filter((s) => s.role === "cleanup");
  const handled = new Set<string>();
  const reasons = new Map<string, string>(); // 만든 단계 id → 남은 이유
  let interrupted = false;                   // 정리 도중 취소가 왔다
  const cleaned = new Set<string>();         // 이번 실행에서 지운 자원을 만든 단계 id
  for (const res of [...created].reverse()) {
    if (!opts.cleanup) { reasons.set(res.stepId, CLEANUP_OFF); continue; }
    const del = cleanupSteps.find((s) => { const l = lastPathInput(s); return l?.source.kind === "step" && l.source.step === res.stepId; });
    if (!del) { reasons.set(res.stepId, NO_DELETE); continue; }
    handled.add(del.id);
    // 정리 도중 취소가 오면 이미 보낸 요청만 끝내고 나머지는 남은 자원으로 적는다. 이미 취소된 채 시작한 정리는 끝까지 간다.
    if (!cancelled && opts.signal?.aborted) { interrupted = true; }
    if (interrupted) { results.set(del.id, { ...blank(del), state: "leftover", reason: CANCELLED_LEFT }); reasons.set(res.stepId, CANCELLED_LEFT); continue; }
    let r: StepResult;
    try { r = await exec(del, undefined); } catch (e) { r = { ...blank(del), state: "failed", reason: mask((e as Error).message) }; }
    if (r.state === "success" || r.state === "diff") { results.set(del.id, { ...r, state: "cleaned" }); cleaned.add(res.stepId); }
    else { results.set(del.id, { ...r, state: "leftover" }); reasons.set(res.stepId, r.reason ?? "삭제에 실패했습니다."); }
  }
  if (opts.cleanup) for (const s of cleanupSteps) if (!handled.has(s.id)) results.set(s.id, { ...blank(s), state: "skipped-safety", reason: NOT_CREATED });

  // 상위 자원을 지우면 하위 자원도 지워진다(GitHub: repo 삭제 → issue 삭제). 상위(조상)를 지운 자원은 남은 자원으로 적지 않는다.
  const stepById = new Map(flow.steps.map((s) => [s.id, s]));
  const createdIds = new Set(created.map((c) => c.stepId));
  const parents = (id: string): string[] => (stepById.get(id)?.inputs ?? []).flatMap((i) =>
    i.slot.startsWith("path.") && i.source.kind === "step" && i.source.step !== id && createdIds.has(i.source.step) ? [i.source.step] : []);
  const goneWithParent = (id: string, seen = new Set<string>()): boolean =>
    parents(id).some((p) => !seen.has(p) && (seen.add(p), cleaned.has(p) || goneWithParent(p, seen)));
  const leftovers: Leftover[] = [];
  for (const res of [...created].reverse()) {
    const reason = reasons.get(res.stepId);
    if (reason === undefined || goneWithParent(res.stepId)) continue;
    leftovers.push({ resource: res.resource, stepId: res.stepId, url: res.url, id: res.id, reason });
  }

  const steps = flow.steps.map((s) => results.get(s.id)!);
  const has = (...st: StepResult["state"][]) => steps.some((s) => st.includes(s.state));
  const outcome = cancelled || interrupted ? "cancelled" : has("failed") ? "failed" : has("stopped-empty", "skipped-safety") && steps.some((s) => s.role !== "cleanup" && (s.state === "stopped-empty" || s.state === "skipped-safety")) ? "stopped" : has("diff") ? "diff" : "success";
  return { flowId: flow.id, target: target.name, startedAt: started.toISOString(), finishedAt: now().toISOString(), safety: opts.safety, cleanup: opts.cleanup, suffix, outcome, error: null, steps, leftovers };
}
```

  Three behaviours the tests pin, so keep them:
  - Leftovers are built after the teardown loop, because a child (`create_issue`) is visited before its parent (`create_repo`) and only the parent's delete result decides whether the child is gone. A parent is found through the child step's path inputs (`create_issue`'s `path.repo` points at `create_repo`), not through `createdBy`, so a value the user typed (not linked) never makes a resource look deleted.
  - The "failed parent delete" case sets the delete step to `leftover`, but its 403 does not change the outcome. `has("failed")` only sees `failed` states, and teardown results become `leftover`, so the outcome stays `success`. The test does not check the outcome; leave it as is.
  - In the "empty input" case the teardown `delete_repo` step needs `path.owner` as well. `exec` returns `stopped-empty`, so the step becomes `leftover`, as the test expects.
  
  The safety case: `create_repo` is skipped by safety. `create_issue` gets `skipped-safety` because its `path.repo` comes from a skipped step. `get_issue` is skipped for the same reason. `delete_repo` is never reached, because `created` is empty, so it becomes `skipped-safety` with `NOT_CREATED`. That matches the expected `["skipped-safety" ×4]`. Note that the dependency check runs before the safety check, so `get_issue` (a GET) is still skipped.

- [ ] **Step 7b: add the review's missing tests (#39).** Append these cases to `flowRun.test.ts` (final code is in the file; each was checked to fail under its mutant of `run.ts`):
  - DELETE scope: a DELETE whose last path input is a `step` source on a non-creating step (`get_issue`), or on a creating step that has not run, is `skipped-safety` with `NOT_CREATED` and sends no DELETE; a failed create halts the run, so a later DELETE stays `pending`.
  - Step order (decision 14): real target, safety on, `params: {}`: a POST step with an empty `path.owner` is `skipped-safety` with `missing: []`, never `stopped-empty`. A step skipped because its dependency was skipped also returns `missing: []` (fix in `exec`).
  - Masking: tokens (`ghp_…`, `github_pat_…`) echoed in 2xx bodies, user input, URL, a raw 401 body, a JSON 401 body and a failure reason (token in the base URL userinfo) never appear in `JSON.stringify(run)`. `flowRunService.test.ts` checks the saved `flow-runs/…/real.json` the same way.
  - Schema mismatch: the step is `diff`, later steps run, outcome `diff`.
  - Teardown order: with `delete_issue` listed after `delete_repo`, the issue is deleted first, then the repo.

- [ ] **Step 7c: cancel cleans up and saves (user decision 17, #39).** A cancel (abort signal) is a failure of the run, not an exception. `runFlow` stops sending steps (unsent ones stay `pending` with `CANCELLED_NOT_RUN`), marks the in-flight step `failed` with `CANCELLED` (a create: `CANCELLED_CREATE`, because its response is unknown the run cannot delete it and has no id to list), runs the teardown under the same rules, and returns outcome `cancelled`. Teardown requests get `signal: undefined` (the per-request timeout stays), so the aborted signal does not cancel them. A cancel during teardown lets the request already sent finish; the rest become `leftover` steps and leftovers with `CANCELLED_LEFT`. `runFlowTargets` saves the cancelled run and skips the remaining targets. Tests in `flowRun.test.ts` (`describe("cancel …")`): cancel between two steps (a `fetch` spy aborts after the first response is read), cancel in flight (the stub delays the response), cleanup off, cancel during teardown, no token in the result; `flowRunService.test.ts`: the cancelled run is saved without the token and the next target is not run. Each failed before the change (the runner threw `AbortError`).

- [ ] **Step 8: run, pass.** `pnpm exec vitest run packages/core/test/flowRun.test.ts` → 23 passed.

- [ ] **Step 9: commit.** `git add packages/core/src/flow packages/core/src/record/index.ts packages/core/test/flowRun.test.ts && git commit -m "feat(core): run flows step by step with safety, value passing and teardown"`

- [ ] **Step 10: run storage, failing test.** Append to `packages/core/test/flowStore.test.ts`:

```ts
import { readFlowRun, writeFlowRun, flowRunName } from "../src/flow/store.js";
import type { FlowRun } from "../src/flow/runTypes.js";

describe("flow run files", () => {
  it("one file per flow and target under flow-runs/", async () => {
    const run: FlowRun = { flowId: "issues", target: "mock", startedAt: "2026-11-26T01:02:03.000Z", finishedAt: "2026-11-26T01:02:04.000Z", safety: true, cleanup: true, suffix: "-20261126010203", outcome: "success", error: null, steps: [], leftovers: [] };
    expect(flowRunName("issues", "mock")).toBe("flow-runs/issues/mock.json");
    expect(await readFlowRun(ws, "gh", "issues", "mock")).toBeNull();
    await writeFlowRun(ws, "gh", run);
    expect(await readFlowRun(ws, "gh", "issues", "mock")).toEqual(run);
  });
});
```

  Run: `pnpm exec vitest run packages/core/test/flowStore.test.ts` → fails: no export `readFlowRun`.

- [ ] **Step 11: implement.** Add to `packages/core/src/flow/store.ts`:

```ts
import { FlowRunSchema, type FlowRun, type FlowTargetName } from "./runTypes.js";

export const FLOW_RUNS_DIR = "flow-runs";
export const flowRunName = (flowId: string, target: FlowTargetName) => `${FLOW_RUNS_DIR}/${flowId}/${target}.json`;

export async function readFlowRun(ws: Workspace, system: string, flowId: string, target: FlowTargetName): Promise<FlowRun | null> {
  const name = flowRunName(flowId, target);
  return (await ws.exists(system, name)) ? ws.read(system, name, FlowRunSchema) : null;
}

export async function writeFlowRun(ws: Workspace, system: string, run: FlowRun): Promise<string> {
  return ws.write(system, flowRunName(run.flowId, run.target), FlowRunSchema, run);
}
```

  `flowId` already matches `FLOW_ID`, so it cannot escape the directory. `ws.write` runs `mkdir(path.dirname(file), { recursive: true })` (`src/workspace.ts:61-69`), so `flow-runs/<id>/` is created. Extend `flow/index.ts`: `export * from "./runTypes.js"; export { runFlow, runSuffix, FLOW_AUTH_HINT, NOT_CREATED, CLEANUP_OFF, NO_DELETE, SAFETY_SKIP, type FlowTarget, type RunFlowOptions } from "./run.js";` plus the store exports above. Run the store test → pass.

- [ ] **Step 12: service, failing test.** Create `packages/core/test/flowRunService.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFlows } from "../src/flow/store.js";
import { readFlowRun } from "../src/flow/store.js";
import { runFlowTargets } from "../src/service/flowRun.js";
import { MockSpecSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { startFakeTarget, type FakeTarget } from "./fakeTarget.js";

let dir: string; let ws: Workspace; let api: FakeTarget;
const spec = MockSpecSchema.parse({ system: "s", baseUrl: "http://x", notMocked: [], assumptions: [],
  features: [{ id: "t_create", group: "g", title: "", summary: "", method: "POST", path: "/tickets", request: { params: {}, query: {}, headers: {}, body: { type: "object" } }, responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], fixtures: [{ status: 201, body: { id: 1 }, source: "empty" }] }],
  contracts: [{ featureId: "t_create", name: "정상 요청", request: { method: "POST", path: "/tickets", headers: {}, query: {}, body: {} }, expect: { status: 201, schema: null } }] });
const flows = { system: "s", catalogHash: "h", inferredAt: "t", notes: [], flows: [{ id: "tickets", name: "ticket 다루기", resource: "ticket", steps: [{ id: "create_ticket", featureId: "t_create", role: "main" as const, creates: "ticket", inputs: [] }] }] };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "specmock-flowrun-")); ws = new Workspace(path.join(dir, ".specmock"));
  api = await startFakeTarget(() => ({ status: 201, body: { id: 1 } }));
  await ws.write("s", "mockspec.json", MockSpecSchema, spec);
  await writeFlows(ws, "s", flows);
});
afterEach(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

describe("runFlowTargets", () => {
  it("mock uses the launcher; real uses target.json; both runs are saved", async () => {
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url, headers: { authorization: "Bearer ${TOKEN}" } }));
    let stopped = false;
    const out = await runFlowTargets(ws, "s", "tickets", {
      targets: ["mock", "real"], cleanup: true, safety: false, env: { TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123" },
      launchMock: async () => ({ baseUrl: api.url, stop: async () => { stopped = true; } }),
    });
    expect(out.runs.map((r) => [r.target, r.outcome])).toEqual([["mock", "success"], ["real", "success"]]);
    expect(stopped).toBe(true);
    expect(api.requests[1]!.headers.authorization).toBe("Bearer ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(api.requests[0]!.headers.authorization).toBeUndefined(); // mock gets no real token
    expect((await readFlowRun(ws, "s", "tickets", "real"))!.outcome).toBe("success");
  });
  it("mock launch failure fails only the mock run", async () => {
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url }));
    const out = await runFlowTargets(ws, "s", "tickets", { targets: ["mock", "real"], cleanup: true, safety: false, env: {}, launchMock: async () => { throw new Error("npm install failed"); } });
    expect(out.runs[0]).toMatchObject({ target: "mock", outcome: "failed", error: expect.stringContaining("mock을 먼저 만드세요") });
    expect(out.runs[1]!.outcome).toBe("success");
  });
  it("real without a token fails only the real run", async () => {
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: api.url, headers: { authorization: "Bearer ${TOKEN}" } }));
    const out = await runFlowTargets(ws, "s", "tickets", { targets: ["real"], cleanup: true, safety: false, env: {} });
    expect(out.runs[0]).toMatchObject({ target: "real", outcome: "failed", error: expect.stringContaining("TOKEN") });
  });
  it("unknown flow and missing features throw", async () => {
    await expect(runFlowTargets(ws, "s", "nope", { targets: ["mock"], cleanup: true, safety: true, env: {} })).rejects.toThrow(/알 수 없는 흐름/);
    await ws.write("s", "mockspec.json", MockSpecSchema, { ...spec, features: [], contracts: [] });
    await expect(runFlowTargets(ws, "s", "tickets", { targets: ["mock"], cleanup: true, safety: true, env: {} })).rejects.toThrow(/기능 없음: t_create/);
  });
});
```

  (`Feature.request.body` is a JSON Schema or null, `src/types.ts:35`; `MockFeatureSchema` adds `fixtures` min 1, `:152-154`; `FixtureSchema` `:98-102`.) Run: `pnpm exec vitest run packages/core/test/flowRunService.test.ts` → fails: missing module.

- [ ] **Step 13: implement the service.** Create `packages/core/src/service/flowRun.ts`:

```ts
import { defaultMockDir, generate } from "../generate/index.js";
import { readLock } from "../generate/lock.js";
import { runFlow, type FlowTarget } from "../flow/run.js";
import type { FlowRun, FlowTargetName } from "../flow/runTypes.js";
import { missingFeatures, readFlows, writeFlowRun } from "../flow/store.js";
import { readTarget, DEFAULT_TIMEOUT_MS } from "../record/target.js";
import { MockSpecSchema } from "../types.js";
import { startMock } from "../verify/server.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

export interface LaunchedMock { baseUrl: string; stop: () => Promise<void> }
export type LaunchMock = (ws: Workspace, system: string, opts: { mockDir: string; signal?: AbortSignal; onEvent?: OnEvent }) => Promise<LaunchedMock>;

export interface RunFlowTargetsOptions {
  targets: FlowTargetName[];
  cleanup: boolean;
  /** 서버가 요청 시점에 읽은 안전장치 값. real에만 적용된다. */
  safety: boolean;
  env: Record<string, string | undefined>;
  mockDir?: string;
  signal?: AbortSignal;
  onEvent?: OnEvent;
  /** 테스트용. 기본은 TS mock 생성 → 기동. */
  launchMock?: LaunchMock;
}

/** 기본 mock 기동: TS mock을 (LLM 없이) 생성하고 띄운다. 생성기 동작은 바꾸지 않는다. */
export const launchTsMock: LaunchMock = async (ws, system, { mockDir, signal, onEvent }) => {
  await generate(ws, system, { outDir: mockDir, language: "ts", signal });
  const lock = await readLock(mockDir);
  if (!lock) throw new Error(`${mockDir}: specmock.lock.json이 없습니다.`);
  const server = await startMock(mockDir, lock, { signal, onLog: (m) => onEvent?.({ stage: "flow", message: m }) });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: server.stop };
};

function failedRun(flowId: string, target: FlowTargetName, safety: boolean, cleanup: boolean, error: string): FlowRun {
  const at = new Date().toISOString();
  return { flowId, target, startedAt: at, finishedAt: at, safety, cleanup, suffix: "", outcome: "failed", error, steps: [], leftovers: [] };
}

/** 흐름을 고른 대상에 차례로 실행하고 대상별 결과를 flow-runs/에 쓴다. 한 대상의 실패가 다른 대상을 막지 않는다. */
export async function runFlowTargets(ws: Workspace, system: string, flowId: string, opts: RunFlowTargetsOptions): Promise<{ runs: FlowRun[] }> {
  const file = await readFlows(ws, system);
  const flow = file?.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`알 수 없는 흐름: ${flowId}`);
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const missing = missingFeatures(flow, new Set(spec.features.map((f) => f.id)));
  if (missing.length > 0) throw new Error(`기능 없음: ${missing.join(", ")} (기능 선택이 바뀌었습니다. 흐름을 다시 추론하세요)`);
  const runs: FlowRun[] = [];
  for (const name of opts.targets) {
    opts.onEvent?.({ stage: "flow", message: `${flow.name}: ${name} 실행` });
    let run: FlowRun;
    if (name === "mock") {
      let mock: LaunchedMock | null = null;
      try {
        mock = await (opts.launchMock ?? launchTsMock)(ws, system, { mockDir: opts.mockDir ?? defaultMockDir(system), signal: opts.signal, onEvent: opts.onEvent });
        const params = await readTarget(ws, system, opts.env).then((t) => t.params, () => ({}));
        const target: FlowTarget = { name, baseUrl: mock.baseUrl, headers: {}, params, timeoutMs: DEFAULT_TIMEOUT_MS, secrets: [] };
        run = await runFlow(flow, spec, target, { safety: opts.safety, cleanup: opts.cleanup, signal: opts.signal });
      } catch (e) {
        run = opts.signal?.aborted ? failedRun(flowId, name, opts.safety, opts.cleanup, "취소되었습니다. mock을 띄우는 중이었습니다.", "cancelled")
          : failedRun(flowId, name, opts.safety, opts.cleanup, `mock을 띄우지 못했습니다. mock을 먼저 만드세요: ${(e as Error).message}`);
      } finally { await mock?.stop(); }
    } else {
      try {
        const t = await readTarget(ws, system, opts.env);
        run = await runFlow(flow, spec, { name, baseUrl: t.baseUrl, headers: t.headers, params: t.params, timeoutMs: t.timeoutMs, secrets: t.secrets }, { safety: opts.safety, cleanup: opts.cleanup, signal: opts.signal });
      } catch (e) {
        run = failedRun(flowId, name, opts.safety, opts.cleanup, opts.signal?.aborted ? "취소되었습니다." : (e as Error).message, opts.signal?.aborted ? "cancelled" : "failed");
      }
    }
    await writeFlowRun(ws, system, run);
    runs.push(run);
    if (run.outcome === "cancelled") break; // 취소하면 남은 대상은 실행하지 않는다.
  }
  return { runs };
}
```

  Mock-side params: when `readTarget` fails (for example a missing token), the mock run uses no params. The flow then stops at `stopped-empty` for `path.owner` and shows "입력 필요". It does not fail. This matches spec §5 "토큰이나 주소가 없음 → 실제 실행만 막고 mock 실행은 허용". `readTarget`'s messages name only the env variable, never its value (`record/target.ts:53-60`), so they are safe to store.

  Add to `packages/core/src/service/index.ts`: `export { runFlowTargets, launchTsMock, type LaunchMock, type LaunchedMock, type RunFlowTargetsOptions } from "./flowRun.js";`.

- [ ] **Step 14: run, pass, full gate.** `pnpm exec vitest run packages/core/test/flowRunService.test.ts` → 4 passed. `pnpm typecheck && pnpm test` → all green. `snapshot.test.ts` and `golden.test.ts` are unchanged; the generators were not touched.

- [ ] **Step 15: commit.** `git add -A packages/core && git commit -m "feat(core): run a flow on mock and real targets and save per-target results"`

---

### Task 5: ui-server flow routes, safety switch, two MCP tools

**Files:**
- Create: `packages/core/src/flow/view.ts` (summaries and details shared by ui-server and MCP), `packages/core/src/flow/baseUrl.ts` (`suggestedBaseUrl`)
- Modify: `packages/core/src/flow/index.ts` (exports)
- Create: `packages/ui-server/src/safety.ts`
- Modify: `packages/ui-server/src/app.ts:6` (imports), `:17-25` (body schemas), after `:96` (`GET /feature-groups`), after `:212` (flow routes), `:154-170` (`targetInfo` adds `suggestedBaseUrl`)
- Modify: `packages/ui-server/src/security.ts:20` (`POST_ONLY`), `packages/ui-server/src/jobs.ts:20` (`CANCELLABLE.flow`), `packages/ui-server/src/api-types.ts:29,35-50,71` (`FeatureGroups`, `TargetInfo.suggestedBaseUrl`, `JobKind` + `"flow"`, flow view types)
- Create: `packages/mcp/src/tools/flow.ts`
- Modify: `packages/mcp/src/names.ts:2-5` (+ `list_flows`, `fill_flow`), `packages/mcp/src/createServer.ts:4-6,15` (register)
- Modify: `packages/mcp/test/tools.test.ts:23,26,209,215` (13 → 15), `packages/mcp/test/plugin.test.ts:24` (regex suffix `flows?`), `plugin/skills/specmock/SKILL.md` (document the two tools)
- Test: `packages/core/test/flowView.test.ts`, `packages/ui-server/test/flows.test.ts`, `packages/mcp/test/flow.test.ts`

- [ ] **Step 1: failing core view tests.** Create `packages/core/test/flowView.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestedBaseUrl } from "../src/flow/baseUrl.js";
import { writeFlowRun, writeFlows } from "../src/flow/store.js";
import { flowDetail, flowSummaries } from "../src/flow/view.js";
import { MockSpecSchema, SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";

let dir: string; let ws: Workspace;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-view-")); ws = new Workspace(path.join(dir, ".specmock")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const flows = { system: "s", catalogHash: "h", inferredAt: "2026-11-26T00:00:00.000Z", notes: ["n"], flows: [{ id: "issues", name: "issue 다루기", resource: "issue", steps: [
  { id: "create_issue", featureId: "issues_create", role: "main" as const, creates: "issue", inputs: [
    { slot: "path.owner", source: { kind: "empty" as const }, basis: "rule" as const }, { slot: "body.title", source: { kind: "empty" as const }, basis: "rule" as const }] },
  { id: "get_issue", featureId: "issues_get", role: "main" as const, inputs: [] }] }] };
const feature = (id: string) => ({ id, group: "g", title: "", summary: "", method: "GET", path: "/x", request: { params: {}, query: {}, headers: {}, body: null }, responses: {}, auth: "none", provenance: "openapi", confidence: 1, hasExample: false, evidence: [], notes: [], fixtures: [{ status: 200, body: null, source: "empty" }] });

describe("flow views", () => {
  it("no flows.json → inferredAt null and an empty list", async () => {
    expect(await flowSummaries(ws, "s")).toEqual({ inferredAt: null, notes: [], flows: [] });
  });
  it("summaries count empty inputs (minus target params), missing features, last outcome per target", async () => {
    await writeFlows(ws, "s", flows);
    await ws.write("s", "mockspec.json", MockSpecSchema, MockSpecSchema.parse({ system: "s", baseUrl: "", notMocked: [], assumptions: [], contracts: [], features: [feature("issues_create")] }));
    await writeFile(ws.file("s", "target.json"), JSON.stringify({ baseUrl: "https://api.github.com", params: { owner: "octo" } }));
    await writeFlowRun(ws, "s", { flowId: "issues", target: "mock", startedAt: "a", finishedAt: "b", safety: true, cleanup: true, suffix: "", outcome: "diff", error: null, steps: [], leftovers: [] });
    expect(await flowSummaries(ws, "s")).toEqual({ inferredAt: "2026-11-26T00:00:00.000Z", notes: ["n"], flows: [
      { id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: ["issues_get"], last: { mock: "diff", real: null } }] });
    const d = await flowDetail(ws, "s", "issues");
    expect(d.empty).toEqual(["create_issue:body.title"]);
    expect(d.runs.mock!.outcome).toBe("diff");
    await expect(flowDetail(ws, "s", "nope")).rejects.toThrow(/알 수 없는 흐름: nope/);
  });
  it("suggestedBaseUrl reads servers[0] (v3) or scheme+host+basePath (v2) from source.json", async () => {
    const put = (content: string) => ws.write("s", "source.json", SourceSchema, { system: "s", inputs: [{ kind: "openapi", origin: "x", fetchedAt: "t", contentHash: "h", content }] });
    await put("openapi: 3.0.3\nservers: [{ url: https://api.github.com/ }]\npaths: {}\n");
    expect(await suggestedBaseUrl(ws, "s")).toBe("https://api.github.com");
    await put(JSON.stringify({ swagger: "2.0", host: "petstore.swagger.io", basePath: "/v2", schemes: ["https"], paths: {} }));
    expect(await suggestedBaseUrl(ws, "s")).toBe("https://petstore.swagger.io/v2");
    await put("openapi: 3.0.3\nservers: [{ url: /relative }]\npaths: {}\n");
    expect(await suggestedBaseUrl(ws, "s")).toBeNull();
  });
});
```

  Run: `pnpm exec vitest run packages/core/test/flowView.test.ts` → fails: missing modules.

- [ ] **Step 2: implement views and base URL.** Create `packages/core/src/flow/view.ts`:

```ts
import { TARGET_FILE, TargetSchema } from "../record/target.js";
import { MockSpecSchema } from "../types.js";
import type { Workspace } from "../workspace.js";
import type { FlowRun, FlowRunOutcome } from "./runTypes.js";
import { emptySlots, missingFeatures, readFlowRun, readFlows } from "./store.js";
import type { Flow } from "./types.js";

export interface FlowSummary {
  id: string; name: string; resource: string; steps: number;
  /** 빈 입력 수(target.json params가 채우는 경로 변수 제외). */
  empty: number;
  /** 선택에서 빠진 기능 id. 하나라도 있으면 실행을 막고 "기능 없음"을 보인다. */
  missingFeatures: string[];
  last: { mock: FlowRunOutcome | null; real: FlowRunOutcome | null };
}
export interface FlowList { inferredAt: string | null; notes: string[]; flows: FlowSummary[] }
export interface FlowDetail { flow: Flow; empty: string[]; missingFeatures: string[]; runs: { mock: FlowRun | null; real: FlowRun | null } }

/** target.json의 params 원문(`${ENV}` 치환 없음). 빈 칸 세기에만 쓴다. 파일이 없거나 형식이 틀리면 빈 값. */
async function rawParams(ws: Workspace, system: string): Promise<Record<string, string>> {
  if (!(await ws.exists(system, TARGET_FILE))) return {};
  try { return (await ws.read(system, TARGET_FILE, TargetSchema)).params ?? {}; } catch { return {}; }
}
async function selectedIds(ws: Workspace, system: string): Promise<Set<string>> {
  if (!(await ws.exists(system, "mockspec.json"))) return new Set();
  return new Set((await ws.read(system, "mockspec.json", MockSpecSchema)).features.map((f) => f.id));
}

export async function flowSummaries(ws: Workspace, system: string): Promise<FlowList> {
  const file = await readFlows(ws, system);
  if (!file) return { inferredAt: null, notes: [], flows: [] };
  const params = await rawParams(ws, system);
  const ids = await selectedIds(ws, system);
  const flows: FlowSummary[] = [];
  for (const f of file.flows) {
    const [mock, real] = await Promise.all([readFlowRun(ws, system, f.id, "mock"), readFlowRun(ws, system, f.id, "real")]);
    flows.push({ id: f.id, name: f.name, resource: f.resource, steps: f.steps.length, empty: emptySlots(f, params).length,
      missingFeatures: missingFeatures(f, ids), last: { mock: mock?.outcome ?? null, real: real?.outcome ?? null } });
  }
  return { inferredAt: file.inferredAt, notes: file.notes, flows };
}

export async function flowDetail(ws: Workspace, system: string, flowId: string): Promise<FlowDetail> {
  const flow = (await readFlows(ws, system))?.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`알 수 없는 흐름: ${flowId}`);
  const [mock, real] = await Promise.all([readFlowRun(ws, system, flowId, "mock"), readFlowRun(ws, system, flowId, "real")]);
  return { flow, empty: emptySlots(flow, await rawParams(ws, system)), missingFeatures: missingFeatures(flow, await selectedIds(ws, system)), runs: { mock, real } };
}
```

  Create `packages/core/src/flow/baseUrl.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { SourceSchema } from "../types.js";
import type { Workspace } from "../workspace.js";

/** 등록 화면의 기본 주소: 첫 OpenAPI 입력의 servers[0].url(v3) 또는 schemes[0]://host+basePath(v2). 절대 http(s) URL이 아니면 null. */
export async function suggestedBaseUrl(ws: Workspace, system: string): Promise<string | null> {
  if (!(await ws.exists(system, "source.json"))) return null;
  const input = (await ws.read(system, "source.json", SourceSchema)).inputs.find((i) => i.kind === "openapi");
  if (!input) return null;
  let doc: Record<string, unknown>;
  try { doc = parseYaml(input.content) as Record<string, unknown>; } catch { return null; }
  const servers = doc?.servers as { url?: unknown }[] | undefined;
  let url: unknown = servers?.[0]?.url;
  if (url === undefined && typeof doc?.host === "string") {
    const scheme = (Array.isArray(doc.schemes) && typeof doc.schemes[0] === "string" ? doc.schemes[0] : "https");
    url = `${scheme}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`;
  }
  return typeof url === "string" && /^https?:\/\/[^/]/.test(url) ? url.replace(/\/+$/, "") : null;
}
```

  Export from `flow/index.ts`: `export { flowDetail, flowSummaries, type FlowDetail, type FlowList, type FlowSummary } from "./view.js"; export { suggestedBaseUrl } from "./baseUrl.js";`. Run: `pnpm exec vitest run packages/core/test/flowView.test.ts` → 3 passed.

- [ ] **Step 3: commit.** `git add -A packages/core && git commit -m "feat(core): flow summaries, details and the suggested base URL"`

- [ ] **Step 4: failing ui-server tests.** Create `packages/ui-server/test/flows.test.ts`. It reuses the `client()` pattern from `test/api.test.ts:22-31`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const GITHUB = path.join(REPO, "packages", "core", "test", "fixtures", "flow", "github-issues.yaml");
const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-flows-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function client() {
  const { app } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310 });
  const req = async (method: string, p: string, b?: unknown) => { const r = await app.request(`/api${p}`, { method, headers: HOST, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }); return { status: r.status, body: await r.json() }; };
  return { get: (p: string) => req("GET", p), post: (p: string, b: unknown = {}) => req("POST", p, b), put: (p: string, b: unknown) => req("PUT", p, b) };
}
async function registered() {
  const c = client();
  await c.post("/systems", { system: "gh", origins: [GITHUB] });
  await c.post("/systems/gh/analyze");
  const ids = (await c.get("/systems/gh/features")).body.data.rows.map((r: { id: string }) => r.id);
  await c.post("/systems/gh/selection", { ids });
  return c;
}

describe("flow routes", () => {
  it("infer → list → detail → fill an input", async () => {
    const c = await registered();
    expect((await c.get("/systems/gh/flows")).body.data).toEqual({ inferredAt: null, notes: [], flows: [] });
    const inf = await c.post("/systems/gh/flows/infer");
    expect(inf.status).toBe(200);
    const list = (await c.get("/systems/gh/flows")).body.data;
    expect(list.flows.map((f: { id: string }) => f.id)).toEqual(["repos", "issues"]);
    const d = (await c.get("/systems/gh/flows/issues")).body.data;
    expect(d.empty).toContain("create_issue:body.title");
    expect(d.empty).toContain("create_issue:path.repo"); // 앞 단계가 만드는 repo는 params로 채우지 않는다(C6)
    const set = await c.post("/systems/gh/flows/issues/inputs", { stepId: "create_issue", slot: "body.title", source: { kind: "user", value: "hello" } });
    expect(set.status).toBe(200);
    expect((await c.get("/systems/gh/flows/issues")).body.data.empty).not.toContain("create_issue:body.title");
    // repo를 한 번 연결하면 같은 repo를 쓰는 다른 단계의 빈 칸에도 퍼진다(setInput, Task 3)
    const link = await c.post("/systems/gh/flows/issues/inputs", { stepId: "create_issue", slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" } });
    expect(link.status).toBe(200);
    expect(link.body.data.empty.filter((e: string) => e.endsWith(":path.repo"))).toEqual([]);
    const bad = await c.post("/systems/gh/flows/issues/inputs", { stepId: "nope", slot: "body.title", source: { kind: "empty" } });
    expect(bad).toMatchObject({ status: 400, body: { ok: false, error: { code: "invalid" } } });
    expect((await c.get("/systems/gh/flows/nope")).status).toBe(404);
  });

  it("infer before selection is a 400 with the fix-it message", async () => {
    const c = client();
    await c.post("/systems", { system: "gh", origins: [GITHUB] });
    await c.post("/systems/gh/analyze");
    expect(await c.post("/systems/gh/flows/infer")).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("먼저 기능을 고르세요") } } });
  });

  it("safety switch: on by default, set off, back on after another system is viewed", async () => {
    const c = await registered();
    await c.post("/systems", { system: "other", origins: [GITHUB] });
    expect((await c.get("/systems/gh/safety")).body.data).toEqual({ on: true });
    expect((await c.post("/systems/gh/safety", { on: false })).body.data).toEqual({ on: false });
    expect((await c.get("/systems/gh/safety")).body.data).toEqual({ on: false });
    expect((await c.get("/systems/other/safety")).body.data).toEqual({ on: true });
    expect((await c.get("/systems/gh/safety")).body.data).toEqual({ on: true });
  });

  it("run: real without token/baseUrl is 409, missing features 409, mock-only is accepted", async () => {
    const c = await registered();
    await c.post("/systems/gh/flows/infer");
    await c.put("/systems/gh/target", { baseUrl: "https://api.github.com", headers: [{ name: "Authorization", value: "Bearer ${GITHUB_TOKEN}" }], params: [], features: {} });
    const real = await c.post("/systems/gh/flows/issues/run", { targets: ["real"] });
    expect(real).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining("mock 실행은 할 수 있어요") } } });
    expect((await c.post("/systems/gh/flows/issues/run", { targets: [] })).status).toBe(400);
    expect((await c.get("/systems/gh/flows/issues/run")).status).toBe(405);
    // 빈 선택은 select가 거부한다(select/index.ts:74). issue 기능만 빼서 issues 흐름의 기능을 없앤다.
    const ids = (await c.get("/systems/gh/features")).body.data.rows.map((r: { id: string }) => r.id).filter((id: string) => !id.startsWith("issues_"));
    await c.post("/systems/gh/selection", { ids });
    expect((await c.post("/systems/gh/flows/issues/run", { targets: ["mock"] })).status).toBe(409);
  });

  it("target info carries suggestedBaseUrl from the OpenAPI servers", async () => {
    const c = await registered();
    expect((await c.get("/systems/gh/target")).body.data).toMatchObject({ exists: false, suggestedBaseUrl: "https://api.github.com" });
  });

  it("feature-groups returns per-group totals and no rows; ?group= returns one group's rows", async () => {
    const c = client();
    await c.post("/systems", { system: "gh", origins: [GITHUB] });
    await c.post("/systems/gh/analyze");
    expect((await c.get("/systems/gh/feature-groups")).body.data).toEqual({ total: 8, groups: [{ group: "issues", total: 4 }, { group: "repos", total: 4 }] });
    const issues = (await c.get("/systems/gh/features?group=issues")).body.data;
    expect(issues.rows.map((r: { group: string }) => r.group)).toEqual(["issues", "issues", "issues", "issues"]);
  });
});
```

  Run: `pnpm build:core && pnpm exec vitest run packages/ui-server/test/flows.test.ts` → fails with 404 for the new routes. (The `PUT /target` body follows `TargetPutBodySchema`, `src/targetView.ts:47-57`: `headers`/`params` are `{ name, value? , keep? }[]`, `features` a record of the same.)

- [ ] **Step 5: safety store.** Create `packages/ui-server/src/safety.ts`:

```ts
/** 안전장치(실제 서버에 GET만 보냄) 상태. 메모리에만 두고 서버를 다시 켜거나 다른 서비스를 보면 켜진다(설계 §3). */
export class SafetyStore {
  private system: string | null = null;
  private on = true;
  get(system: string): boolean {
    if (this.system !== system) { this.system = system; this.on = true; }
    return this.on;
  }
  set(system: string, on: boolean): boolean {
    this.system = system; this.on = on;
    return on;
  }
}
```

- [ ] **Step 6: routes.** In `packages/ui-server/src/app.ts`:
  - Add the imports `flowDetail, flowSummaries, inferFlowsForSystem, readFlows, writeFlows, setInput, runFlowTargets, missingFeatures, FlowSourceSchema, FlowTargetName, suggestedBaseUrl` from `@specmock/core`, and `SafetyStore` from `./safety.js`.
  - Add the body schemas:

```ts
const FlowInputBody = z.object({ stepId: z.string().min(1), slot: z.string().min(1), source: FlowSourceSchema });
const FlowRunBody = z.object({ targets: z.array(FlowTargetName).min(1).refine((t) => new Set(t).size === t.length, "대상이 겹칩니다"), cleanup: z.boolean().default(true) });
const SafetyBody = z.object({ on: z.boolean() });
const REAL_BLOCKED = "토큰이 없거나 실제 서버 주소가 비어 있어 실제 실행을 막았어요. mock 실행은 할 수 있어요.";
```

  - Inside `createApp`, after `const envStore = new EnvStore();`: `const safety = new SafetyStore();`
  - In `targetInfo`, add `suggestedBaseUrl: await suggestedBaseUrl(ws, system)` to all three return objects.
  - After the `GET /api/systems/:s/features` route (`:88-96`), add the group summary route. A big spec has 46 groups and 1,281 features (GitHub, Task 1), so the registration screen asks for these totals first and fetches one group's rows with the existing `?group=` only when the user opens or ticks that group:

```ts
  /** 묶음별 기능 수만 돌려준다. 행은 GET /features?group=<g>로 묶음 하나씩 받는다. 순서는 listFeatures의 묶음 이름순(catalog/order.ts:14-20). */
  app.get("/api/systems/:s/feature-groups", async (c) => {
    const r = await listFeatures(ws, c.req.param("s"));
    const totals = new Map<string, number>();
    for (const row of r.rows) totals.set(row.group, (totals.get(row.group) ?? 0) + 1);
    return ok(c, { total: r.total, groups: [...totals].map(([group, total]) => ({ group, total })) });
  });
```

  - After the `record/last` route, add:

```ts
  app.get("/api/systems/:s/flows", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    return ok(c, await flowSummaries(ws, system));
  });
  app.post("/api/systems/:s/flows/infer", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    try { return ok(c, await inferFlowsForSystem(ws, system)); } catch (e) {
      if (e instanceof Error && /먼저 기능을 고르세요/.test(e.message)) throw new InvalidRequest(e.message);
      throw e;
    }
  });
  app.get("/api/systems/:s/flows/:id", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    try { return ok(c, await flowDetail(ws, system, c.req.param("id"))); } catch (e) {
      if (e instanceof Error && /^알 수 없는 흐름/.test(e.message)) throw new NotFound(e.message);
      throw e;
    }
  });
  app.post("/api/systems/:s/flows/:id/inputs", async (c) => {
    const system = c.req.param("s");
    const b = await body(c, FlowInputBody);
    await assertRegistered(ws, system);
    const file = await readFlows(ws, system);
    if (!file) throw new NotFound("흐름이 없어요. 먼저 흐름을 추론하세요.");
    let next;
    try { next = setInput(file, c.req.param("id"), b.stepId, b.slot, b.source, "user"); } catch (e) { throw new InvalidRequest((e as Error).message); }
    await writeFlows(ws, system, next);
    return ok(c, await flowDetail(ws, system, c.req.param("id")));
  });
  app.get("/api/systems/:s/safety", async (c) => {
    const system = c.req.param("s");
    await assertRegistered(ws, system);
    return ok(c, { on: safety.get(system) });
  });
  app.post("/api/systems/:s/safety", async (c) => {
    const system = c.req.param("s");
    const b = await body(c, SafetyBody);
    await assertRegistered(ws, system);
    return ok(c, { on: safety.set(system, b.on) });
  });
  /** 안전장치는 요청 시점에 서버가 읽는다. 화면이 보낸 값은 쓰지 않는다. */
  app.post("/api/systems/:s/flows/:id/run", async (c) => {
    const system = c.req.param("s");
    const flowId = c.req.param("id");
    const b = await body(c, FlowRunBody);
    await assertRegistered(ws, system);
    const detail = await flowDetail(ws, system, flowId).catch((e: Error) => { throw new NotFound(e.message); });
    if (detail.missingFeatures.length > 0) return c.json(errorBody("failed", `기능 없음: ${detail.missingFeatures.join(", ")}`, "기능 선택이 바뀌었어요. 흐름을 다시 추론하세요."), 409);
    const env = envStore.env(system);
    if (b.targets.includes("real")) {
      const usable = await readTarget(ws, system, env).then((t) => t.baseUrl !== "", () => false);
      if (!usable) return c.json(errorBody("failed", REAL_BLOCKED), 409);
    }
    const on = safety.get(system);
    const mockDir = await defaultOutDir(ws, opts.root, system);
    return accepted(c, jobs.start(system, "flow", ({ signal, onEvent }) => runFlowTargets(ws, system, flowId, { targets: b.targets, cleanup: b.cleanup, safety: on, env, mockDir, signal, onEvent })).id);
  });
```

  - `envStore.env(system)` is the same call the record route uses (`app.ts:202`). The hint text in `errorBody` is Korean UI copy, the same as the existing `busy` hint at `app.ts:67`.

- [ ] **Step 7: method guard, job kind, types.**
  - In `packages/ui-server/src/security.ts:20`:

```ts
const POST_ONLY = /^\/api\/(?:systems\/[^/]+\/(?:analyze|extract|generate|verify|record|env|flows\/infer|flows\/[^/]+\/(?:run|inputs))|jobs\/[^/]+\/cancel)\/?$/;
```

  - `packages/ui-server/src/jobs.ts:20`: `{ extract: true, verify: true, generate: true, record: true, flow: true }`.
  - `packages/ui-server/src/api-types.ts:71`: `export type JobKind = "extract" | "generate" | "verify" | "record" | "flow";`
  - Extend the re-export at `:30` with `FlowList, FlowSummary, FlowDetail, Flow, FlowStep, FlowInput, FlowSource, FlowRun, StepResult, StepState, Leftover, FlowTargetName`.
  - Add `suggestedBaseUrl?: string | null` to `TargetInfo` (`:35-50`), and `export type FlowRunBody = { targets: FlowTargetName[]; cleanup?: boolean }; export type SafetyState = { on: boolean };`.
  - Add `export type FeatureGroups = { total: number; groups: { group: string; total: number }[] };` next to `FeatureList` (`:29`).
  - Run: `pnpm build:core && pnpm exec vitest run packages/ui-server/test` → all pass, including the new `flows.test.ts` (6) and the existing `app.test.ts` method-guard cases.

- [ ] **Step 8: commit.** `git add -A packages/ui-server && git commit -m "feat(ui-server): flow routes, server-side safety switch and flow jobs"`

- [ ] **Step 9: failing MCP test.** Create `packages/mcp/test/flow.test.ts`, following `tools.test.ts`'s `connect` helper (`test/helpers.ts`):

```ts
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Session } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GITHUB = path.resolve(here, "..", "..", "core", "test", "fixtures", "flow", "github-issues.yaml");
let dir: string; let s: Session;
beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-mcp-flow-"))); s = await connect(dir); });
afterEach(async () => { await s.close(); await rm(dir, { recursive: true, force: true }); });

describe("flow tools", () => {
  it("list_flows shows the flows; fill_flow sets an input with basis claude", async () => {
    await s.ok("ingest_spec", { system: "gh", origins: [GITHUB] });
    await s.ok("analyze_spec", { system: "gh" });
    await s.ok("select_features", { system: "gh", exprs: ["all"] });
    expect(await s.err("list_flows", { system: "gh", flowId: "issues" })).toMatch(/알 수 없는 흐름/);
    const list = await s.ok("list_flows", { system: "gh", infer: true });
    expect(list.flows.map((f: { id: string }) => f.id)).toEqual(["repos", "issues"]);
    await s.ok("fill_flow", { system: "gh", flowId: "issues", stepId: "create_issue", slot: "body.title", source: { kind: "user", value: "from claude" } });
    const d = await s.ok("list_flows", { system: "gh", flowId: "issues" });
    const input = d.flow.steps.find((x: { id: string }) => x.id === "create_issue").inputs.find((i: { slot: string }) => i.slot === "body.title");
    expect(input).toEqual({ slot: "body.title", source: { kind: "user", value: "from claude" }, basis: "claude" });
    expect(await s.err("fill_flow", { system: "gh", flowId: "issues", stepId: "create_issue", slot: "body.nope", source: { kind: "empty" } })).toMatch(/알 수 없는 입력 자리/);
  });
});
```

  (`connect(cwd)` returns `{ ok → structuredContent, err → error text, close }`, `test/helpers.ts:19-59`; it needs `dist/server.js`. `select_features` takes `exprs`, `src/tools/mock.ts:45-50`.) Run: `pnpm build:core && pnpm build:mcp && pnpm exec vitest run packages/mcp/test/flow.test.ts` → fails: unknown tool `list_flows`.

- [ ] **Step 10: implement the tools.** Create `packages/mcp/src/tools/flow.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { flowDetail, flowSummaries, FlowSourceSchema, inferFlowsForSystem, readFlows, setInput, writeFlows, type Workspace } from "@specmock/core";
import { z } from "zod";
import { guard } from "../result.js";
import { SystemArg } from "./analysis.js";

const Loose = z.looseObject({});

/** 흐름 읽기·빈 입력 채우기. 실행 도구는 없다(1단계: 실행은 화면에서, 안전장치는 서버가 판단). */
export function registerFlowTools(server: McpServer, ws: Workspace): void {
  server.registerTool("list_flows", {
    title: "흐름 보기",
    description: "추론된 흐름 목록(빈 입력 수·없는 기능·마지막 결과)을 돌려준다. flowId를 주면 그 흐름의 단계·입력·마지막 실행 결과. infer=true면 고른 기능에서 흐름을 다시 추론한다(사용자·Claude가 채운 입력은 보존). 빈 입력(kind empty)은 fill_flow로 채운다.",
    inputSchema: z.object({ system: SystemArg, flowId: z.string().optional(), infer: z.boolean().optional() }),
    outputSchema: Loose,
  }, guard(async ({ system, flowId, infer }) => {
    if (infer) await inferFlowsForSystem(ws, system);
    const data = flowId ? await flowDetail(ws, system, flowId) : await flowSummaries(ws, system);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as unknown as Record<string, unknown> };
  }));

  server.registerTool("fill_flow", {
    title: "흐름 입력 채우기",
    description: "흐름 단계 하나의 입력 자리(path.<변수> 또는 body.<필드>)를 채운다. source는 {kind:'step',step,field}(앞 단계 응답 필드) | {kind:'user',value} | {kind:'fixed',value} | {kind:'empty'}. 근거는 claude로 기록되고 화면에서 고칠 수 있다. 앞 단계가 만드는 상위 자원(예: path.repo ← create_repo.name)을 한 번 연결하면 같은 자원을 쓰는 다른 단계의 빈 자리에도 채운다. 실제 서버 실행은 하지 않는다.",
    inputSchema: z.object({ system: SystemArg, flowId: z.string(), stepId: z.string(), slot: z.string(), source: FlowSourceSchema }),
    outputSchema: Loose,
  }, guard(async ({ system, flowId, stepId, slot, source }) => {
    const file = await readFlows(ws, system);
    if (!file) throw new Error("흐름이 없습니다. 먼저 list_flows를 infer=true로 부르세요.");
    await writeFlows(ws, system, setInput(file, flowId, stepId, slot, source, "claude"));
    const d = await flowDetail(ws, system, flowId);
    return { content: [{ type: "text" as const, text: `채웠습니다. 남은 빈 입력: ${d.empty.length === 0 ? "없음" : d.empty.join(", ")}` }], structuredContent: d as unknown as Record<string, unknown> };
  }));
}
```

  (`guard` wraps the handler and turns a thrown error into `toolError(e)`, `src/result.ts:67-71`; `rewriteHints` maps only CLI command names, so the messages above need no new mapping.) Register in `createServer.ts`: `import { registerFlowTools } from "./tools/flow.js";` and `registerFlowTools(server, ws);` after `registerMockTools`. In `names.ts`, append `"list_flows", "fill_flow"` to `TOOL_NAMES`.

- [ ] **Step 11: update the pinned counts and skill docs.**
  - `packages/mcp/test/tools.test.ts`: the title `(13 tools, no leftovers)` → `(15 tools, no leftovers)` (line 23); `toHaveLength(13)` → `15` (26); `.length).toBe(13)` → `15` (209, 215).
  - `packages/mcp/test/plugin.test.ts:24`: change the suffix group to `(?:spec|chunk|extraction|extractions|features?|mock|ui|generation|responses|flows?)`.
  - `plugin/skills/specmock/SKILL.md`: add a short "흐름" section that names `list_flows` and `fill_flow` in backticks:
    - Purpose: read the flows, and fill the empty inputs and body values.
    - Rules: the tools only write `flows.json`. Running a flow happens in the web UI. Values Claude fills are marked `claude`.
  - Run: `pnpm build:core && pnpm build:mcp && pnpm exec vitest run packages/mcp/test` → all pass.

- [ ] **Step 12: full gate and commit.** `pnpm typecheck && pnpm test` → green. `git add -A packages/mcp plugin && git commit -m "feat(mcp): list_flows and fill_flow tools"`

---

### Task 6: web — remove the 6-step UI, add registration and flow screens

**Files:**
- Delete: `packages/web/src/screens/{Analyze,Select,Generate,Verify,Record}.tsx`, `packages/web/src/components/{StepBar,ChunkTable,FeatureDetail,SelectionBar,RecordTable,EnvTable}.tsx`, `packages/web/src/coverage.ts`, `packages/web/test/{Analyze,Select,Generate,Verify,Record}.test.tsx`, `packages/web/test/coverage.test.ts`
- Modify: `packages/web/src/recordModel.ts:83-147` (remove the record outcome helpers; keep lines 1-82, the form helpers `TargetForm` uses), `packages/web/src/route.ts:3-21` (screens `home | new | flows`), `packages/web/src/App.tsx:1-16` (imports, `TITLES`), `:76` (home redirect), `:85-110` (no StepBar; render Register or Flows), `packages/web/src/components/Sidebar.tsx:1-36` (whole file: link to `/systems/<s>/flows`, no step dots, no `nextScreen`), `packages/web/src/api.ts:21-40` (flow and safety calls; drop calls with no screen left), `packages/web/src/screens/Register.tsx:1-48` (whole file: two stages), `packages/web/src/components/FeatureTable.tsx:13-32` (optional `groups` and `onGroupSelect` so a group shows before its rows are loaded), `packages/web/src/styles/app.css:184-` (append flow layout classes and `.st-<state>` classes; layout only), `e2e/ui.spec.ts:12-87` (three tests → one)
- Create: `packages/web/src/flowModel.ts`, `packages/web/src/screens/Flows.tsx`, `packages/web/src/components/{FlowList,FlowTopBar,FlowChart,StepCard,InputEditor,Leftovers}.tsx`
- Test: `packages/web/test/flowModel.test.ts`, `packages/web/test/Flows.test.tsx`; rewrite `packages/web/test/{Register,App}.test.tsx` and `packages/web/test/route.test.ts`; replace the 3 tests in `e2e/ui.spec.ts` with one flow test
- Keep unchanged: `TriCheckbox.tsx`, `selection.ts` (feature picking, groups collapsed), `TargetForm.tsx` (target settings), `Notice.tsx`, `ConfirmDialog.tsx`, `ErrorBoundary.tsx`, `events.ts`, `useJob.ts`, `name.ts`, `format.ts`

Colours, fonts and fine styling wait for the user's mock-up approval (spec §4, last paragraph). This task ships the layout and state classes only. The `.st-*` colours use existing tokens from `tokens.css`, and the conductor gets a mock-up page approved before the PR. See "Not in this plan".

- [ ] **Step 1: failing model tests.** Create `packages/web/test/flowModel.test.ts`:

```ts
import { expect, it } from "vitest";
import { edgeLabel, flowDiff, STATE_LABEL, stepView } from "../src/flowModel";
import type { FlowRun, FlowStep, StepResult } from "@specmock/ui-server/api-types";

const res = (stepId: string, state: StepResult["state"], body: unknown = null, values: Record<string, unknown> = {}): StepResult => ({
  stepId, featureId: "f", role: "main", state, reason: state === "success" ? null : "이유", missing: [], request: null,
  response: body === null ? null : { status: 200, kind: "json", body: body as never }, schemaErrors: [], values: values as never, durationMs: 1 });
const run = (target: "mock" | "real", steps: StepResult[]): FlowRun => ({ flowId: "issues", target, startedAt: "a", finishedAt: "b", safety: true, cleanup: true, suffix: "", outcome: "success", error: null, steps, leftovers: [] });

it("eight states have Korean labels (spec §4)", () => {
  expect(Object.values(STATE_LABEL)).toEqual(["실행 전", "성공", "차이 있음", "실패", "안전장치로 건너뜀", "입력이 비어 멈춤", "정리됨", "남은 자원"]);
});

it("stepView: pending before a run, per-target state after, '입력 필요' when a slot is empty", () => {
  const step: FlowStep = { id: "get_issue", featureId: "issues_get", role: "main", inputs: [] };
  expect(stepView(step, { mock: null, real: null }, [])).toEqual({ mock: "pending", real: "pending", needsInput: false });
  expect(stepView(step, { mock: run("mock", [res("get_issue", "success")]), real: run("real", [res("get_issue", "skipped-safety")]) }, ["get_issue:path.owner"]))
    .toEqual({ mock: "success", real: "skipped-safety", needsInput: true });
});

it("flowDiff lists dotted paths whose values differ, and fields present on one side only", () => {
  expect(flowDiff({ id: 1, title: "a", owner: { login: "x" }, extra: 1 }, { id: 2, title: "a", owner: { login: "y" } })).toEqual(["extra", "id", "owner.login"]);
  expect(flowDiff([1, 2], [1, 3])).toEqual(["[1]"]);
  expect(flowDiff(null, null)).toEqual([]);
});

it("edgeLabel: the field name before a run, `field = value` after", () => {
  const input = { slot: "path.issue_number", source: { kind: "step" as const, step: "create_issue", field: "number" }, basis: "rule" as const };
  expect(edgeLabel(input, undefined)).toBe("number");
  expect(edgeLabel(input, res("get_issue", "success", null, { "path.issue_number": 1 }))).toBe("number = 1");
});
```

  Run: `pnpm exec vitest run packages/web/test/flowModel.test.ts` → fails: cannot resolve `../src/flowModel`.

- [ ] **Step 2: implement the model.** Create `packages/web/src/flowModel.ts`:

```ts
import type { FlowInput, FlowRun, FlowStep, FlowTargetName, StepResult, StepState } from "@specmock/ui-server/api-types";

/** 단계 상태 8가지(설계 §4). 색과 글자를 함께 쓴다(`.st-<state>` + 이 글자). */
export const STATE_LABEL: Record<StepState, string> = {
  pending: "실행 전", success: "성공", diff: "차이 있음", failed: "실패",
  "skipped-safety": "안전장치로 건너뜀", "stopped-empty": "입력이 비어 멈춤", cleaned: "정리됨", leftover: "남은 자원",
};
export const BASIS_LABEL = { rule: "규칙", claude: "Claude Code", user: "사용자" } as const;

export type Runs = { mock: FlowRun | null; real: FlowRun | null };
export const resultOf = (run: FlowRun | null, stepId: string): StepResult | undefined => run?.steps.find((s) => s.stepId === stepId);

/** 대상별 상태와 "입력 필요" 여부. empty는 서버가 준 `<stepId>:<slot>` 목록. */
export function stepView(step: FlowStep, runs: Runs, empty: readonly string[]): Record<FlowTargetName, StepState> & { needsInput: boolean } {
  return {
    mock: resultOf(runs.mock, step.id)?.state ?? "pending",
    real: resultOf(runs.real, step.id)?.state ?? "pending",
    needsInput: empty.some((e) => e.startsWith(`${step.id}:`)),
  };
}

/** 두 응답 본문에서 값이 다른 필드의 점 경로(배열은 [i]). 정렬해서 돌려준다. */
export function flowDiff(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    if (obj(x) && obj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p);
  };
  walk(a, b, "");
  return out.sort();
}

/** 순서도의 연결선 글자. 실행 전에는 필드 이름, 실행 뒤에는 `필드 = 값`. */
export function edgeLabel(input: FlowInput, result: StepResult | undefined): string {
  const name = input.source.kind === "step" ? input.source.field : input.slot.replace(/^(path|body)\./, "");
  const v = result?.values[input.slot];
  return v === undefined ? name : `${name} = ${typeof v === "string" ? v : JSON.stringify(v)}`;
}
```

  Run: `pnpm exec vitest run packages/web/test/flowModel.test.ts` → 4 passed.

- [ ] **Step 3: API client and routes.** In `packages/web/src/api.ts`:
  - Drop `chunks`, `feature`, `selection`, `extract`, `generate`, `verify`, `recordLast` and `record`.
  - Add the types `FeatureGroups, FlowList, FlowDetail, FlowSource, FlowTargetName, SafetyState` to the type import, and these calls (keep `features(name, group?)`, `api.ts:25`; Register calls it with a group):

```ts
  featureGroups: (name: string) => call<FeatureGroups>("GET", `${s(name)}/feature-groups`),
  flows: (name: string) => call<FlowList>("GET", `${s(name)}/flows`),
  inferFlows: (name: string) => call<unknown>("POST", `${s(name)}/flows/infer`, {}),
  flow: (name: string, id: string) => call<FlowDetail>("GET", `${s(name)}/flows/${encodeURIComponent(id)}`),
  setFlowInput: (name: string, id: string, stepId: string, slot: string, source: FlowSource) =>
    call<FlowDetail>("POST", `${s(name)}/flows/${encodeURIComponent(id)}/inputs`, { stepId, slot, source }),
  runFlow: (name: string, id: string, targets: FlowTargetName[], cleanup: boolean) =>
    call<{ jobId: string }>("POST", `${s(name)}/flows/${encodeURIComponent(id)}/run`, { targets, cleanup }),
  safety: (name: string) => call<SafetyState>("GET", `${s(name)}/safety`),
  setSafety: (name: string, on: boolean) => call<SafetyState>("POST", `${s(name)}/safety`, { on }),
```

  Replace `packages/web/src/route.ts` lines 3-21 with:

```ts
export type Screen = "home" | "new" | "flows";
export interface Route { screen: Screen; system?: string }

export function parseRoute(pathname: string): Route {
  if (pathname === "/new") return { screen: "new" };
  const m = /^\/systems\/([^/]+)\/flows$/.exec(pathname);
  if (m) {
    try { return { screen: "flows", system: decodeURIComponent(m[1]!) }; } catch { /* 잘못된 % 인코딩 */ }
  }
  return { screen: "home" };
}

export function pathFor(screen: Screen, system?: string): string {
  if (screen === "new" || !system) return screen === "home" ? "/" : "/new";
  return `/systems/${encodeURIComponent(system)}/flows`;
}
```

  Rewrite `packages/web/test/route.test.ts`:

```ts
import { expect, it } from "vitest";
import { parseRoute, pathFor } from "../src/route";

it("경로를 화면으로 푼다", () => {
  expect(parseRoute("/new")).toEqual({ screen: "new" });
  expect(parseRoute("/systems/a%20b/flows")).toEqual({ screen: "flows", system: "a b" });
  expect(parseRoute("/systems/gh/select")).toEqual({ screen: "home" }); // 6단계 화면 경로는 더 없다
  expect(parseRoute("/systems/%/flows")).toEqual({ screen: "home" });
  expect(pathFor("flows", "a b")).toBe("/systems/a%20b/flows");
});
```

- [ ] **Step 4: delete the step screens.** Delete the files in the **Files: Delete** list.
  - In `recordModel.ts`, keep `FormRow`, `FormModel`, `DEFAULT_TIMEOUT_SEC`, `isRef`, `hasRef`, `newRow`, `emptyModel`, `modelFromInfo`, `TIMEOUT_HINT`, `timeoutValid`, `toPutBody` and `refNames`.
  - Remove `ENV_STATUS_LABEL`, `OutcomeKind`, `Outcome`, `NONE`, `RecordDone`, `outcomesFromJob` and `outcomesFromLast`. After the deletions only the deleted `Record.tsx`, `RecordTable.tsx` and `EnvTable.tsx` imported them.
  - Confirm with `grep -rn "outcomesFrom\|ENV_STATUS_LABEL\|RecordDone\|coverage\"" packages/web/src packages/web/test` → no output.
  - Replace `Sidebar.tsx` with:

```tsx
import type { SystemSummary } from "@specmock/ui-server/api-types";
import { pathFor } from "../route";

export function Sidebar({ systems, current, go }: { systems: SystemSummary[]; current?: string; go: (path: string) => void }) {
  const link = (to: string) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); go(to);
  };
  return (
    <aside className="panel side">
      <div className="panel-head"><h3>서비스</h3></div>
      <nav aria-label="서비스" className="side-nav">
        {systems.map((s) => {
          const to = pathFor("flows", s.name);
          return (
            <a key={s.name} href={to} onClick={link(to)} className={`sys${s.name === current ? " on" : ""}`} aria-current={s.name === current ? "page" : undefined}>
              <span className="sys-ic" aria-hidden="true">{s.name.slice(0, 1).toUpperCase()}</span>
              <span className="sys-name">{s.name}</span>
            </a>
          );
        })}
        <a href="/new" onClick={link("/new")} className="sys add">+ 서비스 등록</a>
      </nav>
    </aside>
  );
}
```

  - In `App.tsx`:
    - Remove the imports of the deleted screens and of `StepBar`/`nextScreen`/`Change`, and the `change` state.
    - `TITLES` becomes `{ home: "불러오는 중이에요", new: "서비스를 등록해 주세요", flows: "흐름" }`.
    - The home redirect becomes `go(first ? pathFor("flows", first.name) : "/new", { replace: true })`.
    - The body becomes:

```tsx
    <div className="app">
      <div className="body">
        <Sidebar systems={systems ?? []} current={route.system} go={go} />
        <main className="panel mid">
          {head}
          {route.screen === "new" ? <Register go={go} onRegistered={reload} /> : null}
          {route.screen === "flows" && route.system ? <Flows key={route.system} system={route.system} jobs={jobs} tick={tick} refreshJobs={refreshJobs} /> : null}
        </main>
      </div>
    </div>
```

    - `workspace-changed` keeps `reload(); setTick((t) => t + 1);`.
  - Edit `test/App.test.tsx`:
    - Delete the cases at lines 21-46 (step bar and step redirect) and lines 108-123 (StepBar ⑥ cases).
    - Keep lines 48-106 (workspace-changed, SSE, watch-error, unmount) unchanged.
    - In `base()` (lines 13-19), replace the `"GET /api/systems/petstore"` entry with the two flow-screen routes.
    - Insert the new cases at line 21:

```tsx
const base = () => ({
  "GET /api/env": () => ({ body: { ok: true, data: { root: "/r", claude: true } } }),
  "GET /api/systems": () => ({ body: { ok: true, data: systems } }),
  "GET /api/jobs": () => ({ body: { ok: true, data: { running: [], recent: [] } } }),
  // "/"가 첫 서비스의 흐름 화면으로 가므로 그 화면이 읽는 흐름 목록과 안전장치도 있어야 한다.
  "GET /api/systems/petstore/flows": () => ({ body: { ok: true, data: { inferredAt: null, notes: [], flows: [] } } }),
  "GET /api/systems/petstore/safety": () => ({ body: { ok: true, data: { on: true } } }),
});

it("사이드바에 서비스 목록과 + 서비스 등록, 단계 막대는 없다", async () => {
  fakeApi(base());
  render(<App />);
  const nav = await screen.findByRole("navigation", { name: "서비스" });
  expect(within(nav).getByRole("link", { name: /petstore/ })).toBeTruthy();
  expect(within(nav).getByRole("link", { name: "+ 서비스 등록" })).toBeTruthy();
  expect(screen.queryByText("① 등록")).toBeNull();
});

it("첫 서비스의 흐름 화면으로 이동한다", async () => {
  fakeApi(base());
  render(<App />);
  await screen.findByRole("heading", { name: "흐름" });
  expect(window.location.pathname).toBe("/systems/petstore/flows");
});

it("등록된 서비스가 없으면 등록 화면", async () => {
  fakeApi({ ...base(), "GET /api/systems": () => ({ body: { ok: true, data: [] } }) });
  render(<App />);
  await screen.findByRole("heading", { name: /등록/ });
  expect(window.location.pathname).toBe("/new");
});
```

  - Run: `pnpm typecheck` → fails only on `Flows` and the new `Register` props (next steps).

- [ ] **Step 5: failing Register tests.** Rewrite `packages/web/test/Register.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Register } from "../src/screens/Register";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const okBody = (data: unknown) => () => ({ body: { ok: true, data } });
const rows = [
  { id: "issues_create", group: "issues", method: "POST", path: "/repos/{owner}/{repo}/issues", summary: "", codes: ["201"] },
  { id: "repos_get", group: "repos", method: "GET", path: "/repos/{owner}/{repo}", summary: "", codes: ["200"] },
];
const routes = () => ({
  "POST /api/systems": okBody({ system: "gh", inputs: [{ kind: "openapi" }] }),
  "POST /api/systems/gh/analyze": okBody({ mode: "catalog" }),
  "POST /api/systems/gh/env": okBody({ names: ["API_TOKEN"] }),
  "GET /api/systems/gh/target": okBody({ exists: false, example: "{}", suggestedBaseUrl: "https://api.github.com" }),
  "GET /api/systems/gh/feature-groups": okBody({ total: 2, groups: [{ group: "issues", total: 1 }, { group: "repos", total: 1 }] }),
  "GET /api/systems/gh/features?group=issues": okBody({ total: 1, rows: [rows[0]], groups: ["issues", "repos"] }),
  "GET /api/systems/gh/features?group=repos": okBody({ total: 1, rows: [rows[1]], groups: ["issues", "repos"] }),
  "PUT /api/systems/gh/target": okBody({ exists: true }),
  "POST /api/systems/gh/selection": okBody({ selected: ["issues_create"] }),
  "POST /api/systems/gh/flows/infer": okBody({ flows: [] }),
});

it("stage 1: name, spec URL, token → ingest, analyze, token into server memory; stage 2 shows the suggested base URL", async () => {
  const api = fakeApi(routes());
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/github.yaml");
  type("서비스 이름", "gh");
  type("테스트 토큰", "ghp_secret");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  expect(((await screen.findByLabelText("주소")) as HTMLInputElement).value).toBe("https://api.github.com");
  expect(api.bodies[api.calls.indexOf("POST /api/systems/gh/env")]).toEqual({ values: { API_TOKEN: "ghp_secret" } });
  expect(screen.getByRole("button", { name: /issues/ }).getAttribute("aria-expanded")).toBe("false"); // 묶음은 접힌 채로
  expect(api.calls.some((c) => c.startsWith("GET /api/systems/gh/features"))).toBe(false); // 묶음 요약만 받고 행은 받지 않는다
});

it("stage 2: a group's rows are fetched on first open, only once", async () => {
  const api = fakeApi(routes());
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/github.yaml"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  const issues = await screen.findByRole("button", { name: /issues/ });
  fireEvent.click(issues);
  expect(await screen.findByRole("checkbox", { name: "POST /repos/{owner}/{repo}/issues 선택" })).toBeTruthy();
  fireEvent.click(issues); // 접기
  fireEvent.click(issues); // 다시 열기: 이미 받은 행을 쓴다
  await screen.findByRole("checkbox", { name: "POST /repos/{owner}/{repo}/issues 선택" });
  expect(api.calls.filter((c) => c === "GET /api/systems/gh/features?group=issues")).toHaveLength(1);
  expect(api.calls).not.toContain("GET /api/systems/gh/features?group=repos");
});

it("stage 2: pick a group, save → PUT target, POST selection (literal ids), infer, go to flows", async () => {
  const api = fakeApi(routes());
  const go = vi.fn(), onRegistered = vi.fn();
  render(<Register go={go} onRegistered={onRegistered} />);
  type("스펙 URL", "https://example.com/github.yaml"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /^issues 그룹 전체 선택$/ }));
  await screen.findByText(/1개 선택/); // 묶음 행을 받은 뒤에 고른다
  fireEvent.click(screen.getByRole("button", { name: "등록하고 흐름 만들기" }));
  await vi.waitFor(() => expect(go).toHaveBeenCalledWith("/systems/gh/flows"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/gh/selection")]).toEqual({ ids: ["issues_create"] });
  expect(api.calls).toContain("POST /api/systems/gh/flows/infer");
  const put = api.bodies[api.calls.indexOf("PUT /api/systems/gh/target")] as { baseUrl: string; headers: { name: string; value: string }[] };
  expect(put.baseUrl).toBe("https://api.github.com");
  expect(put.headers).toEqual([{ name: "Authorization", value: "Bearer ${API_TOKEN}" }]);
  expect(onRegistered).toHaveBeenCalled();
});

it("not OpenAPI → stops on the registration screen with the reason", async () => {
  fakeApi({ ...routes(), "POST /api/systems/gh/analyze": okBody({ mode: "prepared" }) });
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://example.com/doc.md"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  expect((await screen.findByRole("alert")).textContent).toContain("OpenAPI 스펙이 아니에요");
});

it("ingest error (unreadable URL) shows message and hint", async () => {
  fakeApi({ ...routes(), "POST /api/systems": () => ({ status: 400, body: { ok: false, error: { code: "invalid", message: "스펙을 읽지 못했어요", hint: "URL을 확인해 주세요." } } }) });
  render(<Register go={() => {}} onRegistered={() => {}} />);
  type("스펙 URL", "https://nope"); type("서비스 이름", "gh");
  fireEvent.click(screen.getByRole("button", { name: "스펙 읽기" }));
  expect((await screen.findByRole("alert")).textContent).toContain("스펙을 읽지 못했어요");
});
```

  The target fake matches `TargetInfo` (`ui-server/src/api-types.ts:35-50`, `exists` and `example` required) plus Task 5's `suggestedBaseUrl`; with no `target`, `modelFromInfo` returns `emptyModel()` (`recordModel.ts:25-27`). The feature rows match `FeatureListRow` (`api-types.ts:28`), the summary matches Task 5's `FeatureGroups`. `fakeApi` keys are the full URL with its query (`test/fakes.ts:10`), so `?group=` needs its own key. Run: `pnpm exec vitest run packages/web/test/Register.test.tsx` → fails: the old screen has no "스펙 URL" field.

- [ ] **Step 6: implement Register.** Replace `packages/web/src/screens/Register.tsx`:

```tsx
import type { FeatureListRow, TargetInfo } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { ApiError, api } from "../api";
import { FeatureTable } from "../components/FeatureTable";
import { Notice } from "../components/Notice";
import { TargetForm } from "../components/TargetForm";
import { suggestSystemName } from "../name";
import { modelFromInfo, newRow, toPutBody, type FormModel } from "../recordModel";
import { pathFor } from "../route";
import { toggleGroup } from "../selection";

/** 화면에서 넣은 토큰의 환경 변수 이름. 값은 ui-server 메모리(EnvStore)에만 있다. */
export const TOKEN_ENV = "API_TOKEN";
const NOT_OPENAPI = "OpenAPI 스펙이 아니에요. 1차에서는 OpenAPI 스펙 URL만 등록할 수 있어요.";
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

export function Register({ go, onRegistered }: { go: (path: string) => void; onRegistered: () => void }) {
  const [origin, setOrigin] = useState("");
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [stage2, setStage2] = useState<{ system: string; model: FormModel; groups: { group: string; total: number }[] } | null>(null);
  const [rows, setRows] = useState<Map<string, FeatureListRow[]>>(new Map()); // 받은 묶음의 행만
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const readSpec = async () => {
    const system = name.trim();
    setBusy(true); setError(null);
    try {
      await api.ingest(system, [origin.trim()]);
      onRegistered();
      const a = await api.analyze(system);
      if (a.mode !== "catalog") { setError(new ApiError(400, "invalid", NOT_OPENAPI)); return; }
      if (token !== "") await api.setEnv(system, { [TOKEN_ENV]: token });
      const [info, summary] = await Promise.all([api.target(system), api.featureGroups(system)]);
      const model = modelFromInfo(info as TargetInfo);
      if (!info.exists) {
        model.baseUrl = info.suggestedBaseUrl ?? "";
        if (token !== "") model.headers = [newRow("Authorization", `Bearer \${${TOKEN_ENV}}`)];
      }
      // 큰 스펙(GitHub 46묶음 1,281개): 묶음 요약만 받고 접어 둔다. 행은 묶음을 열거나 고를 때 받는다(설계 §4 ①).
      setCollapsed(new Set(summary.groups.map((g) => g.group)));
      setRows(new Map());
      setStage2({ system, model, groups: summary.groups });
    } catch (e) { setError(asError(e)); } finally { setBusy(false); }
  };

  /** 묶음의 행은 처음 열거나 고를 때 한 번만 받는다. */
  const loadGroup = async (system: string, g: string): Promise<FeatureListRow[]> => {
    const have = rows.get(g);
    if (have) return have;
    const list = await api.features(system, g);
    setRows((m) => new Map(m).set(g, list.rows));
    return list.rows;
  };
  const toggleOpen = async (g: string) => {
    if (!stage2) return;
    if (collapsed.has(g)) { try { await loadGroup(stage2.system, g); } catch (e) { setError(asError(e)); return; } }
    setCollapsed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  };
  const selectGroup = async (g: string) => {
    if (!stage2) return;
    try { const rs = await loadGroup(stage2.system, g); setSelected((cur) => toggleGroup(rs, g, cur)); } catch (e) { setError(asError(e)); }
  };

  const finish = async () => {
    if (!stage2) return;
    setBusy(true); setError(null);
    try {
      // 열지 않은 묶음의 기능별 설정(target.json features)도 지우지 않도록 이미 저장된 id를 함께 넘긴다.
      const known = new Set([...[...rows.values()].flat().map((r) => r.id), ...Object.keys(stage2.model.features)]);
      const { body } = toPutBody(stage2.model, known);
      await api.putTarget(stage2.system, body);
      await api.saveSelection(stage2.system, [...selected]);
      await api.inferFlows(stage2.system);
      onRegistered();
      go(pathFor("flows", stage2.system));
    } catch (e) { setError(asError(e)); } finally { setBusy(false); }
  };

  if (!stage2) {
    const ready = origin.trim() !== "" && name.trim() !== "" && !busy;
    return (
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (ready) void readSpec(); }}>
        <label className="field"><span>스펙 URL</span>
          <input value={origin} onChange={(e) => { setOrigin(e.target.value); if (!edited) setName(suggestSystemName(e.target.value)); }} placeholder="https://…/openapi.yaml" autoFocus /></label>
        <label className="field"><span>서비스 이름</span>
          <input value={name} onChange={(e) => { setName(e.target.value); setEdited(true); }} /></label>
        <label className="field"><span>테스트 토큰</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
        <p className="muted">토큰은 이 화면을 띄운 서버의 메모리에만 두고 파일에 쓰지 않아요.</p>
        {error ? <Notice message={error.message} hint={error.hint} /> : null}
        <div className="action-row"><button type="submit" className="btn-primary" disabled={!ready}>스펙 읽기</button></div>
      </form>
    );
  }
  const totals = new Map(stage2.groups.map((g) => [g.group, g.total]));
  const total = stage2.groups.reduce((n, g) => n + g.total, 0);
  return (
    <div className="form register-2">
      <h2>대상 설정</h2>
      <TargetForm model={stage2.model} onChange={(model) => setStage2({ ...stage2, model })} />
      <h2>기능 고르기 <span className="muted">{selected.size}개 선택 · 전체 {total}개</span></h2>
      <FeatureTable rows={[...rows.values()].flat()} groups={stage2.groups.map((g) => g.group)} totals={totals} selected={selected} collapsed={collapsed} openId={null}
        onSelect={setSelected} onOpen={() => undefined} onGroupSelect={(g) => void selectGroup(g)} onToggleCollapse={(g) => void toggleOpen(g)} />
      {error ? <Notice message={error.message} hint={error.hint} /> : null}
      <div className="action-row">
        <button type="button" className="btn-primary" disabled={busy || selected.size === 0} onClick={() => void finish()}>등록하고 흐름 만들기</button>
      </div>
    </div>
  );
}
```

  Notes:
  - The `TargetForm` labels (`주소`, `+ 헤더`, `헤더 1 이름`) are the same ones `e2e/ui.spec.ts:66-70` uses today.
  - `FeatureTable`'s group checkbox is labelled `<group> 그룹 전체 선택` (`e2e/ui.spec.ts:20`), and its group button has `aria-expanded` (`FeatureTable.tsx:29`).
  - The base URL field is `<label><span>주소</span>` (`TargetForm.tsx:51`), the group checkbox label is `${g} 그룹 전체 선택` (`FeatureTable.tsx:28`).
  - `FeatureTable` builds its groups from `rows` (`FeatureTable.tsx:18`), so a group with no loaded rows would not show. Change it, keeping today's output when the new props are absent:

```tsx
export function FeatureTable({ rows, totals, selected, collapsed, openId, onSelect, onToggleCollapse, onOpen, groups: groupList, onGroupSelect }: {
  /** 필터로 보이는 행. totals는 그룹별 전체 행 수(필터 전). */
  rows: FeatureListRow[]; totals: ReadonlyMap<string, number>; selected: ReadonlySet<string>; collapsed: ReadonlySet<string>; openId: string | null;
  onSelect: (next: Set<string>) => void; onToggleCollapse: (group: string) => void; onOpen: (id: string) => void;
  /** 묶음 순서. 주면 행을 아직 받지 않은 묶음도 머리줄을 그린다(큰 스펙: 묶음 요약 먼저). */
  groups?: readonly string[];
  /** 주면 묶음 체크박스가 이 함수를 부른다. 행을 받은 뒤 고르는 화면(등록)이 쓴다. */
  onGroupSelect?: (group: string) => void;
}) {
  const groups = groupList ?? [...new Set(rows.map((r) => r.group))];
  return (
    <div className="ft" role="group" aria-label="기능 목록">
      {groups.map((g) => {
        const members = rows.filter((r) => r.group === g);
        const open = !collapsed.has(g);
        const n = members.filter((r) => selected.has(r.id)).length;
        const total = totals.get(g) ?? members.length;
        return (
          <div key={g} className="ft-section">
            <div className="ft-g" onClick={() => onToggleCollapse(g)}>
              <TriCheckbox state={groupState(rows, g, selected)} label={`${g} 그룹 전체 선택`}
                onToggle={() => (onGroupSelect ? onGroupSelect(g) : onSelect(toggleGroup(rows, g, selected)))} />
              <button type="button" className="ft-g-name" aria-expanded={open}>
                <span className="ft-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>{g}
              </button>
              <span className="ft-g-count">{n}/{members.length || total}{members.length > 0 && total !== members.length ? ` (전체 ${total})` : ""}</span>
            </div>
            {/* 행(open ? members.map(...) : null)은 지금 코드(FeatureTable.tsx:34-46) 그대로 둔다. */}
```

  Lines 13-33 of `FeatureTable.tsx` become the block above; lines 34 to the end are unchanged. Without `groups`/`onGroupSelect` the output is the same as today: groups come from `rows`, and `members.length` is never 0, so the count reads as before.

  - Run: `pnpm exec vitest run packages/web/test/Register.test.tsx` → 5 passed. No other test renders `FeatureTable` once `Select.test.tsx` is deleted (step 4).

- [ ] **Step 7: commit (screens removed, registration replaced).** `pnpm typecheck` still fails on `Flows` until step 10. To keep this commit green, add `packages/web/src/screens/Flows.tsx` now as the minimal shell below, and replace it in step 9:

```tsx
import type { Job } from "@specmock/ui-server/api-types";
export function Flows(_: { system: string; jobs: Job[]; tick: number; refreshJobs: () => void }) { return <p className="muted">흐름을 불러오는 중이에요</p>; }
```

  Run: `pnpm typecheck && pnpm exec vitest run --project web   # project name from packages/web/vite.config.ts:9` → green. `git add -A packages/web && git commit -m "feat(web): replace the six-step screens with service registration"`

- [ ] **Step 8: failing flow screen tests.** Create `packages/web/test/Flows.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FlowDetail, FlowRun, StepResult } from "@specmock/ui-server/api-types";
import { Flows } from "../src/screens/Flows";
import { STATE_LABEL } from "../src/flowModel";
import { fakeApi } from "./fakes";

afterEach(() => vi.unstubAllGlobals());
const ok = (data: unknown) => () => ({ body: { ok: true, data } });
const step = (id: string, role: "prep" | "main" | "cleanup", inputs: FlowDetail["flow"]["steps"][number]["inputs"] = []) => ({ id, featureId: `f_${id}`, role, inputs });
const flow: FlowDetail["flow"] = { id: "issues", name: "issue 다루기", resource: "issue", steps: [
  step("create_issue", "main", [{ slot: "body.title", source: { kind: "empty" }, basis: "rule" }, { slot: "path.repo", source: { kind: "user", value: "r" }, basis: "claude" }]),
  step("get_issue", "main", [{ slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "number" }, basis: "rule" }]),
] };
const res = (stepId: string, state: StepResult["state"], body: unknown, values = {}): StepResult => ({ stepId, featureId: "f", role: "main", state, reason: state === "success" ? null : `${state} 이유`, missing: [], request: { method: "GET", url: "http://x/1", headers: {}, body: null }, response: { status: 200, kind: "json", body: body as never }, schemaErrors: [], values, durationMs: 1 });
const run = (target: "mock" | "real", steps: StepResult[], leftovers: FlowRun["leftovers"] = []): FlowRun => ({ flowId: "issues", target, startedAt: "a", finishedAt: "b", safety: target === "real", cleanup: true, suffix: "", outcome: "success", error: null, steps, leftovers });
const routes = (detail: Partial<FlowDetail> = {}, safety = true) => ({
  "GET /api/systems/gh/flows": ok({ inferredAt: "t", notes: ['issue: 삭제 기능이 없어 실행 뒤 "남은 자원"으로 알립니다.'], flows: [{ id: "issues", name: "issue 다루기", resource: "issue", steps: 2, empty: 1, missingFeatures: [], last: { mock: null, real: null } }] }),
  "GET /api/systems/gh/flows/issues": ok({ flow, empty: ["create_issue:body.title"], missingFeatures: [], runs: { mock: null, real: null }, ...detail }),
  "GET /api/systems/gh/safety": ok({ on: safety }),
});
const mount = () => render(<Flows system="gh" jobs={[]} tick={0} refreshJobs={() => {}} />);

it("list shows empty-input count; chart shows '입력 필요', edge names before a run, basis badges", async () => {
  fakeApi(routes());
  mount();
  const list = await screen.findByRole("navigation", { name: "흐름" });
  expect(within(list).getByRole("link", { name: /issue 다루기.*빈 연결 1/ })).toBeTruthy();
  expect(screen.getByText("입력 필요")).toBeTruthy();
  expect(screen.getByText("number")).toBeTruthy(); // 실행 전: 연결 이름
  expect(screen.getAllByText(STATE_LABEL.pending).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: /create_issue/ }));
  expect(screen.getByText("Claude Code")).toBeTruthy();
  expect(screen.getByText("규칙")).toBeTruthy();
});

it("renders all eight states with label and class", async () => {
  const states = ["success", "diff", "failed", "skipped-safety", "stopped-empty", "cleaned", "leftover"] as const;
  const many: FlowDetail["flow"] = { ...flow, steps: [...states.map((s) => step(s.replace("-", "_"), "main")), step("not_run", "main")] }; // not_run has no result → pending
  fakeApi(routes({ flow: many, empty: [], runs: { mock: run("mock", states.map((s) => res(s.replace("-", "_"), s, {}))), real: null } }));
  mount();
  for (const s of ["pending", ...states] as const) {
    const el = (await screen.findAllByText(STATE_LABEL[s]))[0]!;
    expect(el.className).toContain(`st-${s}`);
  }
});

it("after a run: edge shows `field = value`; expanded step shows only differing fields first, then 전체 보기", async () => {
  fakeApi(routes({ empty: [], runs: {
    mock: run("mock", [res("create_issue", "success", { number: 1, title: "a" }), res("get_issue", "success", { number: 1 }, { "path.issue_number": 1 })]),
    real: run("real", [res("create_issue", "success", { number: 7, title: "a" }), res("get_issue", "success", { number: 7 }, { "path.issue_number": 7 })]) } }));
  mount();
  expect(await screen.findByText("number = 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /create_issue/ }));
  const card = screen.getByRole("region", { name: "create_issue 결과" });
  expect(within(card).getByText("차이 난 필드: number")).toBeTruthy();
  expect(within(card).queryByText(/"title"/)).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "전체 보기" }));
  expect(within(card).getAllByText(/"title"/).length).toBe(2);
});

it("fill an empty input with a user value → POST inputs with source user", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/flows/issues/inputs": ok({ flow, empty: [], missingFeatures: [], runs: { mock: null, real: null } }) });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /create_issue/ }));
  fireEvent.change(screen.getByLabelText("body.title 값"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "body.title 저장" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/gh/flows/issues/inputs"));
  expect(api.bodies[api.calls.indexOf("POST /api/systems/gh/flows/issues/inputs")]).toEqual({ stepId: "create_issue", slot: "body.title", source: { kind: "user", value: "hello" } });
});

it("pick an earlier step's response field as the source", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/flows/issues/inputs": ok({ flow, empty: [], missingFeatures: [], runs: { mock: null, real: null } }) });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /get_issue/ }));
  fireEvent.change(screen.getByLabelText("path.issue_number 출처"), { target: { value: "step" } });
  fireEvent.change(screen.getByLabelText("path.issue_number 앞 단계"), { target: { value: "create_issue" } });
  fireEvent.change(screen.getByLabelText("path.issue_number 응답 필드"), { target: { value: "id" } });
  fireEvent.click(screen.getByRole("button", { name: "path.issue_number 저장" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/gh/flows/issues/inputs"));
  expect(api.bodies.at(-1)).toEqual({ stepId: "get_issue", slot: "path.issue_number", source: { kind: "step", step: "create_issue", field: "id" } });
});

it("run with empty inputs is allowed; targets and cleanup go to the run route", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/flows/issues/run": ok({ jobId: "j1" }) });
  mount();
  fireEvent.click(await screen.findByRole("radio", { name: "둘 다" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "정리" }));
  fireEvent.click(screen.getByRole("button", { name: "전체 실행" }));
  await vi.waitFor(() => expect(api.calls).toContain("POST /api/systems/gh/flows/issues/run"));
  expect(api.bodies.at(-1)).toEqual({ targets: ["mock", "real"], cleanup: false });
});

it("safety off colours the top bar; the switch posts to the server", async () => {
  const api = fakeApi({ ...routes(), "POST /api/systems/gh/safety": ok({ on: false }) });
  mount();
  const sw = await screen.findByRole("switch", { name: "안전장치" });
  expect(sw.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(sw);
  await vi.waitFor(() => expect(screen.getByRole("toolbar", { name: "흐름 실행" }).className).toContain("unsafe"));
  expect(api.bodies.at(-1)).toEqual({ on: false });
});

it("leftovers list shows URL and id; missing features block the run", async () => {
  fakeApi(routes({ missingFeatures: ["f_get_issue"], runs: { mock: null, real: run("real", [], [{ resource: "issue", stepId: "create_issue", url: "https://api.github.com/repos/o/r/issues/7", id: "7", reason: "삭제 기능이 없어요" }]) } }));
  mount();
  const left = await screen.findByRole("region", { name: "남은 자원" });
  expect(within(left).getByText("https://api.github.com/repos/o/r/issues/7")).toBeTruthy();
  expect(within(left).getByText("7")).toBeTruthy();
  expect(screen.getByText(/기능 없음: f_get_issue/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "전체 실행" }) as HTMLButtonElement).disabled).toBe(true);
});
```

  Run: `pnpm exec vitest run packages/web/test/Flows.test.tsx` → 8 failed (the shell renders nothing).

- [ ] **Step 9: implement the flow screen.** Replace `packages/web/src/screens/Flows.tsx`:

```tsx
import type { FlowDetail, FlowList as FlowListData, FlowSource, FlowTargetName, Job } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { FlowChart } from "../components/FlowChart";
import { FlowList } from "../components/FlowList";
import { FlowTopBar } from "../components/FlowTopBar";
import { Leftovers } from "../components/Leftovers";
import { Notice } from "../components/Notice";
import { useJob } from "../useJob";

export type TargetChoice = "mock" | "real" | "both";
const TARGETS: Record<TargetChoice, FlowTargetName[]> = { mock: ["mock"], real: ["real"], both: ["mock", "real"] };
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

export function Flows({ system, jobs, tick, refreshJobs }: { system: string; jobs: Job[]; tick: number; refreshJobs: () => void }) {
  const [list, setList] = useState<FlowListData | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [safety, setSafety] = useState(true);
  const [target, setTarget] = useState<TargetChoice>("mock");
  const [cleanup, setCleanup] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const job = useJob(jobs, system, "flow");

  useEffect(() => {
    api.flows(system).then((l) => { setList(l); setCurrent((c) => c ?? l.flows[0]?.id ?? null); }).catch((e) => setError(asError(e)));
    api.safety(system).then((s) => setSafety(s.on)).catch(() => undefined);
  }, [system, tick, job.seen?.state]);
  useEffect(() => {
    if (current) api.flow(system, current).then(setDetail).catch((e) => setError(asError(e)));
  }, [system, current, tick, job.seen?.state]);

  const saveInput = useCallback(async (stepId: string, slot: string, source: FlowSource) => {
    if (!current) return;
    try { setDetail(await api.setFlowInput(system, current, stepId, slot, source)); setError(null); } catch (e) { setError(asError(e)); }
  }, [system, current]);
  const run = async () => {
    if (!current) return;
    try { const { jobId } = await api.runFlow(system, current, TARGETS[target], cleanup); job.watch(jobId); refreshJobs(); setError(null); } catch (e) { setError(asError(e)); }
  };
  const toggleSafety = async () => {
    try { setSafety((await api.setSafety(system, !safety)).on); } catch (e) { setError(asError(e)); }
  };

  if (list && list.flows.length === 0) {
    return (
      <section className="flows-empty">
        <p>고른 기능에서 흐름을 만들지 못했어요.</p>
        <ul>{list.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    );
  }
  return (
    <div className="flows">
      <FlowList flows={list?.flows ?? []} current={current} onPick={setCurrent} />
      <section className="flow-main">
        {detail ? (
          <>
            <FlowTopBar name={detail.flow.name} target={target} onTarget={setTarget} cleanup={cleanup} onCleanup={setCleanup}
              safety={safety} onSafety={() => void toggleSafety()} running={job.running !== undefined}
              blocked={detail.missingFeatures.length > 0} onRun={() => void run()} />
            {detail.missingFeatures.length > 0 ? <Notice message={`기능 없음: ${detail.missingFeatures.join(", ")}`} hint="기능 선택이 바뀌었어요. 흐름을 다시 추론하세요." /> : null}
            {error ? <Notice message={error.message} hint={error.hint} /> : null}
            {job.seen?.state === "failed" && job.seen.error ? <Notice message={job.seen.error.message} hint={job.seen.error.hint} /> : null}
            {(["mock", "real"] as const).map((t) => detail.runs[t]?.error ? <Notice key={t} message={`${t === "mock" ? "mock" : "실제"} 실행: ${detail.runs[t]!.error}`} /> : null)}
            <FlowChart flow={detail.flow} runs={detail.runs} empty={detail.empty} onSave={saveInput} />
            <Leftovers runs={detail.runs} />
          </>
        ) : null}
      </section>
    </div>
  );
}
```

  Create `packages/web/src/components/FlowList.tsx`:

```tsx
import type { FlowSummary } from "@specmock/ui-server/api-types";
import { STATE_LABEL } from "../flowModel";

const OUTCOME_LABEL = { success: STATE_LABEL.success, diff: STATE_LABEL.diff, failed: STATE_LABEL.failed, stopped: "멈춤" } as const;

export function FlowList({ flows, current, onPick }: { flows: FlowSummary[]; current: string | null; onPick: (id: string) => void }) {
  return (
    <nav aria-label="흐름" className="panel flow-list">
      {flows.map((f) => (
        <a key={f.id} href={`#${f.id}`} className={`flow-item${f.id === current ? " on" : ""}`} aria-current={f.id === current ? "page" : undefined}
          onClick={(e) => { e.preventDefault(); onPick(f.id); }}>
          <span className="flow-name">{f.name}</span>
          <span className="muted"> 빈 연결 {f.empty}</span>
          {f.missingFeatures.length > 0 ? <span className="st-failed"> 기능 없음</span> : null}
          <span className="flow-last"> mock {f.last.mock ? OUTCOME_LABEL[f.last.mock] : STATE_LABEL.pending} · 실제 {f.last.real ? OUTCOME_LABEL[f.last.real] : STATE_LABEL.pending}</span>
        </a>
      ))}
    </nav>
  );
}
```

  Create `packages/web/src/components/FlowTopBar.tsx`:

```tsx
import type { TargetChoice } from "../screens/Flows";

const CHOICES: [TargetChoice, string][] = [["mock", "mock"], ["real", "실제"], ["both", "둘 다"]];

export function FlowTopBar(p: { name: string; target: TargetChoice; onTarget: (t: TargetChoice) => void; cleanup: boolean; onCleanup: (on: boolean) => void;
  safety: boolean; onSafety: () => void; running: boolean; blocked: boolean; onRun: () => void }) {
  return (
    <div role="toolbar" aria-label="흐름 실행" className={`flow-top${p.safety ? "" : " unsafe"}`}>
      <h2>{p.name}</h2>
      <div role="radiogroup" aria-label="대상">
        {CHOICES.map(([v, label]) => (
          <label key={v}><input type="radio" name="flow-target" checked={p.target === v} onChange={() => p.onTarget(v)} />{label}</label>
        ))}
      </div>
      <label><input type="checkbox" checked={p.cleanup} onChange={(e) => p.onCleanup(e.target.checked)} />정리</label>
      <button type="button" className="btn-primary" disabled={p.running || p.blocked} onClick={p.onRun}>전체 실행</button>
      <button type="button" role="switch" aria-checked={p.safety} aria-label="안전장치" className="safety" onClick={p.onSafety}>
        {p.safety ? "안전장치 켜짐: 실제 서버에는 GET만" : "안전장치 꺼짐: 실제 서버에 쓰기 요청을 보내요"}
      </button>
    </div>
  );
}
```

  The flow-chart tests click `getByRole("checkbox", { name: "정리" })`. The label wraps the input, so the accessible name is `정리`.

  Create `packages/web/src/components/FlowChart.tsx`:

```tsx
import type { Flow, FlowSource } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { edgeLabel, resultOf, STATE_LABEL, stepView, type Runs } from "../flowModel";
import { StepCard } from "./StepCard";

export function FlowChart({ flow, runs, empty, onSave }: { flow: Flow; runs: Runs; empty: string[]; onSave: (stepId: string, slot: string, source: FlowSource) => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="flow-chart">
      {flow.steps.map((s, i) => {
        const v = stepView(s, runs, empty);
        const result = resultOf(runs.mock, s.id) ?? resultOf(runs.real, s.id);
        const edges = s.inputs.filter((x) => x.source.kind === "step");
        return (
          <li key={s.id} className="flow-step">
            {i > 0 && edges.length > 0 ? <div className="flow-edge">{edges.map((x) => <span key={x.slot}>{edgeLabel(x, result)}</span>)}</div> : null}
            <button type="button" className="flow-node" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="flow-node-id">{s.id}</span>
              <span className="muted">{s.featureId}</span>
              {v.mock === "pending" && !runs.real ? <span className="st st-pending">{STATE_LABEL.pending}</span> : (
                <>
                  <span className="st"><span className="muted">mock </span><span className={`st-${v.mock}`}>{STATE_LABEL[v.mock]}</span></span>
                  {runs.real ? <span className="st"><span className="muted">실제 </span><span className={`st-${v.real}`}>{STATE_LABEL[v.real]}</span></span> : null}
                </>
              )}
              {v.needsInput ? <span className="need-input">입력 필요</span> : null}
            </button>
            {open === s.id ? <StepCard step={s} before={flow.steps.slice(0, i)} runs={runs} onSave={onSave} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
```

  The label text sits in its own element with class `st-<state>`, so the eight-state test finds `STATE_LABEL[s]` by text and checks its class; Playwright matches `.flow-node .st-success`.

  Create `packages/web/src/components/StepCard.tsx`:

```tsx
import type { FlowSource, FlowStep } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { flowDiff, resultOf, type Runs } from "../flowModel";
import { InputEditor } from "./InputEditor";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export function StepCard({ step, before, runs, onSave }: { step: FlowStep; before: FlowStep[]; runs: Runs; onSave: (stepId: string, slot: string, source: FlowSource) => Promise<void> }) {
  const [full, setFull] = useState(false);
  const mock = resultOf(runs.mock, step.id), real = resultOf(runs.real, step.id);
  const diff = mock?.response && real?.response ? flowDiff(mock.response.body, real.response.body) : [];
  const sent = (real ?? mock)?.request;
  return (
    <section role="region" aria-label={`${step.id} 결과`} className="step-card">
      <div className="step-inputs">
        {step.inputs.map((x) => <InputEditor key={x.slot} stepId={step.id} input={x} before={before} onSave={onSave} />)}
      </div>
      {sent ? <div className="step-req"><h4>보낸 요청</h4><code>{sent.method} {sent.url}</code>{sent.body !== null ? <pre>{pretty(sent.body)}</pre> : null}</div> : null}
      {mock || real ? (
        <>
          {mock && real ? <p className="step-diff">{diff.length === 0 ? "차이 난 필드 없음" : `차이 난 필드: ${diff.join(", ")}`}</p> : null}
          {[mock, real].map((r) => r?.reason ? <p key={r === mock ? "m" : "r"} className="muted">{r.reason}</p> : null)}
          <button type="button" className="btn-ghost" onClick={() => setFull(!full)}>{full ? "차이만 보기" : "전체 보기"}</button>
          {full ? (
            <div className="step-side">
              <div><h4>mock 응답 {mock?.response?.status ?? ""}</h4><pre>{mock?.response ? pretty(mock.response.body) : "없음"}</pre></div>
              <div><h4>실제 응답 {real?.response?.status ?? ""}</h4><pre>{real?.response ? pretty(real.response.body) : "없음"}</pre></div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
```

  Create `packages/web/src/components/InputEditor.tsx`:

```tsx
import type { FlowInput, FlowSource, FlowStep } from "@specmock/ui-server/api-types";
import { useState } from "react";
import { BASIS_LABEL } from "../flowModel";

type Kind = "user" | "step";
/** 사용자가 넣은 글자: JSON으로 읽히면 그 값, 아니면 문자열. */
const parseValue = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

export function InputEditor({ stepId, input, before, onSave }: { stepId: string; input: FlowInput; before: FlowStep[]; onSave: (stepId: string, slot: string, source: FlowSource) => Promise<void> }) {
  const src = input.source;
  // 앞 단계가 만드는 상위 자원(createdBy)이면 그 단계 응답을 연결하는 쪽을 먼저 보여 준다(C6).
  const [kind, setKind] = useState<Kind>(src.kind === "step" || (src.kind === "empty" && input.createdBy) ? "step" : "user");
  const [value, setValue] = useState(src.kind === "user" || src.kind === "fixed" ? (typeof src.value === "string" ? src.value : JSON.stringify(src.value)) : "");
  const [step, setStep] = useState(src.kind === "step" ? src.step : input.createdBy ?? before[0]?.id ?? "");
  const [field, setField] = useState(src.kind === "step" ? src.field : "");
  const save = () => void onSave(stepId, input.slot, kind === "user" ? { kind: "user", value: parseValue(value) as never } : { kind: "step", step, field });
  return (
    <div className={`input-row${src.kind === "empty" ? " empty" : ""}`}>
      <span className="slot">{input.slot}</span>
      <span className={`basis basis-${input.basis}`}>{BASIS_LABEL[input.basis]}</span>
      <select aria-label={`${input.slot} 출처`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        <option value="user">값 직접 넣기</option>
        {before.length > 0 ? <option value="step">앞 단계 응답</option> : null}
      </select>
      {kind === "user" ? (
        <input aria-label={`${input.slot} 값`} value={value} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <>
          <select aria-label={`${input.slot} 앞 단계`} value={step} onChange={(e) => setStep(e.target.value)}>
            {before.map((b) => <option key={b.id} value={b.id}>{b.id}</option>)}
          </select>
          <input aria-label={`${input.slot} 응답 필드`} value={field} onChange={(e) => setField(e.target.value)} placeholder="number, owner.login" />
        </>
      )}
      <button type="button" className="btn-ghost" aria-label={`${input.slot} 저장`} onClick={save}>저장</button>
    </div>
  );
}
```

  Create `packages/web/src/components/Leftovers.tsx`:

```tsx
import type { Runs } from "../flowModel";

export function Leftovers({ runs }: { runs: Runs }) {
  const rows = (["mock", "real"] as const).flatMap((t) => (runs[t]?.leftovers ?? []).map((l) => ({ ...l, target: t })));
  if (rows.length === 0) return null;
  return (
    <section role="region" aria-label="남은 자원" className="leftovers">
      <h3>남은 자원</h3>
      <table><thead><tr><th>대상</th><th>자원</th><th>주소</th><th>식별자</th><th>이유</th></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={`${l.target}:${l.stepId}:${l.url}`}><td>{l.target === "mock" ? "mock" : "실제"}</td><td>{l.resource}</td><td><code>{l.url}</code></td><td>{l.id ?? ""}</td><td>{l.reason}</td></tr>
        ))}</tbody></table>
    </section>
  );
}
```

  `FlowSummary`, `FlowDetail`, `Flow`, `FlowStep`, `FlowInput`, `FlowSource`, `FlowRun`, `StepResult`, `StepState`, `FlowTargetName` and `SafetyState` come from `@specmock/ui-server/api-types` (Task 5 step 7).

  Append layout CSS to `packages/web/src/styles/app.css`. Use only existing tokens; colours are provisional until the mock-up is approved:

```css
.flows { display: grid; grid-template-columns: 240px 1fr; gap: 12px; min-height: 0; }
.flow-list { padding: 8px; gap: 4px; }
.flow-item { display: flex; flex-direction: column; padding: 8px; border-radius: var(--radius-sm); color: var(--text); text-decoration: none; }
.flow-item.on { background: var(--surface-2); }
.flow-top { display: flex; align-items: center; gap: 16px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.flow-top .safety { margin-left: auto; }
.flow-top.unsafe { background: color-mix(in srgb, var(--danger) 18%, var(--surface-1)); }
.flow-chart { list-style: none; margin: 0; padding: 12px 0; display: flex; flex-direction: column; gap: 4px; }
.flow-edge { padding-left: 24px; color: var(--text-2); font-family: var(--mono); }
.flow-node { display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-1); }
.need-input { font-weight: 700; }
.step-card { padding: 8px 12px 12px 24px; display: flex; flex-direction: column; gap: 8px; }
.step-side { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.input-row { display: flex; gap: 8px; align-items: center; }
.basis { font-size: .85em; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); }
.st { display: inline-flex; gap: 4px; }
.st-pending, .st-success, .st-diff, .st-failed, .st-skipped-safety, .st-stopped-empty, .st-cleaned, .st-leftover { font-weight: 600; }
```

  Every variable used above exists in `tokens.css:2-10` (`--surface-1/2`, `--line`, `--line-strong`, `--text`, `--text-2`, `--danger`, `--mono`, `--radius-sm`).

  Run: `pnpm exec vitest run packages/web/test/Flows.test.tsx packages/web/test/flowModel.test.ts` → 12 passed.

- [ ] **Step 10: e2e.** Replace the three tests in `e2e/ui.spec.ts` with one test. Keep the imports and the `REPO`/`ROOT` constants, and drop `cp`/`createServer`/`AddressInfo`.

```ts
test("흐름: 서비스 등록 → 흐름 화면 → 빈 입력 채우기 → mock 실행", async ({ page }) => {
  await page.goto("/new");
  await page.getByLabel("스펙 URL").fill(path.join(REPO, "packages", "core", "test", "fixtures", "flow", "github-issues.yaml"));
  await page.getByLabel("서비스 이름").fill("gh");
  await page.getByRole("button", { name: "스펙 읽기" }).click();
  await expect(page.getByLabel("주소")).toHaveValue("https://api.github.com");
  await page.getByRole("button", { name: "+ 값" }).click();
  await page.getByLabel("공통 값 1 이름").fill("owner");
  await page.getByLabel("공통 값 1 값").fill("octo"); // owner만 params로 둔다. repo는 흐름이 만든다(C6).
  await page.getByRole("checkbox", { name: /^issues 그룹 전체 선택$/ }).click();
  await page.getByRole("checkbox", { name: /^repos 그룹 전체 선택$/ }).click();
  await expect(page.getByText(/8개 선택/)).toBeVisible(); // 묶음 행은 체크할 때 받으므로 두 묶음이 다 들어온 뒤 누른다
  await page.getByRole("button", { name: "등록하고 흐름 만들기" }).click();
  await expect(page).toHaveURL(/\/systems\/gh\/flows$/);
  await page.getByRole("link", { name: /issue 다루기/ }).click();
  for (const [step, slot, value] of [["create_repo", "body.name", "flowtest"], ["create_issue", "body.title", "hello"]] as const) {
    await page.getByRole("button", { name: new RegExp(step) }).click();
    await page.getByLabel(`${slot} 값`).fill(value);
    await page.getByRole("button", { name: `${slot} 저장` }).click();
  }
  // repo는 앞 단계가 만든 것을 한 번 연결한다. get_issue·update_issue·delete_repo의 빈 path.repo에도 퍼진다.
  // create_issue 카드는 위 반복의 마지막에 열려 있다(카드 버튼은 열고 닫기를 오간다).
  await page.getByLabel("path.repo 출처").selectOption("step");
  await page.getByLabel("path.repo 앞 단계").selectOption("create_repo");
  await page.getByLabel("path.repo 응답 필드").fill("name");
  await page.getByRole("button", { name: "path.repo 저장" }).click();
  await expect(page.getByText("입력 필요")).toHaveCount(0);
  // 첫 실행은 mock 디렉터리에 node_modules가 없어 기동에 실패한다(설계 §5: mock 실행만 실패로 표시).
  await page.getByRole("button", { name: "전체 실행" }).click();
  await expect(page.getByText(/mock을 띄우지 못했습니다/)).toBeVisible({ timeout: 60_000 });
  await symlink(path.join(REPO, "node_modules"), path.join(ROOT, "mock", "gh", "node_modules"), "dir");
  await page.getByRole("button", { name: "전체 실행" }).click();
  await expect(page.locator(".flow-node .st-success").first()).toBeVisible({ timeout: 90_000 });
});
```

  Notes:
  - Labels come from `TargetForm.tsx:55-56`: params use `label="공통 값"` and `addLabel="+ 값"`, so rows are `공통 값 N 이름` / `공통 값 N 값` (`TargetForm.tsx:19,23`).
  - The mock dir is `defaultOutDir(ws, root, system)` = `<root>/mock/gh` (the old test's `path.join(ROOT, "mock", "petstore")` at `e2e/ui.spec.ts:24`).
  - The badge label is its own element (step 9), so the test waits on `.flow-node .st-success`.
  - Only `owner` is a param. `{repo}` is created by `create_repo`, so params never fill it (C6, Task 3 `emptySlots`, Task 4 run rules); linking it once on `create_issue` fills the other empty `path.repo` slots (Task 3 `setInput`).
  - Run: `pnpm test:e2e` → 1 passed.

- [ ] **Step 11: full gate and commit.** `pnpm typecheck && pnpm test` → green. Core and generator tests are unchanged, so `core/test/snapshot.test.ts` and the Java tests still pass. `git add -A packages/web e2e && git commit -m "feat(web): flow screen with step states, input filling and safety switch"`

---

## Not in this plan

- Resource graph view, the built-in API catalog and browser, and multi-service flows: spec §1 "1차에서 하지 않는 것".
- Following `Link` pagination, and `links`-based inference rules: spec §6. The `links` objects are not kept in `Feature` (Task 2 keeps only response headers and `bodyRequired`), and the GitHub spec declares none (Task 1).
- Generator changes for multi-segment mock path params, and the generator's "required-only body" switch. See Conflicts C1.
- Doc-page (markdown/HTML) inference: registration stops for non-OpenAPI input (Task 6 step 6).
- Adding, deleting or reordering flow steps; run history comparison (one run file per target); colour themes (spec §4 "1차에서 화면이 하지 않는 것").
- An MCP tool that runs flows. Phase 1 runs only from the web UI, where the server judges safety (C3).
- Final colours, fonts and badge styling: the user approves a mock-up first (spec §4). Task 6 ships layout and state classes only.
- A spec-size limit, a size error message and a lazily loaded catalog. Task 1 (issue #29, commit 7b7c3de) ran the full GitHub spec (OpenAPI 3.0.3, 14,283,088 B, 842 paths, 1,281 operations) through the current eager pipeline with no failure and no workaround: ingest 4.09 s / peak RSS 1.88 GB / `source.json` 56,778,732 B; analyze 1.11 s / 1.12 GB / `catalog.json` 37,316,645 B, 46 groups; select 6 ops 0.92 s / 2,266,577 B, select all 1.72 s / 1.60 GB / 87,220,959 B. Only the screen is limited: group summaries first, one group's rows on demand (T5 `GET /feature-groups`, T6 Register).
- Auth read from the spec: the GitHub spec declares no `security` / `securitySchemes` (catalog `auth` is `none` for all), so the run sends only `target.json` headers.

## Conflicts with spec

| # | Spec statement | Code evidence | Resolution |
|---|---|---|---|
| C1 | §1 "고치는 것": the generator gets a "required-only request body" option. | Mock fixtures build request bodies through `select/fixtures.ts:18-26`, and `isBodyRequired` (`core/src/bodyRequired.ts:5`) feeds `generate/tsHono.ts:55` and `select/contracts.ts:63`. Changing either alters generated files, which `core/test/snapshot.test.ts` pins. The brief requires that generators stay unchanged. | Add `requiredBodyFields(feature)` in `select/requiredBody.ts` (Task 2). Only `flow/infer` uses it to make `body.<field>` slots. Generator and contract output stay byte-identical. |
| C2 | §2 rule 1: a resource is a list path plus an item path (`/x` and `/x/{id}`). | GitHub creates repos at `POST /user/repos` but reads them at `/repos/{owner}/{repo}`, so the paths never pair (fixture in Task 3 step 2). | `buildGroups` merges an item-only group into the single list group with the same resource name that has a POST and no item path. If two such groups exist, it skips the merge (rule 5 spirit: leave it empty rather than guess). |
| C3 | §1 "화면과 MCP": MCP fills flows; §3 safety is judged on the server. | MCP tools run with no server-side safety state: `createServer` (`mcp/src/createServer.ts:8-13`) builds a fresh `McpServer` and registers stateless tools, with no store shared with the ui-server process. | Phase 1 MCP gets `list_flows`/`fill_flow` only, with no run tool. Safety lives in `SafetyStore` (ui-server) and is passed to `runFlow`. |
| C4 | §3 "단계마다 본문·헤더를 바꿔 보내도록 `runContract`를 고친다". | Header override already exists: `ContractRunOptions.headers` (`verify/contracts.ts:9`), merged at `:76-79`. | Task 4 adds only `body?: unknown` to the options; headers need no change. |
| C5 | §3 "이번 실행이 만든 자원만 지운다". | `runContract(baseUrl, c, opts)` (`verify/contracts.ts:62`) sends one request and returns one `ContractRun`, so it has no notion of created resources. | The DELETE step runs only when its last path input is a `step` source pointing at a creating step that succeeded in this run. Otherwise it is `skipped-safety` with `NOT_CREATED`, and the resource is listed as a leftover. |
| C6 | §2 rule 4 links values by field name; GitHub `owner`/`repo` come from no earlier response in the issues flow. | `issues/create` needs `{owner}/{repo}`, while `POST /user/repos` returns `owner.login`/`name` (fixture). Rule 3's name match finds no field for `repo` (the response calls it `name`). | User decision: a child step uses the parent the flow's prep step created, never `target.params`. Inference marks such a path slot with `createdBy: <creating step>` (T3 `FlowInput.createdBy`); with exactly one candidate field it is linked, otherwise it stays `empty`, counts in `emptySlots` even when params has the name, and shows "입력 필요" until linked once (`repo <- create_repo.name`); `setInput` then fills the same empty slot in the other steps (T3). `target.params` fills only path slots no step creates (`{owner}`; T3 `emptySlots`, T4 run rules). Teardown deletes the repo, which removes its issue, so the issue is not a leftover; if the repo delete fails or cleanup is off, both are listed (T4). |

## Spec coverage

| Spec item | Task / step |
|---|---|
| §1 new core modules `flow/infer`, `flow/store`, `flow/run` | T3 s1-12, T4 s4-12 |
| §1 core fixes: required-only body (via helper, C1) | T2 (requiredBodyFields steps) |
| §1 `Feature` keeps `requestBody.required`, response headers | T2 (schema + openapi.ts steps) |
| §1 mask `ghp_` / `github_pat_` | T2 (mask steps) |
| §1 large spec: process selected features only | T2 (largeSpec steps; measurement result, no size limit) |
| §1 large spec on screen: group summaries first, rows per group on demand | T5 s6-7 (`GET /feature-groups`, test), T6 s3, s5-6 (Register, `FeatureTable` `groups`/`onGroupSelect`) |
| Measurement: response fields read through `allOf` | T3 `responseProperties` + linkField test, `allOf` in the GitHub fixture |
| User decision C6: parent created in the flow is linked, never taken from params; child goes with its parent | T3 `createdBy`, `emptySlots`, `setInput` spread + tests; T4 run rules, teardown + tests; T5 flows.test link; T6 InputEditor default, e2e |
| §1 screens and MCP | T5 s4-11, T6 |
| §2 `flows.json` shape (steps, inputs, source, basis) | T3 s1 (types.ts) |
| §2 rule 1 resources (list/item, C2) | T3 infer `buildGroups` |
| §2 rule 2 resource order (parent first) | T3 infer `buildGroups` nearest parent |
| §2 rule 3 prefix-stripped name match | T3 infer `linkField` |
| §2 rule 4 value passing by field | T3 infer `stepInputs` |
| §2 rule 5 two candidates → empty | T3 infer `stepInputs` + test |
| §2 rule 6 required body fields only | T3 infer (uses T2 helper) |
| §2 re-inference keeps user/claude values | T3 `mergeFlows` + test |
| §2 expected GitHub result | T3 GitHub fixture test |
| §3 per-step body/header override | T4 s1-3 (`runContract` body) |
| §3 value passing, stop on empty input | T4 `runFlow` + tests |
| §3 safety switch, server-side | T4 `runFlow` safety, T5 s5-6 |
| §3 delete only created resources; reverse teardown | T4 `runFlow` (C5) + tests |
| §3 partial results saved on failure | T4 `runFlowTargets` + test |
| §3 `flow-runs/<flowId>/<target>.json`, run start time | T4 store `writeFlowRun` |
| §3 name suffix per run | T4 `runSuffix` |
| §3 no token in saved files | T4 masking test |
| §4 ① registration: 3 fields, target, grouped features, infer then flows | T6 s5-6 |
| §4 ② flow list, top bar, chart, step expand, leftovers | T6 s8-9 |
| §4 eight step states (label + colour class) | T6 s1-2, s8 |
| §4 filling empty links, basis badge, run allowed with empties | T6 s8-9 (InputEditor) |
| §5 errors: unreadable/non-OpenAPI spec | T6 Register tests |
| §5 errors: no flows inferred → empty list with reasons | T3 notes, T6 Flows empty state |
| §5 errors: no token/base URL → only real blocked | T5 run route 409 |
| §5 errors: 401/403/404 hint | T4 `FLOW_AUTH_HINT` |
| §5 errors: mock not up → build and start, fail mock only | T4 `launchTsMock`/`failedRun`, T6 e2e |
| §5 errors: DELETE failure → leftovers | T4 test |
| §5 errors: feature gone → "기능 없음", run blocked | T5 view `missingFeatures` + 409, T6 test |
| §5 tests: infer / run / ui-server / web | T3, T4, T5, T6 test files |
| §5 done 3: fill via screen and MCP | T6 InputEditor, T5 `fill_flow` |
| §5 done 7: Stripe and generators untouched | every task's full gate (`pnpm test`) |
| §5 done 1 (measure time and size, notes) | Task 1 done (issue #29, commit 7b7c3de); numbers in T2 "Measurement result" and "Not in this plan" |
