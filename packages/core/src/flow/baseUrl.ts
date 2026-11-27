import { parse as parseYaml } from "yaml";
import { SourceSchema } from "../types.js";
import type { Workspace } from "../workspace.js";

/** 등록 화면의 기본 주소: 첫 OpenAPI 입력의 servers[0].url(v3) 또는 schemes[0]://host+basePath(v2). 절대 http(s) URL이 아니면 null. */
export async function suggestedBaseUrl(ws: Workspace, system: string): Promise<string | null> {
  if (!(await ws.exists(system, "source.json"))) return null;
  const input = (await ws.read(system, "source.json", SourceSchema)).inputs.find((i) => i.kind === "openapi");
  if (!input) return null;
  let doc: Record<string, unknown>;
  try { doc = parseYaml(input.content) as Record<string, unknown>; } catch { return null; }
  const servers = doc?.servers as { url?: unknown }[] | undefined;
  let url: unknown = servers?.[0]?.url;
  if (url === undefined && typeof doc?.host === "string") {
    const scheme = (Array.isArray(doc.schemes) && typeof doc.schemes[0] === "string" ? doc.schemes[0] : "https");
    url = `${scheme}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`;
  }
  return typeof url === "string" && /^https?:\/\/[^/]/.test(url) ? url.replace(/\/+$/, "") : null;
}
