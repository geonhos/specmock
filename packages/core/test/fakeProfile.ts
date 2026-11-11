// packages/core/test/fakeProfile.ts
import { isBodyRequired } from "../src/bodyRequired.js";
import type { LanguageProfile } from "../src/generate/profiles/types.js";
import type { MockSpec } from "../src/types.js";

/** 테스트 전용 언어. install 없음, node로 server.mjs 실행, 정적 파일 없음. */
export const fakeProfile: LanguageProfile = {
  language: "fake",
  displayName: "Fake (Node http)",
  rules: ["Node 내장 http만 쓴다.", "server.mjs 하나에 모든 라우트를 둔다."],
  staticFiles: [],
  artifacts: [],
  install: () => null,
  start: { command: "node", args: ["server.mjs"] },
  healthPath: "/__specmock/health",
  startTimeoutMs: 10_000,
  installTimeoutMs: 10_000,
  sourceGlobs: ["server.mjs", "lib/**"],
  protectedPaths: ["fixtures/**", "contracts/**", "specmock.lock.json", ".specmock-installed"],
  maxFiles: 5,
  requires: "Node 22",
  referenceFiles: [],
};

/**
 * 런타임 계약을 모두 지키는 server.mjs. 선택 기능은 fixtures/<id>/<status>.json을 요청마다 읽고,
 * 필수 query·body 누락은 400, notMocked는 501, 그 밖은 404. 헬스는 TS 템플릿과 같은 {ok:true, system, features}.
 * opts.omit501 = true면 notMocked도 404를 낸다(계약 7 실패 재현용).
 */
export function fakeServerSource(spec: MockSpec, opts: { omit501?: boolean } = {}): string {
  const routes = spec.features.map((f) => {
    const ok = f.fixtures.map((x) => x.status).filter((s) => s >= 200 && s < 300).sort((a, b) => a - b)[0] ?? 200;
    const required = Object.entries(f.request.query).filter(([, p]) => p.required).map(([k]) => k);
    return { id: f.id, method: f.method, path: f.path, status: ok, required, hasBody: isBodyRequired(f.request.body) };
  });
  const notMocked = opts.omit501 ? [] : spec.notMocked;
  return `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = ${JSON.stringify(routes)};
const notMocked = ${JSON.stringify(notMocked)};
const re = (p) => new RegExp("^" + p.replace(/\\{[^}]+\\}/g, "[^/]+") + "/?$");
const send = (res, status, body) => { res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__specmock/health") return send(res, 200, { ok: true, system: ${JSON.stringify(spec.system)}, features: routes.length });
  const r = routes.find((x) => x.method === req.method && re(x.path).test(url.pathname));
  if (r) {
    const missing = r.required.filter((k) => !url.searchParams.has(k));
    if (missing.length) return send(res, 400, { error: "validation_failed", details: missing.map((k) => "query." + k + " is required") });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (r.hasBody) {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (parsed === null || typeof parsed !== "object") return send(res, 400, { error: "validation_failed", details: ["body is required"] });
    }
    if (r.status === 204 || r.status === 205) return send(res, r.status);
    const body = JSON.parse(await readFile(new URL("./fixtures/" + r.id + "/" + r.status + ".json", import.meta.url), "utf8"));
    return send(res, r.status, body);
  }
  const n = notMocked.find((x) => x.method === req.method && re(x.path).test(url.pathname));
  if (n) return send(res, 501, { error: "not_mocked", feature: n.id, hint: "specmock select " + ${JSON.stringify(spec.system)} + " --add " + n.id + " && specmock generate " + ${JSON.stringify(spec.system)} });
  send(res, 404, { error: "unknown_path", method: req.method, path: url.pathname });
});
server.listen(Number(process.env.PORT ?? 4010), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}
