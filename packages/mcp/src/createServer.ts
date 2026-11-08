import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { VERSION, Workspace, type ServiceEvent } from "@specmock/core";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerMockTools } from "./tools/mock.js";
import { registerUiTools } from "./tools/ui.js";

export function createServer(root: string, opts: { heartbeatMs?: number } = {}): { server: McpServer; closeUi: () => Promise<void> } {
  const ws = new Workspace(path.join(root, ".specmock"));
  // 진행 이벤트는 stderr로만. stdout은 프로토콜 전용이다.
  const onEvent = (e: ServiceEvent) => { process.stderr.write(`[${e.stage}] ${e.message}\n`); };
  const server = new McpServer({ name: "specmock", version: VERSION });
  registerAnalysisTools(server, ws, onEvent);
  registerMockTools(server, ws, onEvent, opts);
  const { closeUi } = registerUiTools(server, root);
  return { server, closeUi };
}
