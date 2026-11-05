import { SourceSchema, type Catalog, type CatalogDiff, type Feature } from "../types.js";
import type { Workspace } from "../workspace.js";
import { writeCatalogWithDiff } from "./catalogWrite.js";
import { FeatureIdRegistry } from "./featureId.js";
import { analyzeOpenApiDocument } from "./openapi.js";
import { needsLlm } from "./prepare.js";

export interface AnalyzeOutcome {
  /** "openapi": LLM 없이 끝남. "needs-llm": 문서 입력이 있어 prepare → extract → merge가 필요. */
  mode: "openapi" | "needs-llm";
  catalogFile?: string;
  diff?: CatalogDiff;
}

/**
 * 입력이 전부 OpenAPI면 바로 카탈로그를 쓴다. 문서 입력이 하나라도 있으면 아무것도 쓰지 않고 "needs-llm"을 돌려주며,
 * 호출자가 prepare → (LLM 추출) → merge를 돌려야 한다.
 */
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

export { writeCatalogWithDiff } from "./catalogWrite.js";
