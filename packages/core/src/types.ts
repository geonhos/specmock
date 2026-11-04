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

export const SourceInputSchema = z.object({
  kind: z.enum(["openapi", "html", "markdown", "pdf", "text"]),
  origin: z.string(),
  fetchedAt: z.string(),
  contentHash: z.string(),
  content: z.string(),
  harvested: z.unknown().optional(),
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
  rejected: z.array(z.object({ raw: z.unknown(), reason: z.string() })).default([]),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export const SelectionSchema = z.object({
  system: z.string().min(1),
  catalogHash: z.string(),
  selected: z.array(z.string()),
  resolved: z.array(z.string()),
  updatedAt: z.string(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const FixtureSchema = z.object({
  status: z.number().int(),
  body: z.unknown(),
  source: z.enum(["spec-example", "doc-sample", "schema-generated", "empty"]),
});
export type Fixture = z.infer<typeof FixtureSchema>;

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
  language: z.enum(["ts"]),
  features: z.array(MockFeatureSchema),
  notMocked: z.array(z.object({ id: z.string(), method: HttpMethod, path: z.string() })),
  contracts: z.array(ContractSchema),
  assumptions: z.array(z.string()),
});
export type MockSpec = z.infer<typeof MockSpecSchema>;
