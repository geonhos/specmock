import { Workspace, submitExtraction, withSystemLock } from "../../src/index.js";
import { AnalyzeRequestSchema } from "../../src/types.js";

const [mode, root, system, arg] = process.argv.slice(2);
const ws = new Workspace(root!);

if (mode === "hold") {
  // 잠금을 잡고 "locked"를 알린 뒤 arg ms 동안 쥐고 있는다.
  await withSystemLock(ws, system!, async () => {
    process.stdout.write("locked\n");
    await new Promise((r) => setTimeout(r, Number(arg)));
  });
} else if (mode === "submit") {
  // 청크 arg를 빈 결과로 제출한다(여러 자식이 동시에 다른 청크를 제출).
  const index = Number(arg);
  const req = await ws.read(system!, "analyze-request.json", AnalyzeRequestSchema);
  const chunk = req.chunks.find((c) => c.index === index)!;
  const r = await submitExtraction(ws, system!, { index, contentHash: chunk.contentHash!, result: { endpoints: [] } });
  process.stdout.write(JSON.stringify(r) + "\n");
}
