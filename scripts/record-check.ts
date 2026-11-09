// pnpm record:check   (= pnpm build:core && tsx scripts/record-check.ts)
// 공개 Swagger Petstore v3에 GET만 보내 record가 실제 네트워크에서 동작하는지 본다. 키 불필요. 데모 데이터가 바뀌므로 drift는 정상.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeSpec, ingestSpec, recordResponses, select, Workspace } from "@specmock/core";

const BASE = "https://petstore3.swagger.io/api/v3";
const root = await mkdtemp(path.join(os.tmpdir(), "specmock-record-check-"));
try {
  const ws = new Workspace(path.join(root, ".specmock"));
  await ingestSpec(ws, "petstore3", [`${BASE}/openapi.json`]);
  await analyzeSpec(ws, "petstore3");
  await select(ws, "petstore3", ["all"]);
  await writeFile(ws.file("petstore3", "target.json"), JSON.stringify({ baseUrl: BASE, params: { petId: "1", orderId: "1", username: "user1" } }));
  const { result, driftMarkdown } = await recordResponses(ws, "petstore3", { apply: false, onEvent: (e) => console.error(e.message) });
  console.log(driftMarkdown);
  const sent = result.matched.length + result.drifted.length + result.statusMismatch.length + result.failed.length;
  console.log(`요청 ${sent} · 녹화 ${result.recorded.length} · 건너뜀(변경 요청) ${result.skipped.length}`);
  process.exitCode = sent > 0 && result.recorded.length > 0 ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
