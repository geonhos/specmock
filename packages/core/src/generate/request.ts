// packages/core/src/generate/request.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ContractResult } from "../verify/index.js";
import type { RuntimeCheck } from "../verify/runtime.js";
import type { MockSpec } from "../types.js";
import type { ExistingSources } from "./generator.js";
import type { LanguageProfile } from "./profiles/types.js";
import { renderTsHonoFiles } from "./tsHono.js";
import { generatedOutputJsonSchema } from "./validateOutput.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));

export const GenerateRequestSchema = z.object({
  system: z.string(),
  language: z.string(),
  createdAt: z.string(),
  mockspecHash: z.string(),
  outDir: z.string(),
  prompt: z.string(),
  rules: z.array(z.string()),
  runtimeContract: z.array(z.string()),
  reference: z.object({ language: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) }),
  existingSources: z.array(z.object({ path: z.string(), content: z.string(), userModified: z.boolean() })).default([]),
  protectedPaths: z.array(z.string()),
  sourceGlobs: z.array(z.string()),
  outputSchema: z.record(z.string(), z.unknown()),
  /** 세션 모드: 지시서 작성 시점의 보호 경로 파일 해시. finalize가 변경을 판정한다. */
  protectedHashes: z.record(z.string(), z.string()).default({}),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const RUNTIME_CONTRACT = [
  "1. specmock.lock.json은 specmock이 쓴다. 건드리지 않는다.",
  "2. install 명령(있으면)이 outDir에서 성공해야 한다.",
  "3. start 명령을 셸 없이 argv로 실행한다. cwd는 outDir, 포트는 PORT 환경변수(기본 4010).",
  "4. 127.0.0.1:<PORT>에 바인딩하고 healthPath에 200 {ok:true, system, features:<선택된 기능 수>}를 낸다.",
  "5. 선택된 기능마다 contract의 status를 내고, 2xx 바디는 fixtures/<id>/<status>.json을 요청마다 읽어 그대로 낸다(응답 스키마 통과).",
  "6. 필수 path·query·body(body는 type object에 properties가 있고 required가 비어 있을 때만 선택, array·oneOf·allOf·properties 없는 body는 필수)가 없거나 스키마에 맞지 않으면 400 {error:\"validation_failed\", details}. 요청 content-type이 application/x-www-form-urlencoded면 body를 대괄호 중첩(a[b]=1, a[0]=x, a[]=x)으로 읽고 문자열을 스키마 type에 맞춰 바꾼 뒤 같은 검증을 한다.",
  "7. notMocked 기능의 method+path는 501 {error:\"not_mocked\", feature:<id>, hint:\"specmock select <system> --add <id> && specmock generate <system>\"}.",
  "8. 그 밖의 경로는 404 {error:\"unknown_path\", method, path}.",
  "9. SIGTERM을 받으면 3초 안에 종료한다.",
];

const lowest2xx = (f: MockSpec["features"][number]) =>
  f.fixtures.map((x) => x.status).filter((s) => s >= 200 && s < 300).sort((a, b) => a - b)[0] ?? 200;

/** 2항목: fixture 바디 없이 기능 요약. */
function specSummary(spec: MockSpec): string {
  const features = spec.features.map((f) => ({
    id: f.id, method: f.method, path: f.path, status: lowest2xx(f),
    request: { params: f.request.params, query: f.request.query, body: f.request.body },
    responseSchema: f.responses[String(lowest2xx(f))]?.schema ?? null,
    fixture: `fixtures/${f.id}/${lowest2xx(f)}.json`,
  }));
  return [
    "선택된 기능:", ...spec.features.map((f) => `- ${f.id}: ${f.method} ${f.path}`), "", "```json", JSON.stringify(features, null, 2), "```",
    "선택되지 않은 기능(501로 응답):", "```json", JSON.stringify(spec.notMocked, null, 2), "```",
    "verify가 보내는 contract:", "```json", JSON.stringify(spec.contracts, null, 2), "```",
  ].join("\n");
}

const fileBlock = (p: string, content: string, label = "") => `### ${p}${label}\n\n\`\`\`\n${content}\n\`\`\``;

export async function buildGenerateRequest(input: {
  spec: MockSpec; profile: LanguageProfile; outDir: string; existing: ExistingSources | null; mockspecHash?: string;
}): Promise<GenerateRequest> {
  const { spec, profile, outDir, existing } = input;
  const reference = renderTsHonoFiles(spec);
  const javaRefs = await Promise.all(profile.referenceFiles.map(async (p) => ({ path: p, content: await readFile(`${TEMPLATES}${profile.language}/${p}`, "utf8") })));
  const sections = [
    `## 1. 역할과 목표\n\n이 MockSpec의 mock 서버를 ${profile.displayName}로 작성한다. 아래 런타임 계약을 지키면 specmock verify가 통과한다. 시스템 이름: ${spec.system}`,
    `## 2. MockSpec 요약\n\n${specSummary(spec)}`,
    `## 3. 런타임 계약\n\n${RUNTIME_CONTRACT.join("\n")}`,
    `## 4. TypeScript 참조 구현\n\n같은 MockSpec으로 specmock이 만든 TS(Hono) 서버다. 구조·라우트 등록·검증 흐름·501/404·헬스 바디를 이와 같게 만든다.\n\n${reference.map((f) => fileBlock(f.path, f.content)).join("\n\n")}`,
    `## 5. ${profile.displayName} 규칙\n\n${profile.rules.map((r) => `- ${r}`).join("\n")}\n- 파일은 다음 범위에만 쓴다: ${profile.sourceGlobs.join(", ")}\n- 다음 경로는 쓰지 않는다: ${profile.protectedPaths.join(", ")}\n- 파일은 최대 ${profile.maxFiles}개.`,
    `## 6. ${profile.displayName} 참조 예시\n\n${javaRefs.length ? javaRefs.map((f) => fileBlock(f.path, f.content)).join("\n\n") : "(없음)"}`,
  ];
  if (existing) {
    sections.push(`## 7. 증분 생성\n\n기존 코드를 유지하고 추가·삭제된 기능만 반영한다. "(사용자 수정)" 파일은 라우트 추가·삭제 외에 바꾸지 않는다. 출력은 전체 파일 집합이다(바뀌지 않은 파일도 그대로 포함). 삭제할 파일은 content: null.\n\n${existing.files.map((f) => fileBlock(f.path, f.content, f.userModified ? " (사용자 수정)" : "")).join("\n\n")}`);
  }
  sections.push(`## 8. 출력 형식\n\n{"files":[{"path":"<outDir 기준 상대 경로>","content":"<파일 전체>"}],"notes":["가정이나 지키지 못한 규칙"]} 형식의 JSON 하나만 낸다. 출력 스키마는 --json-schema로 주어진다.`);
  return {
    system: spec.system,
    language: profile.language,
    createdAt: new Date().toISOString(),
    mockspecHash: input.mockspecHash ?? "",
    outDir,
    prompt: sections.join("\n\n"),
    rules: profile.rules,
    runtimeContract: RUNTIME_CONTRACT,
    reference: { language: "ts", files: reference },
    existingSources: existing?.files ?? [],
    protectedPaths: profile.protectedPaths,
    sourceGlobs: profile.sourceGlobs,
    outputSchema: generatedOutputJsonSchema(),
    protectedHashes: {},
  };
}

export interface AttemptFailure {
  attempt: number;
  stage: "response" | "build" | "start" | "contract";
  errors: string[];
  contracts: ContractResult[];
  runtime: RuntimeCheck[];
}

const STAGE_LABEL: Record<AttemptFailure["stage"], string> = { response: "응답 검증", build: "빌드", start: "기동", contract: "contract" };

/** 재시도 프롬프트 끝에 붙이는 절. 오류 텍스트는 마지막 50줄만. spec이 있으면 실패 contract의 요청을 함께 적는다. */
export function retrySection(f: AttemptFailure, spec?: MockSpec): string {
  const lines = f.errors.join("\n").split("\n");
  const tail = lines.slice(-50).join("\n");
  const failed = f.contracts.filter((c) => !c.passed).map((c) => {
    const req = spec?.contracts.find((k) => k.featureId === c.featureId && k.name === c.name)?.request;
    const reqText = req ? ` 요청 ${JSON.stringify({ method: req.method, path: req.path, query: req.query, body: req.body })}` : "";
    return `- ${c.featureId} [${c.name}]${reqText} 기대 ${c.expectedStatus}, 실제 ${c.actualStatus ?? "응답 없음"}: ${c.errors.join("; ")}`;
  });
  const rt = f.runtime.filter((c) => !c.passed).map((c) => `- ${c.name} ${c.request ?? ""}: ${c.errors.join("; ")}`);
  return [
    `## 이전 시도 결과 (${f.attempt}번째)`,
    "",
    `실패 단계: ${STAGE_LABEL[f.stage]}`,
    ...(tail.trim() ? ["", "```", tail, "```"] : []),
    ...(failed.length ? ["", "실패한 contract:", ...failed] : []),
    ...(rt.length ? ["", "실패한 런타임 계약:", ...rt] : []),
    "",
    "위 오류를 고친 전체 파일 집합을 다시 낸다.",
  ].join("\n");
}
