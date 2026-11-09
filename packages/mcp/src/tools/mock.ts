import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  assertLanguage, defaultMockDir, finalizeGeneration, findFeature, generate, listFeatures, prepareGeneration, readLock, readSessionMarker, recordResponses, APPLY_FAILED, select,
  SUPPORTED_LANGUAGES, verifyMock, type OnEvent, type Workspace,
} from "@specmock/core";
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
    description: `선택한 기능으로 mock 서버 프로젝트를 만든다. 언어: ${SUPPORTED_LANGUAGES.join(", ")}(기본 ts, 또는 기존 디렉터리의 언어). ts는 바로 생성한다(mode=generated). ts가 아닌 언어는 지시서(generate-request.json)를 쓰고 멈춘다(mode=session): nextSteps대로 지시서를 읽고 파일을 쓰고 빌드를 확인한 뒤 finalize_generation → verify_mock. 기본 위치 ./mock/<system>/. 사용자가 고친 fixture는 force 없이는 보존한다.`,
    inputSchema: z.object({
      system: SystemArg,
      language: z.string().optional().describe(`생성 언어(${SUPPORTED_LANGUAGES.join(" | ")}). 생략하면 기존 디렉터리의 언어, 없으면 ts`),
      outDir: z.string().optional().describe("출력 디렉터리(프로젝트 루트 기준). 기본 ./mock/<system>"),
      force: z.boolean().optional().describe("사용자가 수정한 fixture도 덮어쓴다. specmock이 만들지 않은(specmock.lock.json 없는) 비어 있지 않은 디렉터리도 덮어쓴다. 언어를 바꿀 때도 필요하다(fixtures·contracts 밖의 기존 소스 삭제). 반드시 사용자에게 경로와 덮어쓸 내용을 알리고 확인받은 뒤에만 true"),
    }),
    outputSchema: z.object({
      mode: z.enum(["generated", "session"]),
      outDir: z.string(),
      language: z.string(),
      written: z.array(z.string()).optional(),
      preserved: z.array(z.string()).optional(),
      orphaned: z.array(z.string()).optional(),
      launch: z.string().optional(),
      skipped: z.boolean().optional(),
      requestPath: z.string().optional(),
      nextSteps: z.array(z.string()).optional(),
    }),
  }, guard(async ({ system, language, outDir, force }) => {
    if (language !== undefined) assertLanguage(language);
    const target = path.resolve(outDir ?? defaultMockDir(system));
    const effective = language ?? (await readLock(target))?.language ?? (await readSessionMarker(target))?.language ?? "ts";
    if (effective !== "ts") {
      const p = await prepareGeneration(ws, system, { outDir, force, language: effective });
      const head = p.reused ? "지시서가 이미 최신입니다" : "지시서를 썼습니다";
      return ok(`${head}: ${p.requestPath}. 출력 위치: ${p.outDir}.\n${p.nextSteps.join("\n")}`, {
        mode: "session" as const, outDir: p.outDir, language: p.language, requestPath: p.requestPath, nextSteps: p.nextSteps,
      });
    }
    const r = await generate(ws, system, { outDir, force, language: "ts" });
    return ok(`생성: ${r.outDir} (파일 ${r.written.length}개, 보존 ${r.preserved.length}, 남겨진 fixture ${r.orphaned.length}). 실행: ${r.launch}. 다음: verify_mock`, {
      mode: "generated" as const, outDir: r.outDir, language: r.language, written: r.written, preserved: r.preserved, orphaned: r.orphaned, launch: r.launch, skipped: r.skipped,
    });
  }));

  server.registerTool("finalize_generation", {
    title: "세션 생성 확정",
    description: "generate_mock(mode=session) 뒤 대화에서 쓴 파일을 확정한다: 보호 경로(fixtures·contracts·lock·wrapper 등) 변경과 파일 범위를 검사하고 fixtures·contracts·lock을 쓴다. 컴파일하지 않는다. ok=false면 reason과 errors를 보고 고친다: stale-request면 generate_mock부터 다시, protected-path-modified면 나열된 파일을 원래대로 되돌린다. 다음: verify_mock",
    inputSchema: z.object({ system: SystemArg }),
    outputSchema: z.object({
      ok: z.boolean(),
      outDir: z.string().optional(),
      written: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional(),
      reason: z.enum(["no-request", "stale-request", "protected-path-modified", "no-sources", "too-many-files"]).optional(),
      errors: z.array(z.string()).optional(),
    }),
  }, guard(async ({ system }) => {
    const r = await finalizeGeneration(ws, system);
    if (r.ok) {
      const warn = r.warnings.length ? ` 경고: ${r.warnings.join("; ")}.` : "";
      return ok(`확정: ${r.outDir} (파일 ${r.written.length}개).${warn} 다음: verify_mock`, r);
    }
    return ok(`확정 거부(${r.reason}): ${r.errors.join("; ")}`, r);
  }));

  server.registerTool("verify_mock", {
    title: "contract test",
    description: "mock 서버를 띄워 contract test와 런타임 계약(501·404)을 실행하고 .specmock/<system>/coverage.md를 쓴다. 대상은 dir → 마지막 generate_mock 위치 → ./mock/<system>. 의존성이 없으면 lock의 설치 명령(TS는 npm install, Java는 ./mvnw package)을 먼저 실행하므로 처음엔 오래 걸릴 수 있다.",
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

  server.registerTool("record_responses", {
    title: "실제 시스템 녹화",
    description: "mockspec의 정상 요청 contract를 .specmock/<system>/target.json의 실제 시스템에 보내 응답을 recorded/에 저장하고 drift.md(스펙과 실제의 차이)를 쓴다. 기본은 GET·HEAD만 보낸다. 녹화 뒤 select → generate를 다시 실행해 mock fixture에 반영한다(LLM은 부르지 않는다). target.json이 없으면 오류에 예시가 있다 — 사용자에게 만들어 달라고 한다. 헤더의 ${ENV}는 Claude Code를 실행한 셸의 환경변수에서 읽는다.",
    inputSchema: z.object({
      system: SystemArg,
      allowMutating: z.boolean().optional().describe("POST·PUT·PATCH·DELETE도 보낸다. 실제 데이터가 바뀔 수 있으므로 반드시 사용자에게 대상 시스템과 요청 목록을 알리고 확인받은 뒤에만 true"),
      features: z.array(z.string()).optional().describe("이 기능 id만 녹화"),
      refresh: z.boolean().optional().describe("대상 기능(이번에 보낸 것)의 기존 녹화를 버리고 다시 녹화. 건너뛴 변경 요청 기능의 녹화는 유지, 중단되면 모두 유지"),
      apply: z.boolean().optional().describe("기본 true. false면 녹화·drift만"),
    }),
    outputSchema: z.object({
      baseUrl: z.string(),
      recorded: z.array(z.string()),
      matched: z.array(z.string()),
      drifted: z.array(z.object({ featureId: z.string(), errors: z.array(z.string()) })),
      statusMismatch: z.array(z.object({ featureId: z.string(), expected: z.number(), actual: z.number(), hint: z.string().optional() })),
      skipped: z.array(z.object({ featureId: z.string(), reason: z.literal("mutating") })),
      failed: z.array(z.object({ featureId: z.string(), reason: z.string() })),
      applied: z.object({ selected: z.number(), generated: z.boolean(), outDir: z.string().nullable(), preserved: z.array(z.string()) }).nullable(),
      notes: z.array(z.string()),
      driftPath: z.string(),
      driftSummary: z.string(),
    }),
  }, guard(async ({ system, allowMutating, features, refresh, apply }, ctx) => {
    const v = await withProgress(ctx, onEvent, (ev) => recordResponses(ws, system, { allowMutating, features, refresh, apply, onEvent: ev }), opts.heartbeatMs ?? 5000, "record");
    const r = v.result;
    const g = r.applied?.generate ?? null;
    // drift.md 머리(제목·요약 줄) + 다름·불일치 항목. 건너뜀·실패 목록은 구조화 결과에 있다.
    const md = v.driftMarkdown.split("\n");
    const items = md.filter((l, i) => l.startsWith("- ") && md.slice(0, i).reverse().find((x) => x.startsWith("## "))?.match(/^## (스펙과 다름|상태 불일치)$/));
    const driftSummary = [md[0], md[1], ...items].join("\n");
    const data = {
      baseUrl: r.baseUrl, recorded: r.recorded, matched: r.matched, drifted: r.drifted, statusMismatch: r.statusMismatch, skipped: r.skipped, failed: r.failed,
      applied: r.applied ? { selected: r.applied.selected, generated: g !== null, outDir: g?.outDir ?? null, preserved: g?.preserved ?? [] } : null,
      notes: v.notes, driftPath: absPath(ws.dir(system), v.driftPath), driftSummary,
    };
    const failedNote = v.notes.find((n) => n.startsWith(APPLY_FAILED));
    return ok(`${failedNote ? `⚠ ${failedNote}\n\n` : ""}${driftSummary}\n\ndrift: ${data.driftPath}${v.notes.length ? `\n${v.notes.map((n) => `- ${n}`).join("\n")}` : ""}`, data);
  }));
}
