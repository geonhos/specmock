import type { OpenAPIV2, OpenAPIV3 } from "openapi-types";
import type { Feature, HttpMethod, JsonSchema } from "../types.js";
import { deriveFeatureId, deriveGroup, FeatureIdRegistry, methodsByShape, pathShape } from "./featureId.js";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type AnyDoc = OpenAPIV3.Document | OpenAPIV2.Document;
type AnyOperation = OpenAPIV3.OperationObject | OpenAPIV2.OperationObject;
type AnyParam = OpenAPIV3.ParameterObject | OpenAPIV2.Parameter;

function isV3(doc: AnyDoc): doc is OpenAPIV3.Document {
  return "openapi" in doc;
}

function stripSchema(schema: unknown): JsonSchema | null {
  if (!schema || typeof schema !== "object") return null;
  // dereference 이후이므로 $ref는 없다. 그대로 복사한다.
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

function jsonContent(content: Record<string, OpenAPIV3.MediaTypeObject> | undefined): OpenAPIV3.MediaTypeObject | undefined {
  if (!content) return undefined;
  const key = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content)[0];
  return key ? content[key] : undefined;
}

function collectExamples(media: OpenAPIV3.MediaTypeObject | undefined, schema: JsonSchema | null): Feature["responses"][string]["examples"] {
  const out: Feature["responses"][string]["examples"] = [];
  if (media?.example !== undefined) out.push({ source: "spec-example", body: media.example });
  if (media?.examples) {
    for (const ex of Object.values(media.examples)) {
      const value = (ex as OpenAPIV3.ExampleObject).value;
      if (value !== undefined) out.push({ source: "spec-example", body: value });
    }
  }
  if (out.length === 0 && schema && schema.example !== undefined) out.push({ source: "spec-example", body: schema.example });
  if (out.length === 0 && Array.isArray(schema?.examples) && schema.examples.length > 0) {
    out.push({ source: "spec-example", body: schema.examples[0] });
  }
  return out;
}

function resolveAuth(doc: AnyDoc, op: AnyOperation): Feature["auth"] {
  const requirements = op.security ?? doc.security ?? [];
  if (requirements.length === 0) return "none";
  const schemes: Record<string, { type?: string; scheme?: string }> = isV3(doc)
    ? ((doc.components?.securitySchemes as Record<string, { type?: string; scheme?: string }>) ?? {})
    : ((doc.securityDefinitions as Record<string, { type?: string; scheme?: string }>) ?? {});
  for (const req of requirements) {
    for (const name of Object.keys(req)) {
      const s = schemes[name];
      if (!s) continue;
      if (s.type === "apiKey") return "apiKey";
      if (s.type === "http" && s.scheme === "bearer") return "bearer";
      if (s.type === "http" && s.scheme === "basic") return "basic";
      if (s.type === "basic") return "basic";
      if (s.type === "oauth2" || s.type === "openIdConnect") return "bearer";
    }
  }
  return "unknown";
}

function v2ParamSchema(p: OpenAPIV2.GeneralParameterObject): JsonSchema {
  const keys = ["type", "format", "enum", "items", "minimum", "maximum", "pattern", "default", "minLength", "maxLength"] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((p as unknown as Record<string, unknown>)[k] !== undefined) out[k] = (p as unknown as Record<string, unknown>)[k];
  if (out.type === "file") {
    out.type = "string";
    out.format = "binary";
  }
  return out as JsonSchema;
}

function buildRequest(doc: AnyDoc, pathParams: AnyParam[], op: AnyOperation): Feature["request"] {
  const request: Feature["request"] = { params: {}, query: {}, headers: {}, body: null };
  const opParams = (op.parameters as AnyParam[] | undefined) ?? [];
  // operation-level params override path-level ones with the same name + location
  const merged: AnyParam[] = [
    ...pathParams.filter((pp) => !opParams.some((op2) => op2.name === pp.name && op2.in === pp.in)),
    ...opParams,
  ];
  for (const p of merged) {
    const entry = { schema: stripSchema("schema" in p ? p.schema : v2ParamSchema(p as OpenAPIV2.GeneralParameterObject)), required: Boolean(p.required) };
    if (p.in === "path") request.params[p.name] = { ...entry, required: true };
    else if (p.in === "query") request.query[p.name] = entry;
    else if (p.in === "header") request.headers[p.name] = entry;
    else if (p.in === "body") request.body = stripSchema((p as OpenAPIV2.InBodyParameterObject).schema);
  }
  const formData = merged.filter((p) => p.in === "formData") as OpenAPIV2.GeneralParameterObject[];
  if (formData.length > 0 && request.body === null) {
    request.body = {
      type: "object",
      properties: Object.fromEntries(formData.map((p) => [p.name, v2ParamSchema(p)])),
      required: formData.filter((p) => p.required).map((p) => p.name),
    };
  }
  if (isV3(doc)) {
    const body = (op as OpenAPIV3.OperationObject).requestBody as OpenAPIV3.RequestBodyObject | undefined;
    const media = jsonContent(body?.content);
    if (media?.schema) request.body = stripSchema(media.schema);
  }
  return request;
}

function buildResponses(doc: AnyDoc, op: AnyOperation): Feature["responses"] {
  const out: Feature["responses"] = {};
  for (const [status, resRaw] of Object.entries(op.responses ?? {})) {
    if (!/^\d{3}$/.test(status)) continue; // "default"는 생략
    if (isV3(doc)) {
      const res = resRaw as OpenAPIV3.ResponseObject;
      const media = jsonContent(res.content);
      const schema = stripSchema(media?.schema);
      out[status] = { schema, examples: collectExamples(media, schema) };
    } else {
      const res = resRaw as OpenAPIV2.ResponseObject;
      const schema = stripSchema(res.schema);
      const examples: Feature["responses"][string]["examples"] = [];
      const ex = res.examples as Record<string, unknown> | undefined;
      if (ex) for (const v of Object.values(ex)) examples.push({ source: "spec-example", body: v });
      out[status] = { schema, examples };
    }
  }
  return out;
}

export function analyzeOpenApiDocument(doc: AnyDoc, registry: FeatureIdRegistry = new FeatureIdRegistry()): Feature[] {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const ops: { pathKey: string; method: HttpMethod; op: AnyOperation; pathParams: AnyParam[] }[] = [];
  for (const [pathKey, item] of Object.entries(paths)) {
    if (!item) continue;
    const pathParams = (item.parameters as AnyParam[] | undefined) ?? [];
    for (const method of METHODS) {
      const op = item[method.toLowerCase()] as AnyOperation | undefined;
      if (op) ops.push({ pathKey, method, op, pathParams });
    }
  }
  // Explicit operationIds claim their ids first so derived ids cannot steal them.
  const ids = new Map<number, string>();
  const siblings = methodsByShape(ops.map(({ pathKey, method }) => ({ method, path: pathKey })));
  const hasExplicit = (o: AnyOperation) => typeof o.operationId === "string" && o.operationId.trim().length > 0;
  for (const explicit of [true, false]) {
    ops.forEach(({ pathKey, method, op }, i) => {
      if (hasExplicit(op) !== explicit) return;
      ids.set(i, registry.claim(deriveFeatureId({ method, path: pathKey, operationId: op.operationId, siblingMethods: siblings.get(pathShape(pathKey)), shapes: siblings })));
    });
  }
  return ops.map(({ pathKey, method, op, pathParams }, i) => {
    const responses = buildResponses(doc, op);
    return {
      id: ids.get(i) as string,
      group: deriveGroup({ path: pathKey, tags: op.tags }),
      title: op.summary ?? `${method} ${pathKey}`,
      summary: op.description ?? "",
      method,
      path: pathKey,
      request: buildRequest(doc, pathParams, op),
      responses,
      auth: resolveAuth(doc, op),
      provenance: "openapi" as const,
      confidence: 1,
      hasExample: Object.values(responses).some((r) => r.examples.length > 0),
      evidence: [],
      notes: op.deprecated ? ["deprecated"] : [],
    };
  });
}
