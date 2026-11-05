import { McpServer } from "@modelcontextprotocol/server";
import { VERSION } from "@specmock/core";

export function createServer(_root: string): McpServer {
  const server = new McpServer({ name: "specmock", version: VERSION });
  server.registerTool(
    "ping",
    { title: "ping", description: "서버가 살아 있는지 확인한다 (임시 도구, Task 4에서 제거)" },
    async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
  );
  return server;
}
