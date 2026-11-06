import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CatalogSchema, GenerateInfoSchema, SelectionSchema, SourceSchema, summarizeChunks, type Selection, type Workspace } from "@specmock/core";
import type { SystemOverview, SystemSummary } from "./api-types.js";

const SYSTEM_DIR = /^[\p{L}\p{N}_-]+$/u;

async function mtime(ws: Workspace, system: string, name: string): Promise<number | null> {
  try { return (await stat(ws.file(system, name))).mtimeMs; } catch { return null; }
}

/** 시스템 하나의 단계 요약. source.json이 없으면 등록된 시스템이 아니므로 not-found 오류(파일 없음)를 낸다. */
export async function summarizeSystem(ws: Workspace, system: string): Promise<SystemSummary> {
  const source = await ws.read(system, "source.json", SourceSchema);
  const [catalog, selection, generate, coverage, request] = await Promise.all(
    ["catalog.json", "selection.json", "generate.json", "coverage.md", "analyze-request.json"].map((n) => mtime(ws, system, n)),
  );
  const summary: SystemSummary = {
    name: system,
    kind: source.inputs[0]?.kind ?? null,
    steps: { registered: true, analyzed: catalog !== null, selected: selection !== null, generated: generate !== null, verified: coverage !== null },
    stale: {
      select: catalog !== null && selection !== null && catalog > selection,
      generate: selection !== null && generate !== null && selection > generate,
      verify: generate !== null && coverage !== null && generate > coverage,
    },
  };
  if (request !== null) {
    try {
      const chunks = await summarizeChunks(ws, system);
      summary.chunks = { done: chunks.filter((c) => c.done).length, total: chunks.length };
    } catch { /* 깨진 요청 파일은 청크 수를 생략한다 */ }
  }
  return summary;
}

/** 등록된(source.json이 있는) 시스템만, 이름순으로. 빈 디렉터리·이름 규칙 밖 디렉터리는 뺀다. */
export async function listSystems(ws: Workspace): Promise<SystemSummary[]> {
  let entries;
  try { entries = await readdir(ws.root, { withFileTypes: true }); } catch { return []; }
  const names = entries.filter((e) => e.isDirectory() && SYSTEM_DIR.test(e.name)).map((e) => e.name).sort();
  const out: SystemSummary[] = [];
  for (const name of names) {
    try { out.push(await summarizeSystem(ws, name)); } catch { /* 등록 전·깨진 디렉터리는 목록에서 뺀다 */ }
  }
  return out;
}

export async function readSelection(ws: Workspace, system: string): Promise<Selection | null> {
  await ws.read(system, "source.json", SourceSchema); // 없는 시스템은 null이 아니라 not-found
  return (await ws.exists(system, "selection.json")) ? ws.read(system, "selection.json", SelectionSchema) : null;
}

export async function systemOverview(ws: Workspace, root: string, system: string): Promise<SystemOverview> {
  const summary = await summarizeSystem(ws, system);
  const source = await ws.read(system, "source.json", SourceSchema);
  const catalog = summary.steps.analyzed ? await ws.read(system, "catalog.json", CatalogSchema) : null;
  const generate = (await ws.exists(system, "generate.json")) ? await ws.read(system, "generate.json", GenerateInfoSchema) : null;
  const coverage = summary.steps.verified ? await readFile(ws.file(system, "coverage.md"), "utf8") : null;
  return {
    summary,
    source: source.inputs,
    analyze: catalog ? "catalog" : summary.chunks ? "prepared" : "none",
    catalogTotal: catalog?.features.length ?? 0,
    selection: await readSelection(ws, system),
    generate,
    coverage,
    defaultOutDir: generate?.outDir ?? path.join(root, "mock", system),
  };
}
