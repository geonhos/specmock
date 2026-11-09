import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import type { MockFeature, MockSpec } from "../types.js";
import type { GenerateContext, LanguageGenerator, LanguageOutput } from "./generator.js";
import { lowest2xxStatus } from "./scaffold.js";

const TEMPLATES = fileURLToPath(new URL("../../templates/ts-hono/", import.meta.url));

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

export const TS_FIXED_FILES = ["package.json", "tsconfig.json", "README.md", "src/server.ts", "src/notMocked.ts", "src/fixtures.ts", "src/validate.ts"];

/** 기존 eta 템플릿으로 TS(Hono) 파일을 렌더한다. 디스크에 쓰지 않는다. */
export function renderTsHonoFiles(spec: MockSpec): { path: string; content: string }[] {
  const eta = new Eta({ views: TEMPLATES, autoEscape: false, autoTrim: false });
  const groupNames = new NameRegistry();
  const featureNames = new NameRegistry();
  const groups = [...new Set(spec.features.map((f) => f.group))].sort().map((name) => ({
    name,
    safe: groupNames.claim(name),
    features: spec.features
      .filter((f) => f.group === name)
      .map((f: MockFeature) => ({
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
  const files = TS_FIXED_FILES.map((name) => ({ path: name, content: render(name) }));
  for (const g of groups) {
    files.push({ path: `src/routes/${g.safe}.ts`, content: render("src/route.ts", { ...view, group: g.name, features: g.features }) });
  }
  return files;
}

export class TsHonoGenerator implements LanguageGenerator {
  readonly language = "ts";
  readonly generator = "template" as const;
  async generate(ctx: GenerateContext): Promise<LanguageOutput> {
    return {
      files: renderTsHonoFiles(ctx.spec),
      install: null,
      start: { command: "npx", args: ["tsx", "src/server.ts"] },
      healthPath: "/__specmock/health",
      notes: [],
      prune: [{ dir: "src/routes", ext: ".ts" }],
      attempts: 0,
    };
  }
}
