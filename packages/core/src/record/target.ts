// packages/core/src/record/target.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { fillPath } from "../select/contracts.js";
import type { Contract, Feature } from "../types.js";
import type { Workspace } from "../workspace.js";

export const TARGET_FILE = "target.json";
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 오류 메시지·Web 안내에 그대로 싣는 예시. `${PETS_TOKEN}`은 문자 그대로다(템플릿 리터럴 아님). */
export const TARGET_EXAMPLE = JSON.stringify({
  baseUrl: "https://api.example.com/v2",
  headers: { Authorization: "Bearer ${PETS_TOKEN}" },
  params: { petId: "123" },
  timeoutMs: 15000,
}, null, 2);

function checkBaseUrl(v: string): boolean {
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  return (u.protocol === "http:" || u.protocol === "https:") && u.search === "" && u.hash === "" && u.username === "" && u.password === "";
}

export const TargetSchema = z.strictObject({
  baseUrl: z.string().refine(checkBaseUrl, "http(s) URL이어야 하고 query·#·계정 정보를 넣을 수 없습니다"),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export interface Target {
  file: string;
  /** 끝 `/`를 지운 값. */
  baseUrl: string;
  /** `${ENV}` 치환을 마친 값. 화면·로그에 싣지 않는다. */
  headers: Record<string, string>;
  params: Record<string, string>;
  timeoutMs: number;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `${NAME}`을 env[NAME]으로 바꾼다. 없거나 비어 있으면 이름만 담아 던진다. */
export function substituteEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_REF, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`환경변수 ${name}이 없습니다`);
    if (v === "") throw new Error(`환경변수 ${name}이 비어 있습니다`);
    return v;
  });
}

/** target.json을 읽는다. 어떤 오류 메시지에도 파일 원문·헤더 값을 싣지 않는다. */
export async function readTarget(ws: Workspace, system: string, env: Record<string, string | undefined> = process.env): Promise<Target> {
  const file = ws.file(system, TARGET_FILE);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${file}이(가) 없습니다. 실제 시스템 주소를 적어 만드세요(비밀 값은 \${환경변수}로만):\n${TARGET_EXAMPLE}`);
    }
    throw e;
  }
  let raw: unknown;
  // Node의 JSON 파싱 오류 문구는 원문 조각을 인용하므로 그대로 싣지 않는다.
  try { raw = JSON.parse(text); } catch { throw new Error(`${file}: JSON 파싱 실패. 문법을 확인하세요.`); }
  const parsed = TargetSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = new Set<string>();
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") for (const k of issue.keys) fields.add([...issue.path, k].join("."));
      else fields.add(issue.path.join(".") || "(최상위)");
    }
    throw new Error(`${file}: 형식 오류. 확인할 필드: ${[...fields].join(", ")} (모르는 키는 거부합니다)`);
  }
  const t = parsed.data;
  const headers = Object.fromEntries(Object.entries(t.headers ?? {}).map(([k, v]) => [k, substituteEnv(v, env)]));
  return { file, baseUrl: t.baseUrl.replace(/\/+$/, ""), headers, params: t.params ?? {}, timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

/** params를 contract에 적용한 경로·쿼리. 쿼리는 contract에 있거나 feature에 선언된 이름만 덮어쓴다. */
export function applyParams(feature: Feature | undefined, c: Contract, params: Record<string, string>): { path: string; query: Record<string, string> } {
  if (!feature || Object.keys(params).length === 0) return { path: c.request.path, query: { ...c.request.query } };
  const query = { ...c.request.query };
  for (const [k, v] of Object.entries(params)) {
    if (Object.hasOwn(query, k) || Object.hasOwn(feature.request.query, k)) query[k] = v;
  }
  return { path: fillPath(feature, params), query };
}
