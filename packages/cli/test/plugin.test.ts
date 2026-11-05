import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, "..", "..", "..", "plugin");
const run = promisify(execFile);

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
    const { stdout, stderr } = await run("claude", ["plugin", "validate", PLUGIN]);
    expect(stdout + stderr).not.toMatch(/error/i);
  }, 60_000);
});
