import type { McpServer } from "@modelcontextprotocol/server";
import { analyzeSpec, CatalogSchema, getChunk, ingestSpec, submitExtraction, summarizeChunks, type OnEvent, type Workspace } from "@specmock/core";
import { z } from "zod";
import { absPath, guard, ok } from "../result.js";

export const SystemArg = z.string().describe("시스템 이름 (.specmock/<system>/ 디렉터리 이름). 문자·숫자·-·_만. 예: petstore");
const Loose = z.looseObject({});
const ChunkSummary = z.object({ index: z.number(), heading: z.string(), chars: z.number(), contentHash: z.string(), done: z.boolean() });

export function registerAnalysisTools(server: McpServer, ws: Workspace, onEvent: OnEvent): void {
  server.registerTool("ingest_spec", {
    title: "스펙 읽기",
    description: "스펙 파일 경로(프로젝트 루트 기준) 또는 URL을 읽어 .specmock/<system>/source.json으로 정규화한다. OpenAPI · HTML · Markdown · PDF · 텍스트. 웹 문서의 숨은 콘텐츠는 ego-browser가 있으면 수확한다. 다음: analyze_spec",
    inputSchema: z.object({
      system: SystemArg,
      origins: z.array(z.string()).min(1).describe("파일 경로 또는 URL 목록"),
      refresh: z.boolean().optional().describe("원문 캐시를 무시하고 다시 읽는다"),
      harvest: z.enum(["auto", "always", "never"]).optional().describe("숨은 콘텐츠 수확. 기본 auto"),
    }),
    outputSchema: z.object({
      system: z.string(), file: z.string(),
      inputs: z.array(z.object({ kind: z.string(), origin: z.string(), chars: z.number(), cached: z.boolean(), harvestCandidate: z.array(z.string()), harvested: z.boolean() })),
    }),
  }, guard(async ({ system, origins, refresh, harvest }) => {
    const r = await ingestSpec(ws, system, origins, { refresh, harvest: harvest ?? "auto", onEvent });
    const data = { ...r, file: absPath(ws.dir(system), r.file) };
    const hidden = r.inputs.filter((i) => i.harvestCandidate.length && !i.harvested).length;
    return ok(`source.json 작성: ${data.file} (입력 ${r.inputs.length}개${hidden ? `, 수확하지 않은 숨은 콘텐츠 후보 ${hidden}개 — harvest: "always"로 다시 읽을 수 있음` : ""}). 다음: analyze_spec`, data);
  }));

  server.registerTool("analyze_spec", {
    title: "기능 카탈로그 만들기",
    description: "source.json을 분석한다. OpenAPI만 있으면 바로 카탈로그를 만들고 mode=catalog. 문서 입력이 있으면 mode=needs-extraction과 함께 추출 프롬프트·출력 스키마·청크 목록(본문 없음)을 돌려준다. 그때는 done=false인 청크마다 get_chunk → prompt대로 추출 → submit_extraction, 끝나면 merge_extractions. refresh=true면 기존 추출 결과를 지우고 시작한다.",
    inputSchema: z.object({ system: SystemArg, refresh: z.boolean().optional() }),
    outputSchema: z.object({
      mode: z.enum(["catalog", "needs-extraction"]),
      features: z.number().optional(),
      diff: Loose.nullable().optional(),
      prompt: z.string().optional(),
      schema: Loose.optional(),
      chunks: z.array(ChunkSummary).optional(),
    }),
  }, guard(async ({ system, refresh }) => {
    const r = await analyzeSpec(ws, system, { llm: "session", refresh, onEvent });
    if (r.mode === "catalog") {
      const catalog = await ws.read(system, "catalog.json", CatalogSchema);
      const diff = r.via === "openapi" ? r.diff ?? null : r.merge.diff;
      return ok(`카탈로그: 기능 ${catalog.features.length}개. 다음: list_features`, { mode: "catalog" as const, features: catalog.features.length, diff: (diff ?? null) as Record<string, unknown> | null });
    }
    const chunks = await summarizeChunks(ws, system, r.request);
    const pending = chunks.filter((c) => !c.done).length;
    return ok(
      `문서 입력: 청크 ${chunks.length}개 중 ${pending}개 추출 필요. done=false인 청크마다 get_chunk → prompt대로 추출 → submit_extraction. 끝나면 merge_extractions.`,
      { mode: "needs-extraction" as const, prompt: r.request.prompt, schema: r.request.schema as Record<string, unknown>, chunks },
    );
  }));

  server.registerTool("get_chunk", {
    title: "청크 본문 읽기",
    description: "analyze_spec이 알려 준 청크 하나의 본문을 돌려준다. 한 번에 하나씩 읽고 추출해 제출한다.",
    inputSchema: z.object({ system: SystemArg, index: z.number().int().min(0) }),
    outputSchema: z.object({ index: z.number(), heading: z.string(), contentHash: z.string(), content: z.string() }),
  }, guard(async ({ system, index }) => {
    const c = await getChunk(ws, system, index);
    return ok(`청크 ${c.index}: ${c.heading || "(제목 없음)"}`, { ...c });
  }));

  server.registerTool("submit_extraction", {
    title: "청크 추출 결과 제출",
    description: "청크 하나의 추출 결과 { endpoints: [...] }(analyze_spec의 schema)를 제출한다. contentHash는 get_chunk가 준 값. 검증에 실패하면 ok=false와 errors(경로·이유)를 돌려주므로 고쳐서 다시 제출한다. reason=stale-chunk면 analyze_spec부터 다시.",
    inputSchema: z.object({
      system: SystemArg,
      index: z.number().int().min(0),
      contentHash: z.string(),
      result: z.record(z.string(), z.unknown()).describe("{ endpoints: [...] } — analyze_spec의 schema를 따른다"),
    }),
    outputSchema: z.object({
      ok: z.boolean(), file: z.string().optional(),
      reason: z.enum(["stale-chunk", "unknown-chunk", "invalid"]).optional(),
      errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  }, guard(async ({ system, index, contentHash, result }) => {
    const r = await submitExtraction(ws, system, { index, contentHash, result });
    if (r.ok) return ok(`청크 ${index} 저장`, { ...r, file: absPath(ws.dir(system), r.file) });
    const first = r.errors?.[0];
    return ok(`청크 ${index} 거부(${r.reason})${first ? `: ${first.path} ${first.message}` : ""}. 고쳐서 다시 제출하세요.`, r);
  }));

  server.registerTool("merge_extractions", {
    title: "추출 결과 병합",
    description: "제출된 청크 추출 결과를 검증·근거 대조·병합해 catalog.json을 만든다. 빠진 청크가 있어도 진행하고 missingChunks에 번호를 담는다. 다음: list_features",
    inputSchema: z.object({ system: SystemArg }),
    outputSchema: z.object({ features: z.number(), rejected: z.number(), missingChunks: z.array(z.number()), invalidChunks: z.array(z.number()), diff: Loose }),
  }, guard(async ({ system }) => {
    const r = await analyzeSpec(ws, system, { step: "merge", onEvent });
    if (r.mode !== "catalog" || r.via !== "merge") throw new Error("merge 결과가 아닙니다.");
    const { features, rejected, missingChunks, invalidChunks, diff } = r.merge;
    const tail = missingChunks.length ? ` 미추출 청크 ${missingChunks.join(", ")} — get_chunk/submit_extraction 후 다시 merge 가능.` : "";
    return ok(`기능 ${features}개, 거부 ${rejected}개.${tail} 다음: list_features`, { features, rejected, missingChunks, invalidChunks, diff: diff as Record<string, unknown> });
  }));
}
