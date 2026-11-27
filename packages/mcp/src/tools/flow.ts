import type { McpServer } from "@modelcontextprotocol/server";
import { flowDetail, flowSummaries, FlowSourceSchema, inferFlowsForSystem, readFlows, setInput, writeFlows, type Workspace } from "@specmock/core";
import { z } from "zod";
import { guard } from "../result.js";
import { SystemArg } from "./analysis.js";

const Loose = z.looseObject({});

/** 흐름 읽기·빈 입력 채우기. 실행 도구는 없다(1단계: 실행은 화면에서, 안전장치는 서버가 판단). */
export function registerFlowTools(server: McpServer, ws: Workspace): void {
  server.registerTool("list_flows", {
    title: "흐름 보기",
    description: "추론된 흐름 목록(빈 입력 수·없는 기능·마지막 결과)을 돌려준다. flowId를 주면 그 흐름의 단계·입력·마지막 실행 결과. infer=true면 고른 기능에서 흐름을 다시 추론한다(사용자·Claude가 채운 입력은 보존). 빈 입력(kind empty)은 fill_flow로 채운다.",
    inputSchema: z.object({ system: SystemArg, flowId: z.string().optional(), infer: z.boolean().optional() }),
    outputSchema: Loose,
  }, guard(async ({ system, flowId, infer }) => {
    if (infer) await inferFlowsForSystem(ws, system);
    const data = flowId ? await flowDetail(ws, system, flowId) : await flowSummaries(ws, system);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as unknown as Record<string, unknown> };
  }));

  server.registerTool("fill_flow", {
    title: "흐름 입력 채우기",
    description: "흐름 단계 하나의 입력 자리(path.<변수> 또는 body.<필드>)를 채운다. source는 {kind:'step',step,field}(앞 단계 응답 필드) | {kind:'user',value} | {kind:'fixed',value} | {kind:'empty'}. 근거는 claude로 기록되고 화면에서 고칠 수 있다. 앞 단계가 만드는 상위 자원(예: path.repo ← create_repo.name)을 한 번 연결하면 같은 자원을 쓰는 다른 단계의 빈 자리에도 채운다. 실제 서버 실행은 하지 않는다.",
    inputSchema: z.object({ system: SystemArg, flowId: z.string(), stepId: z.string(), slot: z.string(), source: FlowSourceSchema }),
    outputSchema: Loose,
  }, guard(async ({ system, flowId, stepId, slot, source }) => {
    const file = await readFlows(ws, system);
    if (!file) throw new Error("흐름이 없습니다. 먼저 list_flows를 infer=true로 부르세요.");
    await writeFlows(ws, system, setInput(file, flowId, stepId, slot, source, "claude"));
    const d = await flowDetail(ws, system, flowId);
    return { content: [{ type: "text" as const, text: `채웠습니다. 남은 빈 입력: ${d.empty.length === 0 ? "없음" : d.empty.join(", ")}` }], structuredContent: d as unknown as Record<string, unknown> };
  }));
}
