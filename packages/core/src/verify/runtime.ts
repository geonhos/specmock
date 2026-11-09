// packages/core/src/verify/runtime.ts
import { randomBytes } from "node:crypto";
import type { HttpMethod } from "../types.js";

export interface RuntimeSpec {
  notMocked: { id: string; method: HttpMethod; path: string }[];
  features: { method: HttpMethod; path: string }[];
}

export interface RuntimeCheck {
  id: "not_mocked" | "unknown_path";
  /** coverage.md·CLI에 보이는 이름. */
  name: string;
  passed: boolean;
  skipped: boolean;
  /** "GET /pets" 형태. skipped면 null. */
  request: string | null;
  expectedStatus: number;
  actualStatus: number | null;
  errors: string[];
}

/** TS 템플릿 notMocked.ts의 toRegex와 같은 규칙: {x} → 한 세그먼트, 끝 슬래시 허용. */
function toRegex(p: string): RegExp {
  return new RegExp("^" + p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "/?$");
}
const fill = (p: string) => p.replace(/\{[^}]+\}/g, "1");

/** 요청 경로가 선택된 같은 method 기능과 겹치지 않는 첫 notMocked 항목. HEAD(바디 없음)·OPTIONS(프레임워크가 가로챌 수 있음)는 제외한다. */
export function pickNotMocked(rt: RuntimeSpec): RuntimeSpec["notMocked"][number] | null {
  for (const n of rt.notMocked) {
    if (n.method === "HEAD" || n.method === "OPTIONS") continue;
    const url = fill(n.path);
    if (!rt.features.some((f) => f.method === n.method && toRegex(f.path).test(url))) return n;
  }
  return null;
}

async function probe(base: string, method: string, p: string, expected: number, check: (body: Record<string, unknown>) => string[]): Promise<Pick<RuntimeCheck, "passed" | "actualStatus" | "errors">> {
  const errors: string[] = [];
  let actualStatus: number | null = null;
  try {
    const res = await fetch(new URL(p, base), { method, signal: AbortSignal.timeout(10_000) });
    actualStatus = res.status;
    const text = await res.text();
    if (res.status !== expected) errors.push(`status: expected ${expected}, got ${res.status}`);
    else {
      let body: unknown;
      try { body = JSON.parse(text); } catch { errors.push(`body is not JSON: ${text.slice(0, 200)}`); }
      if (body !== undefined) errors.push(...check((body ?? {}) as Record<string, unknown>));
    }
  } catch (e) {
    errors.push(`request failed: ${(e as Error).message}`);
  }
  return { passed: errors.length === 0, actualStatus, errors };
}

/** 계약 7(선택 안 된 기능 → 501)과 8(모르는 경로 → 404). rt가 없으면 8만 본다. */
export async function runRuntimeChecks(base: string, rt: RuntimeSpec | undefined): Promise<RuntimeCheck[]> {
  const out: RuntimeCheck[] = [];
  if (rt) {
    const n = pickNotMocked(rt);
    if (!n) {
      out.push({ id: "not_mocked", name: "선택 안 된 기능 → 501", passed: true, skipped: true, request: null, expectedStatus: 501, actualStatus: null, errors: [] });
    } else {
      const p = fill(n.path);
      const r = await probe(base, n.method, p, 501, (b) => [
        ...(b.error === "not_mocked" ? [] : [`body.error: expected "not_mocked", got ${JSON.stringify(b.error)}`]),
        ...(b.feature === n.id ? [] : [`body.feature: expected "${n.id}", got ${JSON.stringify(b.feature)}`]),
      ]);
      out.push({ id: "not_mocked", name: "선택 안 된 기능 → 501", skipped: false, request: `${n.method} ${p}`, expectedStatus: 501, ...r });
    }
  }
  const p = `/__specmock/unknown-${randomBytes(4).toString("hex")}`;
  const r = await probe(base, "GET", p, 404, (b) => (b.error === "unknown_path" ? [] : [`body.error: expected "unknown_path", got ${JSON.stringify(b.error)}`]));
  out.push({ id: "unknown_path", name: "모르는 경로 → 404", skipped: false, request: `GET ${p}`, expectedStatus: 404, ...r });
  return out;
}
