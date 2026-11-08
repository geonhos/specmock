#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./createServer.js";
import { resolveRoot } from "./root.js";

// stdout은 MCP 프로토콜 전용이다. 사람이 읽을 로그는 전부 stderr로 보낸다.
try {
  const root = resolveRoot(process.argv.slice(2));
  // mock 기본 경로(./mock/<system>), 상대 outDir, 상대 입력 파일이 모두 cwd 기준이라 루트로 옮긴다.
  process.chdir(root);
  process.stderr.write(`specmock mcp: root=${root}\n`);
  const { server, closeUi } = createServer(root);
  await server.connect(new StdioServerTransport());
  // 클라이언트가 stdio를 닫으면(Claude Code 종료 등) 화면 서버와 그 작업을 정리하고 끝낸다.
  const shutdown = () => { void closeUi().finally(() => process.exit(0)); };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
} catch (e) {
  process.stderr.write(`specmock mcp 시작 실패: ${(e as Error).message}\n`);
  process.exit(1);
}
