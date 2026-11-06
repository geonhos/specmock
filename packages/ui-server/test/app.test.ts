import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

let root: string, webDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "specmock-ui-"));
  webDir = path.join(root, "web");
  await mkdir(path.join(webDir, "assets"), { recursive: true });
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>specmock</title>");
  await writeFile(path.join(webDir, "assets", "a.js"), "console.log(1)");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const HOST = { host: "127.0.0.1:4310" };
const make = () => createApp({ root, webDir, port: () => 4310 }).app;

describe("보안", () => {
  it("Host가 127.0.0.1:<port>·localhost:<port>면 통과", async () => {
    for (const host of ["127.0.0.1:4310", "localhost:4310"]) {
      expect((await make().request("/api/env", { headers: { host } })).status).toBe(200);
    }
  });
  it.each(["evil.example:4310", "127.0.0.1:9999", "127.0.0.1"])("Host %s → 403", async (host) => {
    const r = await make().request("/api/env", { headers: { host } });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("Origin이 있는데 같은 출처가 아니면 403, 같으면 통과", async () => {
    expect((await make().request("/api/env", { headers: { ...HOST, origin: "http://evil.example" } })).status).toBe(403);
    expect((await make().request("/api/env", { headers: { ...HOST, origin: "http://127.0.0.1:4310" } })).status).toBe(200);
  });
  it("허용하지 않는 메서드는 405 (PUT 전부, POST 전용 경로의 GET)", async () => {
    expect((await make().request("/api/systems/pets/selection", { method: "PUT", headers: HOST })).status).toBe(405);
    expect((await make().request("/api/systems/pets/generate", { headers: HOST })).status).toBe(405);
  });
});

describe("응답 형식", () => {
  it("/api/env → {ok:true,data:{root,claude}}", async () => {
    const body = await (await make().request("/api/env", { headers: HOST })).json();
    expect(body).toMatchObject({ ok: true, data: { root } });
    expect(typeof body.data.claude).toBe("boolean");
  });
  it("모르는 /api 경로 → 404 {ok:false,error:{code:not-found}}", async () => {
    const r = await make().request("/api/nope", { headers: HOST });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("정적 파일", () => {
  it("파일은 그대로, 모르는 화면 경로는 index.html(SPA)", async () => {
    const a = await make().request("/assets/a.js", { headers: HOST });
    expect(a.headers.get("content-type")).toMatch(/javascript/);
    const spa = await make().request("/systems/pets/select", { headers: HOST });
    expect(await spa.text()).toContain("<title>specmock</title>");
  });
  it("경로 탈출은 막는다", async () => {
    const r = await make().request("/..%2f..%2fetc%2fpasswd", { headers: HOST });
    expect(await r.text()).not.toContain("root:");
  });
});
