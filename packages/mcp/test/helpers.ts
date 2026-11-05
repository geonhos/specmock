import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..", "..");
export const SERVER = path.join(REPO, "packages", "mcp", "dist", "server.js");
export const PLUGIN = path.join(REPO, "plugin");
export const PETSTORE = path.join(REPO, "packages", "core", "test", "fixtures", "petstore.yaml");
export const DOCS_SAMPLE = path.join(REPO, "examples", "docs-sample");
/** 루트 node_modules. 생성된 mock에 심볼릭 링크하여 설치 없이 기동할 때 쓴다(core e2e와 같은 방식). */
export const ROOT_NODE_MODULES = path.join(REPO, "node_modules");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Session {
  client: Client;
  stderr: () => string;
  /** 도구를 호출하고 isError가 아님을 확인한 뒤 structuredContent를 돌려준다. */
  ok: (name: string, args?: Json) => Promise<Json>;
  /** 도구를 호출하고 isError임을 확인한 뒤 텍스트를 돌려준다. */
  err: (name: string, args?: Json) => Promise<string>;
  close: () => Promise<void>;
}

export async function connect(cwd: string, args: string[] = []): Promise<Session> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], cwd, stderr: "pipe" });
  const client = new Client({ name: "specmock-test", version: "0.0.0" });
  await client.connect(transport);
  let log = "";
  transport.stderr?.on("data", (b: Buffer) => { log += b.toString("utf8"); });
  const text = (r: Json) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  return {
    client,
    stderr: () => log,
    ok: async (name, a = {}) => {
      const r = (await client.callTool({ name, arguments: a })) as Json;
      expect(r.isError, `${name} 오류: ${text(r)}`).toBeFalsy();
      return r.structuredContent as Json;
    },
    err: async (name, a = {}) => {
      const r = (await client.callTool({ name, arguments: a })) as Json;
      expect(r.isError, `${name}이 오류를 내야 함: ${text(r)}`).toBe(true);
      return text(r);
    },
    close: () => client.close(),
  };
}
