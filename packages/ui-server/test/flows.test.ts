import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const GITHUB = path.join(REPO, "packages", "core", "test", "fixtures", "flow", "github-issues.yaml");
const HOST = { host: "127.0.0.1:4310", "content-type": "application/json" };
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specmock-flows-")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function client() {
  const { app } = createApp({ root, webDir: path.join(root, "web"), port: () => 4310 });
  const req = async (method: string, p: string, b?: unknown) => { const r = await app.request(`/api${p}`, { method, headers: HOST, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }); return { status: r.status, body: await r.json() }; };
  return { get: (p: string) => req("GET", p), post: (p: string, b: unknown = {}) => req("POST", p, b), put: (p: string, b: unknown) => req("PUT", p, b) };
}
async function registered() {
  const c = client();
  await c.post("/systems", { system: "gh", origins: [GITHUB] });
  await c.post("/systems/gh/analyze");
  const ids = (await c.get("/systems/gh/features")).body.data.rows.map((r: { id: string }) => r.id);
  await c.post("/systems/gh/selection", { ids });
  return c;
}

describe("flow routes", () => {
  it("infer → list → detail → fill an input", async () => {
    const c = await registered();
    expect((await c.get("/systems/gh/flows")).body.data).toEqual({ inferredAt: null, notes: [], flows: [] });
    const inf = await c.post("/systems/gh/flows/infer");
    expect(inf.status).toBe(200);
    const list = (await c.get("/systems/gh/flows")).body.data;
    expect(list.flows.map((f: { id: string }) => f.id)).toEqual(["repos", "issues"]);
    const d = (await c.get("/systems/gh/flows/issues")).body.data;
    expect(d.empty).toContain("create_issue:body.title");
    expect(d.empty).toContain("create_issue:path.repo"); // 앞 단계가 만드는 repo는 params로 채우지 않는다(C6)
    const set = await c.post("/systems/gh/flows/issues/inputs", { stepId: "create_issue", slot: "body.title", source: { kind: "user", value: "hello" } });
    expect(set.status).toBe(200);
    expect((await c.get("/systems/gh/flows/issues")).body.data.empty).not.toContain("create_issue:body.title");
    // repo를 한 번 연결하면 같은 repo를 쓰는 다른 단계의 빈 칸에도 퍼진다(setInput, Task 3)
    const link = await c.post("/systems/gh/flows/issues/inputs", { stepId: "create_issue", slot: "path.repo", source: { kind: "step", step: "create_repo", field: "name" } });
    expect(link.status).toBe(200);
    expect(link.body.data.empty.filter((e: string) => e.endsWith(":path.repo"))).toEqual([]);
    const bad = await c.post("/systems/gh/flows/issues/inputs", { stepId: "nope", slot: "body.title", source: { kind: "empty" } });
    expect(bad).toMatchObject({ status: 400, body: { ok: false, error: { code: "invalid" } } });
    expect((await c.get("/systems/gh/flows/nope")).status).toBe(404);
  });

  it("infer before selection is a 400 with the fix-it message", async () => {
    const c = client();
    await c.post("/systems", { system: "gh", origins: [GITHUB] });
    await c.post("/systems/gh/analyze");
    expect(await c.post("/systems/gh/flows/infer")).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("먼저 기능을 고르세요") } } });
  });

  it("safety switch: on by default, set off, back on after another system is viewed", async () => {
    const c = await registered();
    await c.post("/systems", { system: "other", origins: [GITHUB] });
    expect((await c.get("/systems/gh/safety")).body.data).toEqual({ on: true });
    expect((await c.post("/systems/gh/safety", { on: false })).body.data).toEqual({ on: false });
    expect((await c.get("/systems/gh/safety")).body.data).toEqual({ on: false });
    expect((await c.get("/systems/other/safety")).body.data).toEqual({ on: true });
    expect((await c.get("/systems/gh/safety")).body.data).toEqual({ on: true });
  });

  it("run: real without token/baseUrl is 409, missing features 409, mock-only is accepted", async () => {
    vi.stubEnv("SPECMOCK_TEST_UNSET_TOKEN", ""); // 셸에 값이 있어도 비어 있는 것으로 본다
    const c = await registered();
    await c.post("/systems/gh/flows/infer");
    await c.put("/systems/gh/target", { baseUrl: "https://api.github.com", headers: [{ name: "Authorization", value: "Bearer ${SPECMOCK_TEST_UNSET_TOKEN}" }], params: [], features: {} });
    const real = await c.post("/systems/gh/flows/issues/run", { targets: ["real"] });
    expect(real).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining("mock 실행은 할 수 있어요") } } });
    expect((await c.post("/systems/gh/flows/issues/run", { targets: [] })).status).toBe(400);
    expect((await c.get("/systems/gh/flows/issues/run")).status).toBe(405);
    // 빈 선택은 select가 거부한다(select/index.ts:74). issue 기능만 빼서 issues 흐름의 기능을 없앤다.
    const ids = (await c.get("/systems/gh/features")).body.data.rows.map((r: { id: string }) => r.id).filter((id: string) => !id.startsWith("issues_"));
    await c.post("/systems/gh/selection", { ids });
    expect((await c.post("/systems/gh/flows/issues/run", { targets: ["mock"] })).status).toBe(409);
  });

  it("target info carries suggestedBaseUrl from the OpenAPI servers", async () => {
    const c = await registered();
    expect((await c.get("/systems/gh/target")).body.data).toMatchObject({ exists: false, suggestedBaseUrl: "https://api.github.com" });
  });

  it("feature-groups returns per-group totals and no rows; ?group= returns one group's rows", async () => {
    const c = client();
    await c.post("/systems", { system: "gh", origins: [GITHUB] });
    await c.post("/systems/gh/analyze");
    expect((await c.get("/systems/gh/feature-groups")).body.data).toEqual({ total: 8, groups: [{ group: "issues", total: 4 }, { group: "repos", total: 4 }] });
    const issues = (await c.get("/systems/gh/features?group=issues")).body.data;
    expect(issues.rows.map((r: { group: string }) => r.group)).toEqual(["issues", "issues", "issues", "issues"]);
  });

  it("inputs on an unknown flow → 404, like GET (#45)", async () => {
    const c = await registered();
    await c.post("/systems/gh/flows/infer");
    const r = await c.post("/systems/gh/flows/nope/inputs", { stepId: "create_issue", slot: "body.title", source: { kind: "empty" } });
    expect(r).toMatchObject({ status: 404, body: { ok: false } });
    expect((await c.get("/systems/gh/flows/nope")).status).toBe(404);
  });
});
