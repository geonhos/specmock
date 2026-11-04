import path from "node:path";
import { MockSpecSchema } from "../types.js";
import type { Workspace } from "../workspace.js";
import { renderTsHono, type GenerateReport } from "./tsHono.js";

export interface GenerateOptions {
  outDir?: string;
  force?: boolean;
}

export function defaultMockDir(system: string): string {
  return path.resolve("mock", system);
}

export async function generate(ws: Workspace, system: string, opts: GenerateOptions = {}): Promise<GenerateReport> {
  const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
  const outDir = opts.outDir ?? defaultMockDir(system);
  if (spec.language !== "ts") throw new Error(`'${spec.language}' 생성은 아직 지원하지 않습니다.`);
  return await renderTsHono(spec, outDir, { force: opts.force });
}
