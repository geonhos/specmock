// pnpm llm:check [model]   (= pnpm build:core && tsx scripts/live-llm-check.ts)
// 로컬 claude CLI가 구조화 출력을 제대로 내는지 1회 확인한다. 구독 호출이 발생한다.
import { ClaudeCodeAdapter, extractionJsonSchema, ExtractionResultSchema, buildChunkPrompt } from "@specmock/core";

const model = process.argv[2];
const adapter = new ClaudeCodeAdapter({ model, timeoutMs: 120_000 });
const chunk = "## Get a pet\n\n`GET /pets/{petId}` returns one pet.\n\n```json\n{\"id\": 1, \"name\": \"Rex\"}\n```\n";
const started = Date.now();
const out = await adapter.extract({ prompt: buildChunkPrompt(chunk), schema: extractionJsonSchema() });
const parsed = ExtractionResultSchema.safeParse(out);
console.log(JSON.stringify(out, null, 2));
console.log(parsed.success ? `OK (${Date.now() - started}ms, model=${model ?? "default"})` : `스키마 불일치: ${parsed.error.message}`);
process.exit(parsed.success && parsed.data.endpoints.some((e) => e.path === "/pets/{petId}") ? 0 : 1);
