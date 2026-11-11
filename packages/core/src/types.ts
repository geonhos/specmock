import { z } from "zod";

export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const ExampleSchema = z.object({
  source: z.enum(["spec-example", "doc-sample"]),
  body: z.unknown(),
});

export const ResponseSchema = z.object({
  schema: JsonSchema.nullable(),
  examples: z.array(ExampleSchema),
});

export const ParamSchema = z.object({
  schema: JsonSchema.nullable(),
  required: z.boolean(),
});

export const FeatureSchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  title: z.string(),
  summary: z.string().default(""),
  method: HttpMethod,
  path: z.string().startsWith("/"),
  request: z.object({
    params: z.record(z.string(), ParamSchema),
    query: z.record(z.string(), ParamSchema),
    headers: z.record(z.string(), ParamSchema),
    body: JsonSchema.nullable(),
  }),
  responses: z.record(z.string(), ResponseSchema),
  auth: z.enum(["bearer", "apiKey", "basic", "none", "unknown"]),
  provenance: z.enum(["openapi", "doc-extracted", "inferred"]),
  confidence: z.number().min(0).max(1),
  hasExample: z.boolean(),
  evidence: z.array(z.object({ chunk: z.number(), quote: z.string() })).default([]),
  notes: z.array(z.string()).default([]),
});
export type Feature = z.infer<typeof FeatureSchema>;

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
export type SourceInput = z.infer<typeof SourceInputSchema>;

export const SourceSchema = z.object({
  system: z.string().min(1),
  inputs: z.array(SourceInputSchema).min(1),
});
export type Source = z.infer<typeof SourceSchema>;

export const CatalogSchema = z.object({
  system: z.string().min(1),
  generatedAt: z.string(),
  features: z.array(FeatureSchema),
  rejected: z.array(z.object({ raw: z.unknown(), reason: z.string(), chunk: z.number().int().optional() })).default([]),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export const SelectionSchema = z.object({
  system: z.string().min(1),
  catalogHash: z.string(),
  selected: z.array(z.string()),
  resolved: z.array(z.string()),
  /** 선택 시점의 카탈로그 기능 id. 이후 카탈로그가 바뀌었을 때 선택 시점 기준으로 비교한다. */
  catalogIds: z.array(z.string()).optional(),
  /** true면 selected가 기능 id 그대로(UI·--interactive), false면 표현식. 없으면(옛 파일) 추정한다. */
  literal: z.boolean().optional(),
  updatedAt: z.string(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const FixtureSchema = z.object({
  status: z.number().int(),
  body: z.unknown(),
  source: z.enum(["recorded", "spec-example", "doc-sample", "schema-generated", "empty"]),
});
export type Fixture = z.infer<typeof FixtureSchema>;
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

export const ContractSchema = z.object({
  featureId: z.string(),
  name: z.string(),
  request: z.object({
    method: HttpMethod,
    path: z.string(),
    headers: z.record(z.string(), z.string()),
    query: z.record(z.string(), z.string()),
    body: z.unknown().nullable(),
  }),
  expect: z.object({
    status: z.number().int(),
    schema: JsonSchema.nullable(),
  }),
});
export type Contract = z.infer<typeof ContractSchema>;

export const MockFeatureSchema = FeatureSchema.extend({
  fixtures: z.array(FixtureSchema).min(1),
});
export type MockFeature = z.infer<typeof MockFeatureSchema>;

export const MockSpecSchema = z.object({
  system: z.string().min(1),
  baseUrl: z.string(),
  features: z.array(MockFeatureSchema),
  notMocked: z.array(z.object({ id: z.string(), method: HttpMethod, path: z.string() })),
  contracts: z.array(ContractSchema),
  assumptions: z.array(z.string()),
});
export type MockSpec = z.infer<typeof MockSpecSchema>;

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
export type GenerateInfo = z.infer<typeof GenerateInfoSchema>;

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
 * `claude --json-schema`에 넘길 JSON Schema(draft-7, `$ref` 없음). zod 변환 결과에서 `$schema`를 뗀다.
 * 자유 객체(JsonSchema 자리)는 `anyOf: [{type:"object"}, {type:"null"}]` 로 나온다.
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
  /** 청크 본문의 sha256. extract가 문서 변경으로 낡은 추출 결과를 가려내는 데 쓴다. */
  contentHash: z.string().optional(),
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
