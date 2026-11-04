import { defaultMockDir, MockSpecSchema, renderCoverage, verify } from "@specmock/core";
import type { Command } from "commander";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fail, printJsonOr, workspaceFrom } from "../context.js";

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("mock 서버를 띄워 contract test를 실행하고 coverage.md를 쓴다")
    .argument("<system>")
    .option("--dir <dir>", "mock 디렉터리 (기본 ./mock/<system>)")
    .option("--report <path>", "coverage.md 추가 저장 경로")
    .option("--json", "JSON으로 출력", false)
    .action(async (system: string, opts: { dir?: string; report?: string; json: boolean }, cmd: Command) => {
      try {
        const ws = workspaceFrom(cmd);
        const dir = path.resolve(opts.dir ?? defaultMockDir(system));
        await stat(dir).catch(() => fail(`${dir} 이(가) 없습니다. 먼저 specmock generate ${system}`));
        const result = await verify(dir, { onLog: (m) => process.stderr.write(m + "\n") });
        const spec = await ws.read(system, "mockspec.json", MockSpecSchema);
        const md = renderCoverage(spec, result);
        const saved = await ws.writeText(system, "coverage.md", md);
        if (opts.report) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(opts.report, md, "utf8");
        }
        printJsonOr(opts.json, { ...result, coverage: saved }, () => {
          const lines = [`contract: 통과 ${result.passed} / 실패 ${result.failed} / 전체 ${result.total}`];
          for (const r of result.results.filter((x) => !x.passed)) lines.push(`  ✗ ${r.featureId} [${r.name}] ${r.errors.join("; ")}`);
          lines.push(`coverage: ${saved}`);
          return lines.join("\n");
        });
        if (result.failed > 0) process.exit(2);
      } catch (e) {
        fail((e as Error).message);
      }
    });
}
