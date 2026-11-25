import { readFile } from "node:fs/promises";
import { RecordedSchema, TARGET_FILE, TargetSchema, type Workspace } from "@specmock/core";
import { z } from "zod";
import type { EnvStore } from "./envStore.js";
import { InvalidRequest } from "./errors.js";
import type { EnvStatus, TargetEntry } from "./api-types.js";

export type RawTarget = z.infer<typeof TargetSchema>;

/** 값이 `${이름}` 참조만으로 이루어졌는지. 헤더는 이런 값만 화면에 그대로 보인다. */
const ONLY_REFS = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\})+$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 치환 전 원문을 읽는다. 없거나 형식이 틀리면 null(형식 오류 안내는 readTarget이 맡는다). */
export async function readRawTarget(ws: Workspace, system: string): Promise<RawTarget | null> {
  try {
    const parsed = TargetSchema.safeParse(JSON.parse(await readFile(ws.file(system, TARGET_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** 헤더용: 참조만으로 된 값은 원문, 그 밖의 직접 적은 값은 `***`로 가린다. */
export function toHeaderEntries(map: Record<string, string> | undefined): TargetEntry[] {
  return Object.entries(map ?? {}).map(([name, value]) => (ONLY_REFS.test(value)
    ? { name, value, literal: false }
    : { name, value: "***", literal: true }));
}

/** 공통 값·기능별 값용: 값을 가리지 않는다(경로 id·query는 drift.md 경로에도 찍힌다). `literal`은 참조만으로 된 값이 아니라는 뜻이다. */
export function toEntries(map: Record<string, string> | undefined): TargetEntry[] {
  return Object.entries(map ?? {}).map(([name, value]) => ({ name, value, literal: !ONLY_REFS.test(value) }));
}

/** 헤더·공통 값·기능별 값에 쓰인 `${이름}` 전체(중복 없이, 처음 나온 순서). */
export function envNames(raw: RawTarget): string[] {
  const values = [...Object.values(raw.headers ?? {}), ...Object.values(raw.params ?? {}), ...Object.values(raw.features ?? {}).flatMap((m) => Object.values(m))];
  return [...new Set(values.flatMap((v) => [...v.matchAll(ENV_REF)].map((m) => m[1]!)))];
}

export function envStatus(names: string[], store: EnvStore, system: string): { name: string; status: EnvStatus }[] {
  const session = new Set(store.names(system));
  return names.map((name) => ({ name, status: session.has(name) ? "session" : process.env[name] ? "process" : "missing" }));
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const item = (re: RegExp, what: string) => z.object({ name: z.string().min(1).regex(re, `${what} 이름 형식이 올바르지 않습니다`), value: z.string().optional(), keep: z.literal(true).optional() })
  .refine((i) => i.value !== undefined || i.keep === true, "value 또는 keep이 필요합니다");
const HeaderItem = item(HEADER_NAME, "헤더");
const ValueItem = item(VALUE_NAME, "값");
export const TargetPutBodySchema = z.object({
  baseUrl: z.string(),
  timeoutMs: z.number().int().positive().optional(),
  headers: z.array(HeaderItem),
  params: z.array(ValueItem),
  features: z.record(z.string(), z.array(ValueItem)),
});

type Items = z.infer<typeof ValueItem>[];
function pick(items: Items, prev: Record<string, string> | undefined, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of items) {
    if (i.keep) {
      if (!prev || !Object.hasOwn(prev, i.name)) throw new InvalidRequest(`기존 값이 없어 유지할 수 없습니다: ${where}${i.name}`);
      out[i.name] = prev[i.name]!;
    } else out[i.name] = i.value ?? "";
  }
  return out;
}

/** PUT 본문과 기존 파일을 합쳐 새 파일 내용을 만든다. keep은 기존 값을 그대로 둔다. 본문에 없는 기능 id의 값은 보존한다. 빈 묶음은 쓰지 않는다. 형식 오류는 InvalidRequest(값은 싣지 않는다). */
export function mergePut(body: z.infer<typeof TargetPutBodySchema>, existing: RawTarget | null): RawTarget {
  const headers = pick(body.headers, existing?.headers, "헤더 ");
  const params = pick(body.params, existing?.params, "공통 값 ");
  // 본문에 없는 기능 id의 기존 값은 그대로 둔다. 본문에 있는 id는 본문이 전부다.
  const features = {
    ...Object.fromEntries(Object.entries(existing?.features ?? {}).filter(([fid]) => !Object.hasOwn(body.features, fid))),
    ...Object.fromEntries(Object.entries(body.features)
      .map(([fid, items]) => [fid, pick(items, existing?.features?.[fid], `${fid}.`)] as const)
      .filter(([, m]) => Object.keys(m).length > 0)),
  };
  const parsed = TargetSchema.safeParse({
    baseUrl: body.baseUrl,
    ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    ...(Object.keys(features).length ? { features } : {}),
  });
  if (!parsed.success) throw new InvalidRequest(`target 형식 오류. 확인할 필드: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(최상위)"))].join(", ")}`);
  return parsed.data;
}

/** recorded/*.json에서 기능 id·상태·시각만 읽는다(응답 본문은 싣지 않는다). */
export async function readRecordedSummaries(ws: Workspace, system: string): Promise<{ featureId: string; status: number; at: string }[]> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try { names = (await readdir(ws.file(system, "recorded"))).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out: { featureId: string; status: number; at: string }[] = [];
  for (const n of names) {
    try {
      const r = await ws.read(system, `recorded/${n}`, RecordedSchema);
      out.push({ featureId: r.featureId, status: r.response.status, at: r.recordedAt });
    } catch { /* 깨진 녹화 파일은 목록에서 뺀다 */ }
  }
  return out;
}
