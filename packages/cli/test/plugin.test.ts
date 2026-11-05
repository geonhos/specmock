import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..", "..", "..", "plugin");
const run = promisify(execFile);
const CLI = path.resolve(here, "..", "src", "cli.ts");
const TSX = path.resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

describe("Claude Code plugin", () => {
  it("has a valid manifest", async () => {
    const m = JSON.parse(await readFile(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    expect(m).toMatchObject({ name: "specmock", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it("skill has frontmatter and walks through every CLI step", async () => {
    const skill = await readFile(path.join(PLUGIN, "skills", "specmock", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: specmock\ndescription:")).toBe(true);
    for (const cmd of ["specmock ingest", "specmock analyze", "specmock list", "specmock select", "specmock generate", "specmock verify", "--merge", "analyze-request.json", "extracted/", "--llm claude-code", "종료 코드"]) {
      expect(skill, `SKILL.md should mention ${cmd}`).toContain(cmd);
    }
  });

  it("reference docs exist and the manual harvest guide warns about secrets", async () => {
    const dir = path.join(PLUGIN, "skills", "specmock", "references");
    expect(await readFile(path.join(dir, "extraction.md"), "utf8")).toContain("extracted/");
    const manual = await readFile(path.join(dir, "manual-harvest.md"), "utf8");
    expect(manual).toContain("ego-browser skill");
    expect(manual).toContain("비밀값");
  });

  it("passes `claude plugin validate` when the claude CLI is installed", async () => {
    try { await run("claude", ["--version"]); } catch { return; } // CLI 없으면 건너뜀
    await run("claude", ["plugin", "validate", PLUGIN]); // 실패하면 non-zero 종료로 reject된다
  }, 60_000);

  it("every `specmock <cmd> ... --<opt>` in the skill docs exists in that command's --help", async () => {
    const dir = path.join(PLUGIN, "skills", "specmock");
    const docs = [path.join(dir, "SKILL.md"), ...(await readdir(path.join(dir, "references"))).map((f) => path.join(dir, "references", f))];
    const used = new Map<string, Set<string>>();
    for (const f of docs) {
      for (const line of (await readFile(f, "utf8")).split("\n")) {
        for (const m of line.matchAll(/specmock (ingest|analyze|list|select|generate|verify|run)\b([^`\n]*)/g)) {
          const opts = [...m[2]!.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((x) => `--${x[1]}`);
          if (!used.has(m[1]!)) used.set(m[1]!, new Set());
          opts.forEach((o) => used.get(m[1]!)!.add(o));
        }
      }
    }
    expect(used.size).toBeGreaterThan(3);
    for (const [cmd, opts] of used) {
      const { stdout } = await run(TSX, [CLI, cmd, "--help"], { env: { ...process.env, NO_COLOR: "1" } });
      for (const o of opts) expect(stdout, `\`specmock ${cmd} --help\` should list ${o} (used in skill docs)`).toContain(o);
    }
  }, 60_000);
});
