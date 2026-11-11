// packages/core/src/record/recorded.ts
import { rm } from "node:fs/promises";
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

/** ids에 해당하는 녹화 파일만 지운다. 없는 파일은 무시한다. */
export async function pruneRecorded(ws: Workspace, system: string, ids: Iterable<string>): Promise<void> {
  for (const id of ids) await rm(ws.file(system, recordedName(id)), { force: true });
}
