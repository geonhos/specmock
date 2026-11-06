import type { McpServer } from "@modelcontextprotocol/server";
import { startUiServer, type UiServerHandle } from "@specmock/ui-server";
import { z } from "zod";
import { guard, ok } from "../result.js";

/** 화면 서버는 이 MCP 프로세스 안에서 한 번만 띄운다. unref라 stdin이 닫히면 프로세스가 서버 때문에 남지 않는다. */
export function registerUiTools(server: McpServer, root: string): void {
  let running: Promise<UiServerHandle> | undefined;
  server.registerTool("open_ui", {
    title: "화면 열기",
    description: "기능 선택·생성·검증을 브라우저 화면에서 하고 싶을 때 쓴다. 이 대화와 같은 작업 공간을 쓰는 로컬 화면 서버(127.0.0.1)를 띄우고 URL을 돌려준다. URL을 사용자에게 보여 주고 열어 달라고 안내한다. 이미 떠 있으면 같은 URL을 돌려준다.",
    inputSchema: z.object({}),
    outputSchema: z.object({ url: z.string() }),
  }, guard(async () => {
    running ??= startUiServer({ root, unref: true }).catch((e: unknown) => { running = undefined; throw e; });
    const { url } = await running;
    return ok(`화면: ${url}`, { url });
  }));
}
