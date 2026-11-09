// pnpm llm:check [model]          (= pnpm build:core && tsx scripts/live-llm-check.ts)
// pnpm llm:check [model] --java   Petstore를 Java로 생성하고 verify까지 돌린다(JDK 17 필요, 수 분 걸림)
// 로컬 claude CLI가 구조화 출력을 제대로 내는지 확인한다. 구독 호출이 발생한다.
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChunkPrompt, ClaudeCodeAdapter, extractionJsonSchema, ExtractionResultSchema, runPipeline, verifyFailed, Workspace } from "@specmock/core";

const args = process.argv.slice(2);
const java = args.includes("--java");
const model = args.find((a) => !a.startsWith("--"));
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

if (!java) {
  const adapter = new ClaudeCodeAdapter({ model, timeoutMs: 120_000 });
  const chunk = "## Get a pet\n\n`GET /pets/{petId}` returns one pet.\n\n```json\n{\"id\": 1, \"name\": \"Rex\"}\n```\n";
  const out = await adapter.complete({ prompt: buildChunkPrompt(chunk), schema: extractionJsonSchema() });
  const parsed = ExtractionResultSchema.safeParse(out);
  console.log(JSON.stringify(out, null, 2));
  console.log(parsed.success ? `OK (${Date.now() - started}ms, model=${model ?? "default"})` : `스키마 불일치: ${parsed.error.message}`);
  process.exit(parsed.success && parsed.data.endpoints.some((e) => e.path === "/pets/{petId}") ? 0 : 1);
}

try {
  execFileSync("java", ["-version"], { stdio: "ignore" });
} catch {
  console.log("SKIP: java -version이 실패했습니다. JDK 17 이상을 설치한 뒤 다시 실행하세요.");
  process.exit(0);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "specmock-llm-java-"));
const ws = new Workspace(path.join(root, ".specmock"));
const outDir = path.join(root, "mock", "petstore");
console.log(`작업 디렉터리: ${root}`);
try {
  const r = await runPipeline(ws, "petstore", [path.join(repo, "examples", "petstore", "petstore.yaml")], {
    select: "all", outDir, verify: true, language: "java", model,
    onEvent: (e) => console.error(`[${elapsed()}] ${e.message}`),
    onProgress: (e) => console.error(`[${elapsed()}] ${e.message}`),
  });
  const g = r.generate;
  console.log(`생성: ${g.outDir} (시도 ${g.attempts}회, 파일 ${g.written.length}개)`);
  for (const n of g.notes) console.log(`참고: ${n}`);
  console.log(`실행: ${g.launch}`);
  const v = r.verify!;
  console.log(`contract: 통과 ${v.passed} / 실패 ${v.failed} / 전체 ${v.total}, runtime 실패 ${v.runtimeFailed}`);
  const ok = !verifyFailed(v) && g.language === "java";
  console.log(ok ? `OK (${elapsed()}, model=${model ?? "default"})` : `FAIL: verify 실패. ${outDir}을 확인하세요.`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  // GenerationFailedError면 메시지에 마지막 시도(.specmock-attempt/errors.md) 위치가 있다.
  console.log(`FAIL (${elapsed()}): ${(e as Error).message}`);
  process.exit(1);
}
