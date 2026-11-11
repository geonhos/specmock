# form-encoded 요청 지원 설계

작성일: 2026-11-11
배경: 실사용 점검 기록 `docs/superpowers/notes/real-use-check-stripe.md` §4 8행. 조사 상세는 `.harness/form-encoded-detail.md`(저장소 밖 작업 파일).
상태: 설계 승인(2026-11-11), 구현 전

## 1. 문제

웹 API에 데이터를 보내는 방식은 크게 둘이다.

| | JSON 방식 | 폼(form) 방식 `application/x-www-form-urlencoded` |
|---|---|---|
| 모양 | `{"amount": 1000, "currency": "usd"}` | `amount=1000&currency=usd` |
| 중첩 값 | `{"shipping": {"city": "Seoul"}}` | `shipping[city]=Seoul` (대괄호) |
| 배열 | `{"expand": ["customer"]}` | `expand[]=customer` 또는 `expand[0]=customer` |
| 값의 종류 | 숫자 · 참/거짓이 구별됨 | 전부 문자열. `1000`도 `"1000"` |
| 쓰는 곳 | 대부분의 최신 API | Stripe(모든 POST), 오래된 API, HTML 폼 |

specmock이 생성한 mock 서버는 지금 JSON만 읽는다(`templates/ts-hono/src/route.ts.eta:12` `c.req.json().catch(() => undefined)`). 폼 방식 요청은 "본문 없음"으로 취급되어

- body가 필수인 기능: 400 `must have required property 'body'`
- body가 선택인 기능: **검증 없이** 200 (실사용 점검 §3 18행의 200은 이 결과다)

둘 다 틀린 동작이다. mock의 핵심 가치는 "요청이 계약에 맞는지 확인"인데 폼 방식에서는 그 확인이 비어 있다.

## 2. 결정 (2026-11-11)

| 결정 | 선택 | 이유 |
|---|---|---|
| 인코딩을 어디서 알아내나 | **런타임 수용**: 카탈로그는 바꾸지 않고 생성 mock이 요청의 content-type을 보고 JSON · 폼 둘 다 읽음 | LLM 비용 0, 스키마 변경 0. mock이 실제 API보다 느슨해지는 점(JSON도 통과)은 받아들임 |
| 폼 읽기 수준 | **대괄호 중첩 + 형 변환**: `a[b]=1` → `{a:{b:1}}`, `a[]=x` · `a[0]=x` → `{a:["x"]}` 뒤 스키마 타입대로 문자열 → 숫자 · 참/거짓 변환 후 같은 검증 | 추출된 중첩 속성(payment_intents.create 15개 중 object 다수)이 검증되려면 중첩이 필요 |
| 범위 | **TS + Java 둘 다**, verify에 "폼 바디 요청" 계약 추가 | 3A 원칙(두 언어 같은 동작). 계약이 Java LLM 출력의 규칙 준수를 자동으로 확인 |
| query의 대괄호(`created[gte]=…`) | **후속** | 이번은 body만. query는 지금처럼 평면 키로 두어 동작 불변. 실사용 점검 §4에 행 추가 |
| multipart/form-data | **범위 밖** | 파일 업로드용. 지금처럼 본문 없음 취급 |

## 3. TS 생성 mock

### 3.1 공용 파일 `src/form.ts`

`templates/ts-hono/src/form.ts.eta`를 추가하고 `packages/core/src/generate/tsHono.ts` `TS_FIXED_FILES`(:59)에 `"src/form.ts"`를 넣는다. 렌더 루프가 자동으로 쓴다. 내용은 두 함수.

```ts
export function parseForm(text: string): Record<string, unknown>
export async function readBody(c: Context): Promise<unknown>
```

`readBody(c)`:
1. `mt = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase()` (charset 접미 무시)
2. `mt === "application/x-www-form-urlencoded"` → `text = await c.req.text()`; 비어 있으면 `undefined`, 아니면 `parseForm(text)`
3. 그 밖(헤더 없음 · JSON · multipart 등) → 기존과 같이 `c.req.json().catch(() => undefined)`

`parseForm(text)`:
- `new URLSearchParams(text)`로 쌍을 얻는다(`+` → 공백, 퍼센트 디코드 포함. charset 처리 불필요).
- 키를 `name` + `[seg]…`로 분해해 트리를 만든다. `a[b]` → object, `a[]` 또는 숫자 세그먼트(`a[0]`) → 배열, 같은 키 반복 → 배열. 값은 모두 문자열로 둔다(형 변환은 검증기가 함).
- 방어: 세그먼트가 `__proto__` · `constructor` · `prototype`이면 그 쌍을 무시한다. 깊이 상한 32(초과하는 쌍 무시), 배열 인덱스 상한 1000(초과하는 쌍 무시; 희소 배열로 이벤트 루프가 멈추는 것을 막는다). 결과 객체는 `Object.create(null)`이 아닌 일반 객체로 돌려도 되지만 위 세그먼트 차단은 필수.
- 배열 판단은 스키마를 보지 않는다(숫자 · 빈 세그먼트면 배열). `metadata[0]=x`처럼 숫자 키 map이 배열이 되는 드문 경우는 받아들인다(TS · Java 같은 규칙, 공용 파일 단순화).

### 3.2 라우트 템플릿

`route.ts.eta:12` 한 줄: `await c.req.json().catch(() => undefined)` → `await readBody(c)`. import는 그룹 파일에 body 있는 기능이 하나라도 있을 때만 넣는다(GET만 있는 그룹 파일은 바이트 불변). `hasBody`가 false인 기능은 지금처럼 `undefined`.

### 3.3 형 변환

TS는 별도 변환기를 두지 않는다. 생성 mock의 ajv가 `coerceTypes: true`(`validate.ts.eta:5`)라 body 중첩 leaf · 배열 항목까지 스키마 type대로 제자리 변환한다. 실측(`.harness/form-encoded-detail.md` §2): `"1"` → 1, `"true"` → true, `["1","2"]` → `[1,2]`, `"abc"`(integer) → 400 `must be integer`, `""`(integer) → 400. **변환이 안 되는 값은 문자열로 남고 검증기가 400을 낸다** — 이것이 형 변환 실패 정책이다(Java도 같게).

### 3.4 변경 전 → 후 (`mock/stripe/src/routes/Payment_Intents.ts:29-34` 기준)

```ts
// 전
const body = await c.req.json().catch(() => undefined);
// 후  (파일 머리에 import { readBody } from "../form.js";)
const body = await readBody(c);
```

## 4. 계약(verify)

### 4.1 "폼 바디 요청" 계약

`packages/core/src/select/contracts.ts` `buildContracts`(:35-62)에 세 번째 종류를 추가한다. 조건과 내용:

- 대상: `request.body`가 있고 `type: object` + `properties`가 있는 기능(메서드 무관, 사실상 POST · PUT · PATCH). body 없는 기능은 제외.
- 제외 규칙: "정상 요청" 샘플 body를 §4.2 규칙으로 직렬화했을 때 **필수 속성이 사라지는 기능**(필수 속성의 샘플이 빈 object · 빈 배열 · null)은 폼 계약을 만들지 않는다. Stripe 샘플에 `address: {}` 같은 빈 컨테이너가 많다(§4 9행).
- 내용: method · path · query는 "정상 요청"과 같고, `headers: { "content-type": "application/x-www-form-urlencoded" }`, **body는 object 그대로**(직렬화하지 않음), expect는 "정상 요청"과 같음. 이름 `"폼 바디 요청"`. 배열 **끝**에 둔다(기존 `contracts[0]` · `[1]` 단언 유지).
- `ContractSchema`(`src/types.ts:135`)는 바꾸지 않는다(headers 필드 있음, body `unknown`).

### 4.2 러너의 직렬화

`packages/core/src/verify/contracts.ts` 전송부(:75-80)는 지금 body를 무조건 `JSON.stringify`한다. 병합된 headers의 content-type이 `application/x-www-form-urlencoded`면 새 모듈 `src/verify/formEncode.ts`의 `encodeForm(body)`로 직렬화해 보낸다. 그 밖은 기존 그대로.

`encodeForm` 규칙(Stripe 규약):
- 중첩 object `a[b]=1`, 배열 `a[0]=x`(인덱스), 배열 안 object `a[0][b]=1`
- boolean `true` / `false`, number `String(n)`, string 그대로(URLSearchParams 인코딩)
- null · 빈 object · 빈 배열은 **생략**
- 배열을 `a[]`가 아닌 인덱스로 쓰는 이유: object 배열(`a[][b]`)이 모호함. 파서는 `a[]` · `a[0]` · 반복 키를 모두 받으므로 사용자 영향 없음.

record(`record/index.ts:103`)는 "정상 요청"만 보내므로 영향 없다. 다만 사용자가 `target.json` headers에 폼 content-type을 주면 같은 러너 경로로 실제 Stripe에 폼 요청을 보낼 수 있게 된다(부수 효과, 문서에 한 줄).

## 5. Java

### 5.1 결정적 보조 파일 `FormBody.java`

LLM이 매번 파서를 짜면 품질 편차와 재시도 비용이 생긴다. `mvnw`처럼 **생성기가 그대로 넣는 파일**로 둔다.

- 파일: `templates/java/src/main/java/specmock/runtime/FormBody.java`. 패키지는 system 이름과 무관한 `specmock.runtime`(staticFiles는 템플릿 변수 없이 복사하므로 고정 패키지 필수).
- `generate/profiles/java.ts` `staticFiles`(:23-27)에 경로 추가, `validateOutput.ts:34` `protectedPaths`에 추가(LLM 쓰기 차단). `index.ts:118`(증분 입력 제외) · `:193`(sourceFiles 해시 제외) · `session.ts:158`은 statics를 이미 처리한다.
- 내용: `static JsonNode parse(String text)`(§3.1과 같은 규칙: 대괄호 트리, `[]` · 숫자 → 배열, 반복 키 → 배열, proto 세그먼트 무시, 깊이 32) + `static JsonNode coerce(JsonNode schema, JsonNode value)`(schema의 `properties` · `items`를 따라 재귀, leaf의 `type`이 integer/number/boolean이면 변환, 실패하면 문자열 유지, `oneOf`/`anyOf`는 손대지 않음). networknt `typeLoose`는 쓰지 않는다(동작 미확인, JSON 검증도 느슨해짐).

### 5.2 참조 · 규칙

- `templates/java/reference/Main.java:70-72`: `if (r.hasBody() && !ctx.body().isBlank())` 안에서 content-type이 폼이면 `FormBody.coerce(bodySchema, FormBody.parse(ctx.body()))`, 아니면 기존 `JSON.readTree`. `import specmock.runtime.FormBody;`.
- `test/fixtures/java-petstore/.../Main.java`는 reference와 바이트 동일 → 같이 갱신.
- `java.ts:16` 검증 규칙에 한 줄: "content-type이 `application/x-www-form-urlencoded`면 `specmock.runtime.FormBody.parse` · `coerce`로 읽는다(파일은 제공됨, 직접 짜지 마라)". `request.ts:40` RUNTIME_CONTRACT 6번에 같은 구절.
- `inputHash`(`util/specHash.ts:9-17`)에는 contracts가 들어가고 규칙 문구는 들어가지 않는다. 폼 계약이 추가되면 **POST + body가 있는 기존 Java mock은 업그레이드 뒤 `select`를 다시 한 뒤의 첫 generate에서 LLM을 다시 부른다**(계약은 `mockspec.json`에 있어 select가 갱신해야 바뀐다). README · 스킬 문서에 적는다.

## 6. 동작 변화(사용자에게 알릴 것)

- 폼 방식 요청이 읽히고 검증된다. 지금까지 선택 body POST에 폼으로 보내면 200이던 것은 검증을 건너뛴 결과였고, 앞으로 잘못된 값(`amount=abc`)은 400이다.
- verify 계약이 POST 기능마다 최대 1건 늘어난다(Petstore createPet +1, Stripe 최대 +10).
- Java mock은 계약 변경으로 한 번 재생성된다(`select`를 다시 한 뒤의 첫 generate에서).
- multipart와 query 대괄호는 이번 범위 밖.

## 7. 테스트와 영향

| 항목 | 내용 |
|---|---|
| 파서(TS) | 렌더한 `form.ts`를 임시 디렉터리에서 import해 단위 ~10개: 평면, 중첩, `[]`, `[0]`, `[0][b]`, 반복 키, `+` · UTF-8, proto 세그먼트, 깊이 상한, 빈 본문 |
| 직렬화 | `encodeForm` ~5개 + `encodeForm → parseForm` 왕복 1개 + 러너가 content-type을 보고 직렬화하는지 2개 |
| 계약 | 새 4개(생성 · 제외 규칙 · 배열 끝 · headers) + 기존 `contracts.test.ts` 길이 단언 4개(:35 2→3, :46 1→2, :80 1→2, :81 2→3) 갱신 |
| e2e | 생성 Petstore mock에 폼 · charset 접미 · content-type 없음 · multipart 4건 |
| Java | `javaProfile` staticFiles · protectedPaths 1~2개, `request.test` 1개, `java.test.ts`(JDK)에서 폼 계약 통과 |
| 스냅샷 · 골든 | `snapshot.test.ts.snap` 두 케이스 각 3줄(`src/form.ts` 추가, `contracts/createPet.json`, `src/routes/pets.ts`) = 6줄 갱신. 골든 0개 불변. `specmock.lock.json` 해시 변경 |
| 실측 | `pnpm llm:check --java` 1회(지난 기록 80~105초, 비용은 이번에 처음 `llm-usage.jsonl`로 측정) → 실사용 점검 §3에 기록. Stripe `generate --lang ts --force` → verify(폼 계약 포함) → curl 폼 요청 200 · `amount=abc` 400 |

예상 새 테스트 약 28~30개.

## 8. 후속(기록만)

- query 대괄호(`created[gte]`): 같은 파서를 `c.req.query()` 대신 URL search에 적용. TS · Java 양쪽, 테스트 +6 정도.
- `oneOf: [integer, boolean]` 스키마에서 ajv coerceTypes가 값을 두 번 바꿔 JSON에서도 400이 나는 기존 문제.
- `""`(Stripe의 "값 비우기" 표기)이 integer 자리에서 400. 필요하면 "빈 문자열은 생략"을 파서 옵션으로.

## 9. 구현 중 변경

- **`compactArrays`**: 인덱스를 건너뛴 뒤 생기는 빈 자리를 파싱 끝에 제거한다(`items[1]=b&items[0]=a` → `["a","b"]`). Java는 NullNode 빈 자리를 같은 방식으로 제거한다.
- **키 충돌**: 오류 없이 한쪽을 택하고 검증기가 판단하게 둔다. `a=1&a[b]=2` → `{a:{b:"2"}}`, `a=1&a[]=2` → `{a:["2"]}`, `a[0]=x&a[b]=y` → `{a:["x"]}`(배열에 둘 수 없는 키는 버림). 이때 값이 사라지는 것은 후속 과제다.
- **깊이 32**는 이름을 포함한 세그먼트 수다(`a[b]`는 2). **배열 인덱스 상한 1000**(§3.1)을 추가했다. `a[4294967294]=x` 한 쌍이 희소 배열을 만들어 이벤트 루프를 65초 멈춘 리뷰 지적에 따른 것이며, 첫 세그먼트(이름)는 인덱스로 보지 않는다.
- **`a[][b]=1&a[][c]=2`**는 원소 2개(`[{b:"1"},{c:"2"}]`)가 된다. 빈 세그먼트는 매번 새 원소를 추가한다.
- **`encodeForm`**(계약 직렬화): 최상위 스칼라는 생략하고, 최상위 배열은 `0=…` 꼴로 쓴다.
- **폼 계약 제외 규칙**은 최상위 필수 속성만 확인한다. 하위 필수 속성이 빈 컨테이너라 직렬화에서 사라지면 폼 계약만 400이 된다(후속).
- **`opts.headers`**(`--header`)가 content-type을 주면 모든 body 계약의 인코딩이 그것을 따른다(계약 헤더보다 뒤가 이긴다).
- **integer 변환 e2e**는 Petstore에 integer body 속성이 없어 ajv 실측(`/tmp` 스크립트)으로 대체했다. e2e 4건은 한 `it`으로 묶었다.
- **Java**: `FormBody.parse`도 인덱스 상한 1000과 빈 자리 제거를 같게 적용한다. 정수 변환은 `Long.parseLong`, 실수는 유한한 값만 받는다. `java.test.ts`는 생성기가 `FormBody.java`를 넣으므로 fixture에 복사하지 않고, 계약 총수만 3 → 4로 바뀌었다.
- **TS · Java 동등성 테스트**(`java.test.ts`, `test/fixtures/formbody-probe/Probe.java`): 입력 24건의 `parse` 결과가 TS `parseForm`과 JSON 문자열까지 같고, 큰 인덱스 2건은 1초 안에 끝난다. `coerce` 9건은 Java 단독 기대값으로 확인한다. 차이는 없었다.
- **후속 (25)** Java `coerce`와 TS ajv coerceTypes 차이: integer 자리의 `1.0` · `1e3` · ` 1` · 20자리 정수는 TS 200 · Java 400, number 자리 `1f`는 Java 200 · TS 400, `0x10`은 TS 200 · Java 400, `oneOf[integer,string]`에 `5`는 TS 400 · Java 200. 개선안: `BigDecimal` 기반 변환으로 맞춘다.
- **후속 (26)** 비정상 입력 차이: 잘못된 `%`(`a+b%ZZ`)는 Java가 쌍을 원문대로 두고 TS는 `+`만 공백으로 바꾼다. 앞자리 0 인덱스(`a[00001]`)는 Java가 버리고 TS는 받는다. 맨 앞 `?`는 TS만 제거한다.
