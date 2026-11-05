import { ingest, type IngestOptions, type IngestResult } from "../ingest/index.js";
import { SourceSchema } from "../types.js";
import type { Workspace } from "../workspace.js";
import type { OnEvent } from "./events.js";

export interface IngestedInput {
  kind: IngestResult["inputs"][number]["kind"];
  origin: string;
  chars: number;
  cached: boolean;
  /** 숨은 콘텐츠 가능성을 보인 이유. 없으면 빈 배열. */
  harvestCandidate: string[];
  harvested: boolean;
}
export interface IngestSpecResult { system: string; file: string; inputs: IngestedInput[] }
export interface IngestSpecOptions { refresh?: boolean; harvest?: IngestOptions["harvest"]; onEvent?: OnEvent }

/** ingest를 실행하고 source.json의 수확 정보(후보 이유, 수확 여부)를 입력 순서대로 붙인다. */
export async function ingestSpec(ws: Workspace, system: string, origins: string[], opts: IngestSpecOptions = {}): Promise<IngestSpecResult> {
  const { file, inputs: read } = await ingest(ws, system, origins, {
    refresh: opts.refresh,
    harvest: opts.harvest,
    onLog: (message) => opts.onEvent?.({ stage: "ingest", message }),
  });
  const src = await ws.read(system, "source.json", SourceSchema);
  const inputs = read.map((r, n) => ({
    kind: r.kind,
    origin: r.origin,
    chars: r.chars,
    cached: r.cached,
    harvestCandidate: src.inputs[n]?.harvestCandidate?.reasons ?? [],
    harvested: Boolean(src.inputs[n]?.harvested),
  }));
  return { system, file, inputs };
}
