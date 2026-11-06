import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
  it("Origin: null·Host 누락·IPv6 Host는 403", async () => {
    expect((await make().request("/api/env", { headers: { ...HOST, origin: "null" } })).status).toBe(403);
    expect((await make().request("/api/env", { headers: { host: "" } })).status).toBe(403);
    expect((await make().request("/api/env", { headers: { host: "[::1]:4310" } })).status).toBe(403);
    const noHost = await make().request(new Request("http://x/api/env"));
    expect(noHost.status).toBe(403);
  });
  it("Host·Origin이 둘 다 로컬이면 127.0.0.1/localhost 교차 조합도 허용", async () => {
    const r = await make().request("/api/env", { headers: { host: "127.0.0.1:4310", origin: "http://localhost:4310" } });
    expect(r.status).toBe(200);
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
  it.each(["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%2fsecret.txt"])(
    "경로 탈출 %s 은 비밀 파일을 돌려주지 않는다",
    async (p) => {
      await writeFile(path.join(root, "secret.txt"), "TOP-SECRET-VALUE");
      const r = await make().request(p, { headers: HOST });
      expect(await r.text()).not.toContain("TOP-SECRET-VALUE");
    },
  );
  it("웹 폴더 안의 심볼릭 링크가 바깥 파일을 가리켜도 서빙하지 않는다", async () => {
    await writeFile(path.join(root, "secret.txt"), "TOP-SECRET-VALUE");
    await symlink(path.join(root, "secret.txt"), path.join(webDir, "assets", "link.txt"));
    await symlink(root, path.join(webDir, "assets", "dirlink"));
    for (const p of ["/assets/link.txt", "/assets/dirlink/secret.txt"]) {
      const r = await make().request(p, { headers: HOST });
      expect(await r.text()).not.toContain("TOP-SECRET-VALUE");
    }
  });
});
