import { CatalogSchema, SourceSchema, type Feature } from "../types.js";
import type { Workspace } from "../workspace.js";
import { FeatureIdRegistry } from "./featureId.js";
import { analyzeOpenApiDocument } from "./openapi.js";

export async function analyze(ws: Workspace, system: string): Promise<string> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const features: Feature[] = [];
  const registry = new FeatureIdRegistry();
  for (const input of source.inputs) {
    if (input.kind === "openapi") {
      features.push(...analyzeOpenApiDocument(JSON.parse(input.content), registry));
    } else {
      throw new Error(`'${input.kind}' 입력 분석은 Phase 1B에서 지원합니다.`);
    }
  }
  return await ws.write(system, "catalog.json", CatalogSchema, {
    system,
    generatedAt: new Date().toISOString(),
    features,
    rejected: [],
  });
}
