import path from "node:path";

/**
 * MCP 서버의 프로젝트 루트. `--root <dir>`가 있으면 그것(cwd 기준 상대 경로 허용), 없으면 cwd.
 * Claude Code는 플러그인 MCP 서버를 프로젝트 디렉터리에서 띄우므로 보통 인자가 필요 없다.
 */
export function resolveRoot(argv: string[], cwd: string = process.cwd()): string {
  const i = argv.indexOf("--root");
  if (i === -1) return cwd;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--root 다음에 디렉터리를 주세요.");
  return path.resolve(cwd, value);
}
