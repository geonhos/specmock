import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/names.js";
import { connect, PLUGIN, SERVER } from "./helpers.js";

const SKILL_DIR = path.join(PLUGIN, "skills", "specmock");

describe("plugin MCP wiring", () => {
  it("mcpServers.specmock runs the built server with node", async () => {
    const m = JSON.parse(await readFile(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    const s = m.mcpServers?.specmock;
    expect(s?.command).toBe("node");
    expect(s.args).toHaveLength(1);
    const resolved = path.resolve(String(s.args[0]).replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN));
    expect(resolved).toBe(SERVER);
    await access(SERVER); // pnpm test가 build:mcp를 먼저 돌리므로 있어야 한다
  });

  it("tool names in the skill docs are exactly the registered tools", async () => {
    const docs = [await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8"), await readFile(path.join(SKILL_DIR, "references", "extraction.md"), "utf8")].join("\n");
    // 스킬은 도구를 `ingest_spec`처럼 백틱 안의 짧은 이름으로 부른다. 밑줄이 든 소문자 백틱 토큰 중 도구 접미사를 가진 것만 모은다.
    const mentioned = new Set([...docs.matchAll(/`([a-z]+_(?:spec|chunk|extraction|extractions|features?|mock|ui|generation))`/g)].map((x) => x[1]!));
    expect([...mentioned].sort()).toEqual([...TOOL_NAMES].sort());

    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "specmock-plugin-")));
    const s = await connect(dir);
    try {
      const { tools } = await s.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    } finally { await s.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("skill keeps the CLI fallback and does not reference author-only tooling", async () => {
    const skill = await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(skill).toContain("specmock analyze");      // MCP가 없을 때의 CLI 흐름
    expect(skill.toLowerCase()).not.toContain(["har", "ness"].join(""));
  });

  it("skill states the MCP safety rules", async () => {
    const skill = await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(skill).toContain("force: true");   // 비-specmock 디렉터리 덮어쓰기는 사용자 확인 뒤에만
    expect(skill).toContain("outDir");        // 사용자가 지정하지 않으면 주지 않는다
    expect(skill).toContain("remaining");     // submit_extraction 진행 추적
  });

  it("skill explains missing-tool recovery and unknown-chunk handling", async () => {
    const skill = await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(skill).toContain("pnpm build");    // 도구 미노출 시 빌드 안내
    expect(skill).toContain("/mcp");          // 연결 확인
    expect(skill).toContain("unknown-chunk"); // 잘못된 청크 번호 처리
  });
});
