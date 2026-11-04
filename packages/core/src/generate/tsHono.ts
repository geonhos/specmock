import { Eta } from "eta";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Contract, MockFeature, MockSpec } from "../types.js";
import { hashJson, hashText } from "../util/hash.js";
import { readLock, writeLock, type Lock } from "./lock.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/ts-hono/", import.meta.url));

export interface GenerateReport {
  outDir: string;
  written: string[];
  preserved: string[];
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * 파일 이름·식별자로 쓸 수 있는 고유한 이름을 배정한다.
 * safeName은 서로 다른 입력을 같은 값으로 만들 수 있으므로(예: 한글 태그 `결제`/`주문` → `__`),
 * 비어 있거나 숫자로 시작하면 `g_`를 붙이고 이미 쓰인 이름이면 2, 3, …을 덧붙인다.
 */
export class NameRegistry {
  private readonly used = new Set<string>();

  claim(raw: string): string {
    let base = safeName(raw);
    if (base === "" || /^[0-9]/.test(base)) base = `g_${base}`;
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}${n}`;
    this.used.add(name);
    return name;
  }
}

export function honoPath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, ":$1");
}

function lowest2xxStatus(f: MockFeature): number {
  return f.fixtures.filter((x) => x.status >= 200 && x.status < 300).map((x) => x.status).sort((a, b) => a - b)[0] ?? 200;
}

function paramsSchema(entries: Record<string, { schema: Record<string, unknown> | null; required: boolean }>) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(entries).map(([k, p]) => [k, p.schema ?? {}])),
    required: Object.entries(entries).filter(([, p]) => p.required).map(([k]) => k),
  };
}

export function validationSchema(f: MockFeature) {
  return {
    type: "object",
    properties: {
      params: paramsSchema(f.request.params),
      query: paramsSchema(f.request.query),
      body: f.request.body ?? {},
    },
    required: f.request.body ? ["body"] : [],
  };
}

async function writeOut(outDir: string, rel: string, text: string, written: string[]): Promise<void> {
  const file = path.join(outDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  written.push(rel);
}

export async function renderTsHono(spec: MockSpec, outDir: string, opts: { force?: boolean } = {}): Promise<GenerateReport> {
  const eta = new Eta({ views: TEMPLATES, autoEscape: false, autoTrim: false });
  const previous = await readLock(outDir);
  const written: string[] = [];
  const preserved: string[] = [];

  const groupNames = new NameRegistry();
  const featureNames = new NameRegistry();
  const groups = [...new Set(spec.features.map((f) => f.group))].sort().map((name) => ({
    name,
    safe: groupNames.claim(name),
    features: spec.features
      .filter((f) => f.group === name)
      .map((f) => ({
        id: f.id,
        safe: featureNames.claim(f.id),
        title: f.title,
        method: f.method,
        honoPath: honoPath(f.path),
        hasBody: Boolean(f.request.body),
        status: lowest2xxStatus(f),
        validation: validationSchema(f),
      })),
  }));

  const view = {
    system: spec.system,
    featureCount: spec.features.length,
    groups,
    notMocked: spec.notMocked,
    allFeatures: spec.features.map((f) => ({
      id: f.id, method: f.method, path: f.path,
      fixtureSource: f.fixtures.find((x) => x.status === lowest2xxStatus(f))?.source ?? "empty",
    })),
  };

  // Eta는 이름에 확장자가 이미 있으면 .eta를 붙이지 않으므로 명시한다.
  const render = (name: string, data: object = view) => eta.render(`${name}.eta`, data);
  for (const name of ["package.json", "tsconfig.json", "README.md", "src/server.ts", "src/notMocked.ts", "src/fixtures.ts", "src/validate.ts"]) {
    await writeOut(outDir, name, render(name), written);
  }
  for (const g of groups) {
    await writeOut(outDir, `src/routes/${g.safe}.ts`, render("src/route.ts", { ...view, group: g.name, features: g.features }), written);
  }

  const fixtureHashes: Record<string, string> = {};
  for (const f of spec.features) {
    for (const fx of f.fixtures) {
      const rel = `fixtures/${f.id}/${fx.status}.json`;
      const text = JSON.stringify(fx.body, null, 2) + "\n";
      const file = path.join(outDir, rel);
      const current = await readFile(file, "utf8").catch(() => null);
      const recorded = previous?.fixtureHashes[rel];
      const userEdited = current !== null && recorded !== undefined && hashText(current) !== recorded;
      if (userEdited && !opts.force) {
        preserved.push(rel);
        fixtureHashes[rel] = hashText(current);
        continue;
      }
      await writeOut(outDir, rel, text, written);
      fixtureHashes[rel] = hashText(text);
    }
    const contracts: Contract[] = spec.contracts.filter((c) => c.featureId === f.id);
    await writeOut(outDir, `contracts/${f.id}.json`, JSON.stringify(contracts, null, 2) + "\n", written);
  }

  const lock: Lock = {
    system: spec.system,
    language: "ts",
    mockspecHash: hashJson(spec),
    generatedAt: new Date().toISOString(),
    start: { command: "npx", args: ["tsx", "src/server.ts"] },
    healthPath: "/__specmock/health",
    fixtureHashes,
  };
  await writeLock(outDir, lock);
  return { outDir, written, preserved };
}
