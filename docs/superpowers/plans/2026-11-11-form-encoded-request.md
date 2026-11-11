# form-encoded 요청 지원 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 생성 mock(TS · Java)이 `application/x-www-form-urlencoded` 요청 본문을 대괄호 중첩으로 읽어 JSON과 같은 검증을 하고, verify가 "폼 바디 요청" 계약으로 그것을 자동 확인한다.

**Architecture:** 카탈로그 · 계약 스키마는 바꾸지 않는다. TS는 공용 템플릿 파일 `src/form.ts` 하나와 라우트 한 줄, 러너의 직렬화 모듈 하나, 계약 종류 하나를 더한다. Java는 결정적 보조 파일 `specmock/runtime/FormBody.java`를 `staticFiles`로 넣고 참조 `Main.java` · 규칙 문구만 바꾼다. 설계: `docs/superpowers/specs/2026-11-11-form-encoded-request-design.md`.

**Tech Stack:** TypeScript(pnpm, vitest, Eta 템플릿, Hono 4.13, ajv coerceTypes), Java 17(Javalin 6.7, Jackson 2.19, networknt 1.5.9), zod.

**공통 규칙:** TDD(실패 테스트 → 구현 → 통과). 커밋은 Task마다 1개 이상, 메시지 끝 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. 브랜치 `feat/form-encoded-request`(main에서). `.specmock/` · `mock/`은 커밋하지 않는다. 속어 금지. 분석 상세는 `.harness/form-encoded-detail.md`(파일:줄 근거).

---

## 파일 구조

| 파일 | 역할 | 변경 |
|---|---|---|
| `packages/core/templates/ts-hono/src/form.ts.eta` | 생성 mock 공용: `parseForm` · `readBody` | 생성 |
| `packages/core/templates/ts-hono/src/route.ts.eta` | 라우트: body 읽기 한 줄 · 조건부 import | 수정(:3-4, :12) |
| `packages/core/src/generate/tsHono.ts` | `TS_FIXED_FILES`에 `src/form.ts` | 수정(:59) |
| `packages/core/src/verify/formEncode.ts` | 계약 body → 폼 문자열 직렬화 `encodeForm` | 생성 |
| `packages/core/src/verify/contracts.ts` | 러너: 폼 content-type이면 `encodeForm` | 수정(:75-80) |
| `packages/core/src/select/contracts.ts` | "폼 바디 요청" 계약 생성 + 제외 규칙 | 수정(:35-62) |
| `packages/core/templates/java/src/main/java/specmock/runtime/FormBody.java` | Java 결정적 파서 · 형 변환 | 생성 |
| `packages/core/src/generate/profiles/java.ts` | `staticFiles` · 규칙 문구 | 수정(:16, :23-27) |
| `packages/core/src/generate/validateOutput.ts` | `protectedPaths`에 FormBody 경로 | 수정(:34) |
| `packages/core/src/generate/request.ts` | RUNTIME_CONTRACT 6번 폼 구절 | 수정(:40) |
| `packages/core/templates/java/reference/Main.java`, `packages/core/test/fixtures/java-petstore/src/main/java/specmock/petstore/Main.java` | 폼이면 FormBody로 읽기 | 수정(:70-72, 동일 내용) |
| 테스트 | `packages/core/test/form.test.ts`(신규), `formEncode.test.ts`(신규), `contracts.test.ts`, `snapshot.test.ts.snap`, e2e 테스트(기존 Petstore mock 기동 테스트 파일에 추가), `javaProfile`/`request` 테스트, `java.test.ts` | |
| 문서 | README, `plugins/specmock/skills/*/SKILL.md`(생성 · verify 설명), `docs/architecture.md`, 설계 §9, 실사용 점검 notes | 수정 |

(정확한 줄 번호는 분석 시점 기준이며 구현자가 파일에서 확인한다.)

---

### Task 1: TS 공용 파일 `form.ts` — 파서와 `readBody`

**Files:**
- Create: `packages/core/templates/ts-hono/src/form.ts.eta`
- Modify: `packages/core/src/generate/tsHono.ts:59` (`TS_FIXED_FILES`)
- Test: `packages/core/test/form.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — 렌더한 `form.ts`를 임시 디렉터리에 쓰고 import해서 `parseForm`을 검사한다(렌더 함수는 `tsHono.ts`의 공개 함수 `renderTsHonoFiles(spec)`를 Petstore 스펙으로 호출해 `files["src/form.ts"]`를 얻거나, Eta로 템플릿만 렌더). 템플릿에 변수가 없으므로 내용은 고정이다.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderTsHonoFiles } from "../src/generate/tsHono.js";
import { loadPetstoreSpec } from "./helpers.js"; // 기존 테스트가 쓰는 Petstore 스펙 로더를 재사용(이름은 기존 파일에서 확인)

let parseForm: (text: string) => Record<string, unknown>;

beforeAll(async () => {
  const files = renderTsHonoFiles(loadPetstoreSpec());
  const dir = mkdtempSync(join(tmpdir(), "specmock-form-"));
  // 생성 코드는 TS지만 타입 주석만 지우면 ESM으로 실행 가능해야 한다. 어려우면 템플릿을 .js 호환 문법(타입은 JSDoc)으로 쓴다.
  writeFileSync(join(dir, "form.mjs"), stripTypes(files["src/form.ts"]));
  ({ parseForm } = await import(pathToFileURL(join(dir, "form.mjs")).href));
});

describe("parseForm", () => {
  it("평면 키", () => {
    expect(parseForm("amount=1000&currency=usd")).toEqual({ amount: "1000", currency: "usd" });
  });
  it("대괄호 중첩", () => {
    expect(parseForm("shipping[address][city]=Seoul")).toEqual({ shipping: { address: { city: "Seoul" } } });
  });
  it("빈 대괄호는 배열", () => {
    expect(parseForm("expand[]=customer&expand[]=invoice")).toEqual({ expand: ["customer", "invoice"] });
  });
  it("숫자 세그먼트는 배열(인덱스 순)", () => {
    expect(parseForm("items[1]=b&items[0]=a")).toEqual({ items: ["a", "b"] });
  });
  it("배열 안 object", () => {
    expect(parseForm("line_items[0][price]=p_1&line_items[0][quantity]=2")).toEqual({
      line_items: [{ price: "p_1", quantity: "2" }],
    });
  });
  it("같은 키 반복은 배열", () => {
    expect(parseForm("tag=a&tag=b")).toEqual({ tag: ["a", "b"] });
  });
  it("+ 와 퍼센트 인코딩", () => {
    expect(parseForm("name=Jenny+Rosen&memo=%ED%95%9C%EA%B8%80")).toEqual({ name: "Jenny Rosen", memo: "한글" });
  });
  it("__proto__ · constructor · prototype 세그먼트는 무시", () => {
    const r = parseForm("__proto__[polluted]=1&a[constructor][x]=1&b=2");
    expect(r).toEqual({ b: "2" });
    expect(({} as any).polluted).toBeUndefined();
  });
  it("깊이 32 초과 쌍은 무시", () => {
    const deep = "a" + "[b]".repeat(40) + "=1&c=1";
    expect(parseForm(deep)).toEqual({ c: "1" });
  });
  it("빈 문자열은 빈 객체", () => {
    expect(parseForm("")).toEqual({});
  });
  it("값은 변환하지 않는다(문자열 유지)", () => {
    expect(parseForm("flag=true&n=1")).toEqual({ flag: "true", n: "1" });
  });
});
```

`stripTypes`는 테스트 파일 안의 작은 도우미(`: Context`, `: string`, `Promise<unknown>` 같은 주석 제거). 복잡하면 템플릿을 `.js` 문법 + JSDoc으로 써서 그대로 import한다(생성 mock은 `tsx`/`ts-node`로 돌리므로 JS 문법도 유효).

- [ ] **Step 2: 실패 확인** — `pnpm --filter @specmock/core test -- form.test` → `files["src/form.ts"]` 없음으로 실패.

- [ ] **Step 3: 템플릿 작성** `packages/core/templates/ts-hono/src/form.ts.eta`

```ts
import type { Context } from "hono";

const FORM = "application/x-www-form-urlencoded";
const MAX_DEPTH = 32;
const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

/** `a[b][]=x` 꼴 키를 세그먼트 배열 ["a","b",""]로 나눈다. 짝이 맞지 않으면 null. */
function splitKey(key: string): string[] | null {
  const m = /^([^\[\]]+)((?:\[[^\[\]]*\])*)$/.exec(key);
  if (!m) return null;
  const segs = [m[1]];
  const re = /\[([^\[\]]*)\]/g;
  let s: RegExpExecArray | null;
  while ((s = re.exec(m[2])) !== null) segs.push(s[1]);
  return segs;
}

function isIndex(seg: string): boolean {
  return seg === "" || /^\d+$/.test(seg);
}

function assign(root: Record<string, unknown>, segs: string[], value: string): void {
  let cur: any = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (last) {
      if (Array.isArray(cur)) {
        if (seg === "") cur.push(value);
        else cur[Number(seg)] = value;
      } else if (seg in cur && !Array.isArray(cur[seg]) && typeof cur[seg] === "string") {
        cur[seg] = [cur[seg], value]; // 같은 키 반복 → 배열
      } else if (Array.isArray(cur[seg])) {
        cur[seg].push(value);
      } else {
        cur[seg] = value;
      }
      return;
    }
    const next = segs[i + 1];
    const wantArray = isIndex(next);
    if (Array.isArray(cur)) {
      const idx = seg === "" ? cur.length : Number(seg);
      if (cur[idx] === undefined || typeof cur[idx] !== "object") cur[idx] = wantArray ? [] : {};
      cur = cur[idx];
    } else {
      if (cur[seg] === undefined || typeof cur[seg] !== "object") cur[seg] = wantArray ? [] : {};
      cur = cur[seg];
    }
  }
}

/** form-encoded 본문을 대괄호 중첩 규칙으로 객체로 만든다. 값은 모두 문자열이다(형 변환은 검증기가 한다). */
export function parseForm(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const segs = splitKey(key);
    if (!segs || segs.length > MAX_DEPTH) continue;
    if (segs.some((s) => BLOCKED.has(s))) continue;
    assign(root, segs, value);
  }
  return compactArrays(root);
}

/** 인덱스가 건너뛰어진 배열의 빈 자리를 제거한다. */
function compactArrays(v: unknown): any {
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(compactArrays);
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as object)) (v as any)[k] = compactArrays((v as any)[k]);
  }
  return v;
}

/** 요청 본문을 읽는다. form-encoded면 parseForm, 그 밖은 JSON 시도(실패하면 undefined). */
export async function readBody(c: Context): Promise<unknown> {
  const mt = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mt === FORM) {
    const text = await c.req.text();
    return text.length === 0 ? undefined : parseForm(text);
  }
  return c.req.json().catch(() => undefined);
}
```

`tsHono.ts:59` `TS_FIXED_FILES`에 `"src/form.ts"`를 추가한다(`src/validate.ts` 뒤).

- [ ] **Step 4: 통과 확인** — `pnpm --filter @specmock/core test -- form.test` 11개 통과. `items[1]=b&items[0]=a` → `["a","b"]`(인덱스 자리 채움 뒤 compact).

- [ ] **Step 5: 커밋** — `feat(generate): TS mock 공용 form.ts(parseForm · readBody) 추가`

---

### Task 2: 라우트 템플릿이 `readBody`를 쓰고, 스냅샷 갱신

**Files:**
- Modify: `packages/core/templates/ts-hono/src/route.ts.eta:3-4, :12`
- Test: `packages/core/test/__snapshots__/snapshot.test.ts.snap`(갱신), 기존 tsHono 렌더 테스트에 1개 추가

- [ ] **Step 1: 실패 테스트** — tsHono 렌더 테스트 파일에:

```ts
it("body 있는 그룹 파일은 readBody를 import하고, GET만 있는 그룹 파일은 import하지 않는다", () => {
  const files = renderTsHonoFiles(loadPetstoreSpec());
  const pets = files["src/routes/pets.ts"];
  expect(pets).toContain('import { readBody } from "../form.js";');
  expect(pets).toContain("await readBody(c)");
  expect(pets).not.toContain("c.req.json()");
  const store = files["src/routes/store.ts"]; // GET만 있는 그룹(Petstore에서 확인; 없으면 GET만 있는 최소 스펙으로 대체)
  expect(store).not.toContain("readBody");
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --filter @specmock/core test -- tsHono`

- [ ] **Step 3: 템플릿 수정** — `route.ts.eta` 머리 import 뒤에(템플릿의 기능 목록 변수 이름은 파일에서 확인; 아래는 `features`로 가정):

```eta
<% if (it.features.some((f) => f.hasBody)) { %>import { readBody } from "../form.js";
<% } %>
```

:12 `const body = <%= f.hasBody ? "await c.req.json().catch(() => undefined)" : "undefined" %>;` → `const body = <%= f.hasBody ? "await readBody(c)" : "undefined" %>;`

- [ ] **Step 4: 스냅샷 갱신 · 확인** — `pnpm --filter @specmock/core test -- snapshot -u` 뒤 `git diff test/__snapshots__/snapshot.test.ts.snap`이 **두 케이스 각 3줄 안팎**(`src/form.ts` 추가, `src/routes/pets.ts` 해시; `contracts/createPet.json`은 Task 4에서 바뀜)인지 확인. 다른 줄이 바뀌면 원인 확인. 골든(`test/golden/*/expected-catalog.json`)은 불변.

- [ ] **Step 5: 전체** — `pnpm typecheck && pnpm test`. 커밋 `feat(generate): 라우트가 readBody로 본문을 읽음(form-encoded 수용)`

---

### Task 3: 러너 직렬화 `encodeForm`과 content-type 분기

**Files:**
- Create: `packages/core/src/verify/formEncode.ts`
- Modify: `packages/core/src/verify/contracts.ts:75-80`
- Test: `packages/core/test/formEncode.test.ts`(신규), 기존 verify 러너 테스트에 2개

- [ ] **Step 1: 실패 테스트** `formEncode.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { encodeForm } from "../src/verify/formEncode.js";

describe("encodeForm", () => {
  it("평면 · 숫자 · boolean", () => {
    expect(encodeForm({ amount: 1000, currency: "usd", confirm: true })).toBe("amount=1000&currency=usd&confirm=true");
  });
  it("중첩 object는 대괄호", () => {
    expect(encodeForm({ shipping: { address: { city: "Seoul" } } })).toBe("shipping%5Baddress%5D%5Bcity%5D=Seoul");
  });
  it("배열은 인덱스, 배열 안 object", () => {
    expect(encodeForm({ expand: ["a", "b"], items: [{ price: "p", quantity: 2 }] })).toBe(
      "expand%5B0%5D=a&expand%5B1%5D=b&items%5B0%5D%5Bprice%5D=p&items%5B0%5D%5Bquantity%5D=2",
    );
  });
  it("null · 빈 object · 빈 배열은 생략", () => {
    expect(encodeForm({ a: null, b: {}, c: [], d: "x" })).toBe("d=x");
  });
  it("공백과 한글은 URLSearchParams 인코딩", () => {
    expect(encodeForm({ name: "Jenny Rosen", memo: "한글" })).toBe("name=Jenny+Rosen&memo=%ED%95%9C%EA%B8%80");
  });
});
```

왕복 테스트는 `form.test.ts`에 1개: `parseForm(encodeForm(x))`가 x의 모든 leaf를 문자열로 바꾼 것과 같음(`{a:{b:1}, c:[true,"x"]}` → `{a:{b:"1"}, c:["true","x"]}`).

러너 테스트(기존 verify 러너 테스트 파일, 로컬 Hono/`http` 서버로 요청을 받아 검사):

```ts
it("계약 headers의 content-type이 form이면 본문을 form-encoded로 보낸다", async () => {
  // 서버는 받은 content-type과 raw body를 기록
  // 계약: method POST, body {amount: 1000, meta: {k: "v"}}, headers {"content-type": "application/x-www-form-urlencoded"}
  // 기대: content-type 헤더 "application/x-www-form-urlencoded", body "amount=1000&meta%5Bk%5D=v"
});
it("content-type 지정이 없으면 기존처럼 JSON", async () => { /* 기대: application/json, JSON.stringify */ });
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** `formEncode.ts`

```ts
/** 계약 body(object)를 Stripe 규약의 form-encoded 문자열로 만든다.
 *  중첩 object `a[b]`, 배열 `a[0]`, boolean `true`/`false`, number는 String(n).
 *  null · 빈 object · 빈 배열은 생략한다. */
export function encodeForm(body: unknown): string {
  const params = new URLSearchParams();
  const walk = (value: unknown, key: string | null): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, key === null ? String(i) : `${key}[${i}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, key === null ? k : `${key}[${k}]`);
      }
      return;
    }
    if (key === null) return; // 최상위 스칼라는 form으로 표현 불가 → 생략
    params.append(key, typeof value === "string" ? value : String(value));
  };
  walk(body, null);
  return params.toString();
}

export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export function isFormContentType(headers: Record<string, string>): boolean {
  const ct = headers["content-type"] ?? "";
  return ct.split(";")[0].trim().toLowerCase() === FORM_CONTENT_TYPE;
}
```

`verify/contracts.ts:75-80`:

```ts
const headers = mergeHeaders(c.request.body !== null ? { "content-type": "application/json" } : {}, c.request.headers, opts.headers ?? {});
const body =
  c.request.body === null ? undefined
  : isFormContentType(headers) ? encodeForm(c.request.body)
  : JSON.stringify(c.request.body);
```

`mergeHeaders`가 소문자 키를 보장하는지 확인(:55-59). 아니면 `isFormContentType`에서 키를 소문자로 찾는다.

- [ ] **Step 4: 통과 확인** — `pnpm --filter @specmock/core test -- formEncode verify form`

- [ ] **Step 5: 커밋** — `feat(verify): 계약 content-type이 form이면 본문을 form-encoded로 전송(encodeForm)`

---

### Task 4: "폼 바디 요청" 계약

**Files:**
- Modify: `packages/core/src/select/contracts.ts:35-62`
- Test: `packages/core/test/contracts.test.ts`(새 4개, 길이 단언 4개 갱신), 스냅샷(`contracts/createPet.json` 해시)

- [ ] **Step 1: 실패 테스트** `contracts.test.ts`에 추가(기존 fixture 도우미 이름은 파일에서 확인):

```ts
describe("폼 바디 요청 계약", () => {
  it("object body가 있는 기능에 마지막 계약으로 추가되고 headers에 form content-type이 있다", () => {
    const cs = buildContracts(featureWithBody({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }));
    const form = cs[cs.length - 1];
    expect(form.name).toBe("폼 바디 요청");
    expect(form.request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(form.request.body).toEqual(cs[0].request.body); // object 그대로
    expect(form.expect).toEqual(cs[0].expect);
  });
  it("body 없는 기능에는 만들지 않는다", () => {
    expect(buildContracts(featureWithoutBody()).some((c) => c.name === "폼 바디 요청")).toBe(false);
  });
  it("properties 없는 body(array 등)에는 만들지 않는다", () => {
    expect(buildContracts(featureWithBody({ type: "array", items: { type: "string" } })).some((c) => c.name === "폼 바디 요청")).toBe(false);
  });
  it("필수 속성의 샘플이 빈 object · 빈 배열이면 만들지 않는다", () => {
    // 필수 address의 스키마가 {type:"object"}(properties 없음) → 샘플 {} → 직렬화하면 사라짐
    const cs = buildContracts(featureWithBody({ type: "object", properties: { address: { type: "object" } }, required: ["address"] }));
    expect(cs.some((c) => c.name === "폼 바디 요청")).toBe(false);
  });
});
```

기존 길이 단언 갱신: :35 2→3, :46(no4xx) 1→2, :80 1→2, :81 2→3(각 줄의 fixture가 object body인지 확인하고 맞춰 바꾼다. :44 body null · :92 array body는 불변).

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** `select/contracts.ts` `buildContracts` 끝에:

```ts
import { encodeForm, FORM_CONTENT_TYPE } from "../verify/formEncode.js"; // 순환 import가 생기면 formEncode.ts를 src/form/encode.ts 같은 중립 위치로 옮긴다

function formContractAllowed(bodySchema: unknown, sample: unknown): boolean {
  if (!bodySchema || typeof bodySchema !== "object") return false;
  const s = bodySchema as { type?: unknown; properties?: Record<string, unknown>; required?: string[] };
  if (s.type !== "object" || !s.properties || typeof sample !== "object" || sample === null) return false;
  // 직렬화 후에도 필수 속성이 남아야 한다
  const encoded = new URLSearchParams(encodeForm(sample));
  const presentTop = new Set([...encoded.keys()].map((k) => k.split("[")[0]));
  return (s.required ?? []).every((r) => presentTop.has(r));
}

// buildContracts 안, 기존 두 계약을 만든 뒤:
if (body !== null && formContractAllowed(feature.request.body, body)) {
  contracts.push({
    name: "폼 바디 요청",
    request: { ...normal.request, headers: { "content-type": FORM_CONTENT_TYPE } },
    expect: normal.expect,
  });
}
```

`normal`은 "정상 요청" 계약 객체(기존 코드의 변수 이름에 맞춘다). 계약 이름 상수가 있으면(`NORMAL_CONTRACT` 등) 같은 방식으로 `FORM_CONTRACT`를 둔다.

- [ ] **Step 4: 통과 · 스냅샷** — `pnpm --filter @specmock/core test -- contracts` 통과 후 `snapshot -u`; diff가 `contracts/createPet.json` 해시(두 케이스)만 추가로 바뀌는지 확인. `specmock.lock.json`은 스냅샷 대상 밖.

- [ ] **Step 5: 전체** `pnpm typecheck && pnpm test`. 커밋 `feat(select): object body 기능에 "폼 바디 요청" 계약 추가`

---

### Task 5: e2e — 생성 Petstore mock에 폼 요청

**Files:**
- Test: 생성 mock을 실제로 띄워 요청하는 기존 e2e/verify 테스트 파일(예: `packages/core/test/e2e*.test.ts` 또는 `verify.test.ts`; 파일에서 확인)에 4개 추가

- [ ] **Step 1: 테스트 작성** — Petstore mock을 생성 · 기동(기존 도우미 재사용) 뒤:

```ts
it("form-encoded POST /pets 가 200", async () => {
  const r = await fetch(`${base}/pets`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=rex&tag=dog" });
  expect(r.status).toBe(200); // createPet의 성공 status에 맞춘다(201이면 201)
});
it("charset 접미가 있어도 form으로 읽는다", async () => {
  const r = await fetch(`${base}/pets`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "name=rex" });
  expect(r.status).toBe(200);
});
it("form 값이 스키마 타입에 맞지 않으면 400", async () => {
  // Petstore NewPet에 integer 속성이 없으면, 필수 name 누락으로 대신 검사: body "tag=dog" → 400 required
  const r = await fetch(`${base}/pets`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "tag=dog" });
  expect(r.status).toBe(400);
});
it("multipart는 본문 없음으로 취급(기존 동작)", async () => {
  const r = await fetch(`${base}/pets`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x--" });
  expect(r.status).toBe(400); // body 필수 → must have required property 'body'
});
```

integer 변환 경로(`"1"` → 1)는 Petstore 스펙에 integer body 속성이 있는 기능이 있으면 그것으로, 없으면 `form.test.ts` 왕복 + ajv 실측(분석 §2)으로 대신한다고 설계 §9에 적는다.

- [ ] **Step 2: 통과 확인** — 이 Task는 Task 1~4가 끝났으므로 바로 통과해야 한다. 실패하면 템플릿을 고친다.

- [ ] **Step 3: 커밋** — `test(e2e): 생성 mock의 form-encoded 요청 4건`

---

### Task 6: Java 결정적 파일 `FormBody.java`와 참조 · 규칙

**Files:**
- Create: `packages/core/templates/java/src/main/java/specmock/runtime/FormBody.java`
- Modify: `packages/core/src/generate/profiles/java.ts:16, :23-27`, `packages/core/src/generate/validateOutput.ts:34`, `packages/core/src/generate/request.ts:40`
- Modify: `packages/core/templates/java/reference/Main.java:70-72`, `packages/core/test/fixtures/java-petstore/src/main/java/specmock/petstore/Main.java`(같은 내용)
- Test: javaProfile 테스트(staticFiles · protectedPaths 포함 1~2개), request 테스트 1개(RUNTIME_CONTRACT에 form 구절), `java.test.ts`(JDK 17: fixture Main이 폼 계약 통과)

- [ ] **Step 1: 실패 테스트**

```ts
it("java 프로필 staticFiles에 FormBody.java가 있고 protectedPaths에도 있다", () => {
  expect(javaProfile.staticFiles).toContain("src/main/java/specmock/runtime/FormBody.java");
  expect(protectedPathsFor(javaProfile)).toContain("src/main/java/specmock/runtime/FormBody.java"); // 이름은 validateOutput.ts에서 확인
});
it("요청 문구가 form-encoded 규칙을 담는다", () => {
  const req = buildRequest(spec, javaProfile);
  expect(req).toContain("application/x-www-form-urlencoded");
  expect(req).toContain("specmock.runtime.FormBody");
});
```

`java.test.ts`는 fixture Petstore를 빌드 · 기동해 contracts를 돌린다 — Task 4로 createPet에 "폼 바디 요청" 계약이 생기므로 fixture `Main.java`가 그대로면 **실패해야 한다**(그 실패를 먼저 확인).

- [ ] **Step 2: 실패 확인** — `pnpm --filter @specmock/core test -- java`(JDK 필요; `java.test.ts`는 느리고 네트워크를 쓰므로 단독 실행).

- [ ] **Step 3: `FormBody.java` 작성**

```java
package specmock.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.TextNode;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** application/x-www-form-urlencoded 본문을 대괄호 중첩 규칙으로 읽고, 스키마 타입에 맞춰 문자열을 변환한다.
 *  specmock이 생성 시 그대로 넣는 파일이다. TS 공용 파일 src/form.ts와 같은 규칙. */
public final class FormBody {
  public static final String CONTENT_TYPE = "application/x-www-form-urlencoded";
  private static final int MAX_DEPTH = 32;
  private static final Set<String> BLOCKED = Set.of("__proto__", "constructor", "prototype");
  private static final Pattern KEY = Pattern.compile("^([^\\[\\]]+)((?:\\[[^\\[\\]]*\\])*)$");
  private static final Pattern SEG = Pattern.compile("\\[([^\\[\\]]*)\\]");
  private static final JsonNodeFactory F = JsonNodeFactory.instance;

  private FormBody() {}

  public static boolean isForm(String contentType) {
    if (contentType == null) return false;
    return contentType.split(";")[0].trim().toLowerCase().equals(CONTENT_TYPE);
  }

  /** 본문을 ObjectNode로. 값은 모두 TextNode. 비어 있으면 빈 ObjectNode. */
  public static ObjectNode parse(String text) {
    ObjectNode root = F.objectNode();
    if (text == null || text.isEmpty()) return root;
    for (String pair : text.split("&")) {
      if (pair.isEmpty()) continue;
      int eq = pair.indexOf('=');
      String k = decode(eq < 0 ? pair : pair.substring(0, eq));
      String v = eq < 0 ? "" : decode(pair.substring(eq + 1));
      List<String> segs = splitKey(k);
      if (segs == null || segs.size() > MAX_DEPTH) continue;
      if (segs.stream().anyMatch(BLOCKED::contains)) continue;
      assign(root, segs, v);
    }
    return root;
  }

  /** schema(JSON Schema)의 properties · items를 따라 integer/number/boolean 자리의 문자열을 변환한다. 변환 불가는 그대로. */
  public static JsonNode coerce(JsonNode schema, JsonNode value) {
    if (schema == null || value == null) return value;
    if (value.isTextual()) {
      String t = typeOf(schema);
      String s = value.asText();
      try {
        if ("integer".equals(t)) return F.numberNode(Long.parseLong(s));
        if ("number".equals(t)) return F.numberNode(Double.parseDouble(s));
      } catch (NumberFormatException ignored) { return value; }
      if ("boolean".equals(t)) {
        if ("true".equals(s)) return F.booleanNode(true);
        if ("false".equals(s)) return F.booleanNode(false);
      }
      return value;
    }
    if (value.isObject() && schema.has("properties")) {
      ObjectNode o = (ObjectNode) value;
      JsonNode props = schema.get("properties");
      List<String> names = new ArrayList<>();
      o.fieldNames().forEachRemaining(names::add);
      for (String n : names) if (props.has(n)) o.set(n, coerce(props.get(n), o.get(n)));
      return o;
    }
    if (value.isArray() && schema.has("items")) {
      ArrayNode a = (ArrayNode) value;
      for (int i = 0; i < a.size(); i++) a.set(i, coerce(schema.get("items"), a.get(i)));
      return a;
    }
    return value;
  }

  private static String typeOf(JsonNode schema) {
    JsonNode t = schema.get("type");
    if (t == null) return null;
    if (t.isTextual()) return t.asText();
    if (t.isArray()) { // ["object","integer"] 같은 경우: 스칼라 타입 하나를 고른다
      for (JsonNode x : t) { String s = x.asText(); if (s.equals("integer") || s.equals("number") || s.equals("boolean")) return s; }
    }
    return null;
  }

  private static String decode(String s) { return URLDecoder.decode(s, StandardCharsets.UTF_8); } // '+' → 공백 포함

  private static List<String> splitKey(String key) {
    Matcher m = KEY.matcher(key);
    if (!m.matches()) return null;
    List<String> segs = new ArrayList<>();
    segs.add(m.group(1));
    Matcher s = SEG.matcher(m.group(2));
    while (s.find()) segs.add(s.group(1));
    return segs;
  }

  private static boolean isIndex(String seg) { return seg.isEmpty() || seg.chars().allMatch(Character::isDigit); }

  private static void assign(JsonNode root, List<String> segs, String value) {
    JsonNode cur = root;
    for (int i = 0; i < segs.size(); i++) {
      String seg = segs.get(i);
      boolean last = i == segs.size() - 1;
      if (last) { setLeaf(cur, seg, value); return; }
      boolean wantArray = isIndex(segs.get(i + 1));
      cur = child(cur, seg, wantArray);
      if (cur == null) return;
    }
  }

  private static void setLeaf(JsonNode cur, String seg, String value) {
    TextNode v = F.textNode(value);
    if (cur.isArray()) {
      ArrayNode a = (ArrayNode) cur;
      if (seg.isEmpty()) a.add(v); else setAt(a, Integer.parseInt(seg), v);
    } else if (cur.isObject()) {
      ObjectNode o = (ObjectNode) cur;
      JsonNode existing = o.get(seg);
      if (existing == null) o.set(seg, v);
      else if (existing.isArray()) ((ArrayNode) existing).add(v);
      else if (existing.isTextual()) { ArrayNode a = F.arrayNode(); a.add(existing); a.add(v); o.set(seg, a); }
      else o.set(seg, v);
    }
  }

  private static JsonNode child(JsonNode cur, String seg, boolean wantArray) {
    if (cur.isArray()) {
      ArrayNode a = (ArrayNode) cur;
      int idx = seg.isEmpty() ? a.size() : Integer.parseInt(seg);
      JsonNode n = idx < a.size() ? a.get(idx) : null;
      if (n == null || !n.isContainerNode()) { n = wantArray ? F.arrayNode() : F.objectNode(); setAt(a, idx, n); }
      return n;
    }
    if (cur.isObject()) {
      ObjectNode o = (ObjectNode) cur;
      JsonNode n = o.get(seg);
      if (n == null || !n.isContainerNode()) { n = wantArray ? F.arrayNode() : F.objectNode(); o.set(seg, n); }
      return n;
    }
    return null;
  }

  /** 인덱스 자리를 채우며 set. 빈 자리는 NullNode로 두고, 파싱 끝에 compact하지 않아도 Stripe 계약 샘플은 연속 인덱스다. */
  private static void setAt(ArrayNode a, int idx, JsonNode n) {
    while (a.size() <= idx) a.addNull();
    a.set(idx, n);
  }
}
```

(`setAt`의 NullNode 빈 자리는 TS `compactArrays`와 달리 남는다. 인덱스가 연속이면 차이가 없다. 차이를 없애려면 parse 끝에 배열의 null 항목을 제거하는 compact를 넣는다 — 넣어라, TS와 같게.)

- [ ] **Step 4: 생성기 연결**
  - `java.ts:23-27` `staticFiles`에 `"src/main/java/specmock/runtime/FormBody.java"` 추가.
  - `validateOutput.ts:34` `protectedPaths`에 같은 경로 추가(statics를 그대로 쓰는 구조면 자동).
  - `java.ts:16` 검증 규칙 뒤에 한 줄: `요청 content-type이 application/x-www-form-urlencoded면 본문을 specmock.runtime.FormBody.parse로 읽고 FormBody.coerce(bodySchema, node)로 타입을 맞춘 뒤 같은 검증을 한다. FormBody.java는 제공되는 파일이니 직접 작성하거나 수정하지 마라.`
  - `request.ts:40` RUNTIME_CONTRACT 6번에 같은 뜻의 구절 한 문장.
  - `reference/Main.java:70-72`와 fixture `Main.java`:

```java
if (r.hasBody() && !ctx.body().isBlank()) {
  if (FormBody.isForm(ctx.contentType())) {
    JsonNode bodySchema = r.schema().path("properties").path("body");
    data.set("body", FormBody.coerce(bodySchema, FormBody.parse(ctx.body())));
  } else {
    data.set("body", JSON.readTree(ctx.body()));
  }
}
```

(`r.schema()` 접근 방식은 참조 Main의 기존 코드에 맞춘다; `import specmock.runtime.FormBody;` 추가.) fixture 쪽은 `src/main/java/specmock/runtime/FormBody.java`도 fixture 디렉터리에 복사해 두어야 빌드된다(fixture는 생성 결과의 표본이므로 statics 포함이 자연스럽다; java.test가 생성기를 통해 statics를 넣는 구조면 복사 불필요 — 파일에서 확인).

- [ ] **Step 5: 통과 확인** — `pnpm --filter @specmock/core test -- javaProfile request` 그리고 `java.test.ts` 단독(JDK 17). `diff templates/java/reference/Main.java test/fixtures/java-petstore/.../Main.java` → 같음.

- [ ] **Step 6: 커밋 2개** — `feat(java): 결정적 FormBody.java(파서 · 형 변환) 추가, staticFiles · protectedPaths 등록`, `feat(java): 참조 Main · 규칙 문구에 form-encoded 읽기 반영`

---

### Task 7: 문서 · 실측 · 기록

**Files:**
- Modify: `README.md`(생성 mock이 폼 요청을 읽음, multipart 제외, Java mock 1회 재생성), `plugins/specmock/skills/*/SKILL.md`(verify 계약 종류 3개), `docs/architecture.md`(해당 절), 설계 §9 구현 중 변경, `docs/superpowers/notes/real-use-check-stripe.md`

- [ ] **Step 1: 문서** — 위 파일에 설계 §6의 네 가지 동작 변화를 한 문장씩. 속어 금지.
- [ ] **Step 2: `pnpm llm:check --java` 1회** — 통과 여부, 시도 횟수, 소요, `llm-usage.jsonl` 합계(입력 · 출력 · 캐시 · API 환산 $)를 실사용 점검 §3에 행으로 기록(단계 "Java 참조 재생성 실측").
- [ ] **Step 3: Stripe 재확인(LLM 0회)** — `pnpm build` 뒤 `node packages/cli/dist/cli.js generate stripe --lang ts --force` → `verify stripe`(폼 계약 포함 건수 · 통과 수) → mock 기동 후 curl: `POST /v1/payment_intents -d "amount=1000&currency=usd&automatic_payment_methods[enabled]=true"` → 200, `-d "amount=abc&currency=usd"` → 400 `must be integer`, `POST /v1/customers -d "name=x&address[city]=Seoul"` → 200. §3에 행 추가, §4 8행 상태 `완료(PR #N)`, §4에 후속 행 2개(query 대괄호, oneOf 이중 변환). `.specmock/` · `mock/`은 커밋하지 않는다.
- [ ] **Step 4: 전체** — `pnpm typecheck && pnpm test`(테스트 수 기록). 커밋 `docs: form-encoded 지원 문서 · 실사용 점검 §3 · §4 갱신`
