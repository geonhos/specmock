// packages/core/src/generate/scaffold.ts
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Contract, MockFeature, MockSpec } from "../types.js";
import { hashText } from "../util/hash.js";
import type { LanguageOutput } from "./generator.js";
import type { Lock } from "./lock.js";

export async function writeOut(outDir: string, rel: string, text: string, written: string[]): Promise<void> {
  const file = path.join(outDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  written.push(rel);
}

/** dir 안에서 stale(name)이 참인 항목을 지운다. dir이 없으면 아무 일도 하지 않는다. */
export async function removeStale(dir: string, stale: (name: string) => boolean): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (stale(name)) await rm(path.join(dir, name), { recursive: true, force: true });
  }
}

export function lowest2xxStatus(f: MockFeature): number {
  return f.fixtures.filter((x) => x.status >= 200 && x.status < 300).map((x) => x.status).sort((a, b) => a - b)[0] ?? 200;
}

/** 언어 종속 파일을 순서대로 쓰고(null은 삭제), prune 규칙으로 생성기 소유 디렉터리를 정리한다. */
export async function writeLanguageFiles(outDir: string, output: LanguageOutput, written: string[]): Promise<void> {
  for (const f of output.files) {
    if (f.content === null) await rm(path.join(outDir, f.path), { force: true });
    else await writeOut(outDir, f.path, f.content, written);
  }
  for (const p of output.prune ?? []) {
    const keep = new Set(output.files.filter((f) => f.content !== null && path.posix.dirname(f.path) === p.dir).map((f) => path.posix.basename(f.path)));
    await removeStale(path.join(outDir, p.dir), (name) => name.endsWith(p.ext) && !keep.has(name));
  }
}

export interface ScaffoldResult {
  fixtureHashes: Record<string, string>;
  preserved: string[];
  orphaned: string[];
}

/** fixtures(보존 규칙)·contracts·고아 fixture. 기존 renderTsHono의 쓰기 순서(기능마다 fixture → contract)를 그대로 지킨다. */
export async function writeScaffold(spec: MockSpec, outDir: string, previous: Lock | null, opts: { force?: boolean }, written: string[]): Promise<ScaffoldResult> {
  const preserved: string[] = [];
  const orphaned: string[] = [];
  // lock의 fixtureHashes에는 "생성기가 썼을 내용"의 해시를 기록한다.
  // 사용자가 수정한 파일을 보존할 때도 생성 텍스트의 해시를 남겨야 다음 재생성에서 다시 수정으로 인식한다.
  // 라우트는 가장 낮은 2xx 하나만 서빙하므로 그 fixture만 파일로 쓴다. 나머지(4xx 등)는 mockspec에만 남아 coverage 집계에 쓰인다.
  const fixtureHashes: Record<string, string> = {};
  for (const f of spec.features) {
    const served = lowest2xxStatus(f);
    for (const fx of f.fixtures) {
      if (fx.status !== served) continue;
      const rel = `fixtures/${f.id}/${fx.status}.json`;
      const text = JSON.stringify(fx.body, null, 2) + "\n";
      const file = path.join(outDir, rel);
      const current = await readFile(file, "utf8").catch(() => null);
      const recorded = previous?.fixtureHashes[rel];
      const userEdited = current !== null && recorded !== undefined && hashText(current) !== recorded;
      fixtureHashes[rel] = hashText(text);
      if (userEdited && !opts.force) {
        preserved.push(rel);
        continue;
      }
      await writeOut(outDir, rel, text, written);
    }
    const contracts: Contract[] = spec.contracts.filter((c) => c.featureId === f.id);
    await writeOut(outDir, `contracts/${f.id}.json`, JSON.stringify(contracts, null, 2) + "\n", written);
  }
  // 선택에서 빠진 기능의 contract를 지운다. verify는 contracts/*.json을 모두 읽으므로 남겨두면 실패한다.
  const featureIds = new Set(spec.features.map((f) => f.id));
  await removeStale(path.join(outDir, "contracts"), (name) => name.endsWith(".json") && !featureIds.has(name.slice(0, -".json".length)));

  // 선택에서 빠진 기능의 fixture: 수정하지 않았으면 지우고, 수정했으면 남겨두고 보고한다.
  for (const [rel, recorded] of Object.entries(previous?.fixtureHashes ?? {})) {
    if (rel in fixtureHashes) continue;
    const file = path.join(outDir, rel);
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === null) continue;
    if (hashText(current) === recorded) {
      await rm(file, { force: true });
      await rmdir(path.dirname(file)).catch(() => undefined); // 비어 있을 때만 지워진다.
    } else {
      orphaned.push(rel);
    }
  }
  return { fixtureHashes, preserved, orphaned };
}
