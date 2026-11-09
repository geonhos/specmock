// packages/core/src/record/recorded.ts
import { readdir, rm } from "node:fs/promises";
import { RecordedSchema, type Recorded } from "../types.js";
import type { Workspace } from "../workspace.js";

export const RECORDED_DIR = "recorded";
const SAFE_ID = /^[\p{L}\p{N}_.-]+$/u;

/** 경로 구분자·공백 없이 글자·숫자·`_.-`만, `.`·`..`은 안 된다. */
export function isSafeFeatureId(id: string): boolean {
  return SAFE_ID.test(id) && id !== "." && id !== "..";
}

export function recordedName(featureId: string): string {
  if (!isSafeFeatureId(featureId)) throw new Error(`녹화 파일 이름으로 쓸 수 없는 기능 id: ${featureId}`);
  return `${RECORDED_DIR}/${featureId}.json`;
}

/** 없으면 null. 형식이 깨졌으면 ws.read의 오류를 그대로 던진다. 안전하지 않은 id는 null. */
export async function readRecorded(ws: Workspace, system: string, featureId: string): Promise<Recorded | null> {
  if (!isSafeFeatureId(featureId)) return null;
  const name = recordedName(featureId);
  if (!(await ws.exists(system, name))) return null;
  return ws.read(system, name, RecordedSchema);
}

/** keep(기능 id)에 없는 녹화 파일만 지운다. 디렉터리가 없으면 아무것도 하지 않는다. */
export async function pruneRecorded(ws: Workspace, system: string, keep: Set<string>): Promise<void> {
  let names: string[];
  try { names = await readdir(ws.file(system, RECORDED_DIR)); } catch { return; }
  for (const n of names) {
    if (!keep.has(n.replace(/\.json$/, ""))) await rm(ws.file(system, `${RECORDED_DIR}/${n}`), { recursive: true, force: true });
  }
}
