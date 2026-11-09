import type { McpServer } from "@modelcontextprotocol/server";
import { findFeature, generate, listFeatures, select, verifyMock, type OnEvent, type Workspace } from "@specmock/core";
import { z } from "zod";
import { absPath, guard, ok, withProgress } from "../result.js";
import { SystemArg } from "./analysis.js";

const Loose = z.looseObject({});

/** coverage.md에서 contract 표 앞까지(선택 수 · fixture 출처 · 신뢰도 · 가정). */
function coverageSummary(md: string): string {
  return md.split("\n## contract test")[0]!.trimEnd();
}

export function registerMockTools(server: McpServer, ws: Workspace, onEvent: OnEvent, opts: { heartbeatMs?: number } = {}): void {
  server.registerTool("list_features", {
    title: "기능 목록",
    description: "카탈로그를 번호·그룹·출처·신뢰도·샘플 여부와 함께 표로 돌려준다. 표(table)를 사용자에게 그대로 보여 주고 어떤 기능이 필요한지 묻는다. 번호는 select_features 표현식과 같다.",
    inputSchema: z.object({ system: SystemArg, group: z.string().optional().describe("이 그룹만 보여준다. 번호는 전체 기준") }),
    outputSchema: z.object({
      system: z.string(), total: z.number(), group: z.string().nullable(), table: z.string(),
      rows: z.array(z.object({
        index: z.number(), id: z.string(), group: z.string(), method: z.string(), path: z.string(),
        provenance: z.string(), confidence: z.number(), hasExample: z.boolean(), warnings: z.array(z.string()),
      })),
    }),
  }, guard(async ({ system, group }) => {
    const r = await listFeatures(ws, system, { group });
    return { content: [{ type: "text" as const, text: r.table }], structuredContent: r };
  }));

  server.registerTool("show_feature", {
    title: "기능 상세",
    description: "기능 하나의 요청·응답 스키마, 샘플, 근거 인용, 주의(notes)를 돌려준다. ⚠ 표시 행은 이것으로 근거를 보여 주고 포함 여부를 묻는다.",
    inputSchema: z.object({ system: SystemArg, id: z.string().describe("기능 id (list_features의 id)") }),
    outputSchema: z.object({ feature: Loose }),
  }, guard(async ({ system, id }) => {
    const f = await findFeature(ws, system, id);
    return ok(`${f.id} (${f.group}) ${f.method} ${f.path} · 출처 ${f.provenance} · 신뢰도 ${f.confidence.toFixed(1)}`, { feature: f as unknown as Record<string, unknown> });
  }));

  server.registerTool("select_features", {
    title: "기능 선택",
    description: "선택 표현식으로 기능을 골라 selection.json과 mockspec.json을 만든다. 표현식: 번호(1,3-5), id, id 글롭(users.*), group:<그룹>, method:GET, has:example, confidence>=0.8, all, -제외. mode=add/remove는 이전 선택에 더하거나 뺀다(기본 set). 다음: generate_mock",
    inputSchema: z.object({
      system: SystemArg,
      exprs: z.array(z.string()).min(1),
      mode: z.enum(["set", "add", "remove"]).optional(),
    }),
    outputSchema: z.object({ selected: z.array(z.string()), resolved: z.array(z.string()), catalogChanged: z.boolean(), catalogDiff: Loose.optional() }),
  }, guard(async ({ system, exprs, mode }) => {
    const r = await select(ws, system, exprs, { add: mode === "add", remove: mode === "remove" });
    const warn = r.catalogChanged ? " 주의: 이전 선택 이후 카탈로그가 바뀌었습니다(catalogDiff 참고)." : "";
    const data = { selected: r.selected, resolved: r.resolved, catalogChanged: r.catalogChanged, ...(r.catalogDiff ? { catalogDiff: r.catalogDiff as Record<string, unknown> } : {}) };
    return ok(`선택 ${r.resolved.length}개: ${r.resolved.join(", ")}.${warn} 다음: generate_mock`, data);
  }));

  server.registerTool("generate_mock", {
    title: "mock 서버 생성",
    description: "선택한 기능으로 TypeScript(Hono) mock 서버 프로젝트를 만든다. 기본 위치 ./mock/<system>/. 사용자가 고친 fixture는 force 없이는 보존한다. 다음: verify_mock",
    inputSchema: z.object({
      system: SystemArg,
      outDir: z.string().optional().describe("출력 디렉터리(프로젝트 루트 기준). 기본 ./mock/<system>"),
      force: z.boolean().optional().describe("사용자가 수정한 fixture도 덮어쓴다. 또한 specmock이 만들지 않은(specmock.lock.json 없는) 비어 있지 않은 디렉터리도 덮어쓴다(package.json·src 등 교체, routes·contracts 정리). 반드시 사용자에게 경로와 덮어쓸 내용을 알리고 확인받은 뒤에만 true"),
    }),
    outputSchema: z.object({ outDir: z.string(), written: z.array(z.string()), preserved: z.array(z.string()), orphaned: z.array(z.string()) }),
  }, guard(async ({ system, outDir, force }) => {
    const r = await generate(ws, system, { outDir, force });
    return ok(`생성: ${r.outDir} (파일 ${r.written.length}개, 보존 ${r.preserved.length}, 남겨진 fixture ${r.orphaned.length}). 실행: cd ${r.outDir} && npm install && npm start. 다음: verify_mock`, { outDir: r.outDir, written: r.written, preserved: r.preserved, orphaned: r.orphaned });
  }));

  server.registerTool("verify_mock", {
    title: "contract test",
    description: "mock 서버를 띄워 contract test를 실행하고 .specmock/<system>/coverage.md를 쓴다. 대상은 dir → 마지막 generate_mock 위치 → ./mock/<system>. 의존성이 없으면 npm install을 먼저 실행하므로 처음엔 오래 걸릴 수 있다.",
    inputSchema: z.object({ system: SystemArg, dir: z.string().optional() }),
    outputSchema: z.object({
      total: z.number(), passed: z.number(), failed: z.number(),
      failures: z.array(z.object({ featureId: z.string(), name: z.string(), expectedStatus: z.number(), actualStatus: z.number().nullable(), errors: z.array(z.string()) })),
      runtime: z.array(z.object({ id: z.string(), name: z.string(), passed: z.boolean(), skipped: z.boolean(), request: z.string().nullable(), errors: z.array(z.string()) })),
      coverageFile: z.string(), coverageSummary: z.string(),
    }),
  }, guard(async ({ system, dir }, ctx) => {
    const v = await withProgress(ctx, onEvent, (ev) => verifyMock(ws, system, { dir, onEvent: ev }), opts.heartbeatMs ?? 5000, "verify");
    const failures = v.result.results.filter((r) => !r.passed).map((r) => ({ featureId: r.featureId, name: r.name, expectedStatus: r.expectedStatus, actualStatus: r.actualStatus ?? null, errors: r.errors }));
    const runtime = v.result.runtime.map((c) => ({ id: c.id, name: c.name, passed: c.passed, skipped: c.skipped, request: c.request, errors: c.errors }));
    const data = { total: v.result.total, passed: v.result.passed, failed: v.result.failed, failures, runtime, coverageFile: absPath(ws.dir(system), v.coverageFile), coverageSummary: coverageSummary(v.coverageMarkdown) };
    return ok(`contract: 통과 ${data.passed} / 실패 ${data.failed}, 런타임 계약 실패 ${v.result.runtimeFailed}. 커버리지: ${data.coverageFile}`, data);
  }));
}
