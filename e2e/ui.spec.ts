import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// 루트 package.json이 "type": "module"이라 __dirname이 없다.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "e2e", ".tmp");

test("OpenAPI: 등록 → 분석 → 선택 → 생성 → 검증을 화면만으로", async ({ page }) => {
  await page.goto("/new");
  await page.getByLabel("스펙 경로 또는 URL").fill(path.join(REPO, "examples", "petstore", "petstore.yaml"));
  await expect(page.getByLabel("시스템 이름")).toHaveValue("petstore");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await expect(page).toHaveURL(/\/systems\/petstore\/analyze$/);
  await page.getByRole("button", { name: "분석하기" }).click();
  await expect(page).toHaveURL(/\/systems\/petstore\/select$/);
  const saved = page.waitForResponse((r) => r.url().endsWith("/selection") && r.request().method() === "POST");
  await page.getByRole("checkbox", { name: /^pets 그룹 전체 선택$/ }).click();   // 그룹 하나 전체 선택
  await saved;
  await expect(page.getByText(/^\d+개 선택$/)).toBeVisible();
  await page.getByRole("button", { name: "mock 만들기" }).click();
  await expect(page.getByLabel("출력 디렉터리")).toHaveValue(path.join(ROOT, "mock", "petstore"));
  await page.getByRole("button", { name: "생성", exact: true }).click();
  await expect(page.getByRole("region", { name: "생성 결과" })).toBeVisible();
  // npm install을 건너뛰도록 루트 node_modules를 링크한다(2A 테스트와 같은 방식).
  await symlink(path.join(REPO, "node_modules"), path.join(ROOT, "mock", "petstore", "node_modules"), "dir");
  await page.getByRole("button", { name: "⑤ 검증으로 →" }).click();
  await page.getByRole("button", { name: "검증 시작" }).click();
  await expect(page.getByText(/통과 \d+ · 실패 0/)).toBeVisible({ timeout: 90_000 });
});

test("문서: 가짜 claude로 추출 → 카탈로그", async ({ page }) => {
  const sample = path.join(ROOT, "docs-sample");
  await cp(path.join(REPO, "examples", "docs-sample"), sample, { recursive: true });
  await page.goto("/new");
  await page.getByLabel("스펙 경로 또는 URL").fill(path.join(sample, "pets-api.md"));
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.getByRole("button", { name: "분석하기" }).click();
  await page.getByRole("button", { name: "추출 시작" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "추출 시작" }).click();
  await expect(page).toHaveURL(/\/systems\/pets-api\/select$/, { timeout: 60_000 });
  await expect(page.getByRole("checkbox", { name: /\/pets\/\{petId\} 선택$/ }).first()).toBeVisible();
});

test("⑥ 녹화: 설정·환경 변수·경로 변수 입력 → 가짜 실제 서버와 대조해 일치", async ({ page }) => {
  // Authorization: Bearer tok 이 있어야 응답하는 가짜 실제 서버.
  const real = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer tok") { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "p1", name: "Rex" }));
  });
  await new Promise<void>((ok) => real.listen(0, "127.0.0.1", ok));
  const baseUrl = `http://127.0.0.1:${(real.address() as AddressInfo).port}`;
  try {
    const dir = path.join(ROOT, "real-sample");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "pets.yaml"), [
      "openapi: 3.0.3", "info: { title: 녹화 예제, version: '1' }", "paths:", "  /pets/{id}:", "    get:", "      operationId: getPet", "      tags: [pets]",
      "      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]",
      "      responses:", "        '200':", "          description: ok", "          content:", "            application/json:",
      "              schema: { type: object, required: [id, name], properties: { id: { type: string }, name: { type: string } } }", "",
    ].join("\n"));
    await page.goto("/new");
    await page.getByLabel("스펙 경로 또는 URL").fill(path.join(dir, "pets.yaml"));
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.getByRole("button", { name: "분석하기" }).click();
    await expect(page).toHaveURL(/\/systems\/pets\/select$/);
    const saved = page.waitForResponse((r) => r.url().endsWith("/selection") && r.request().method() === "POST");
    await page.getByRole("checkbox", { name: /^pets 그룹 전체 선택$/ }).click();
    await saved;
    await page.goto("/systems/pets/record");
    await page.getByLabel("주소").fill(baseUrl);
    await page.getByRole("button", { name: "+ 헤더" }).click();
    await page.getByLabel("헤더 1 이름").fill("Authorization");
    await page.getByLabel("헤더 1 값").fill("Bearer ${TOKEN}");
    await page.getByLabel("TOKEN 값").fill("tok");
    await page.getByRole("button", { name: "TOKEN 이번 세션에 사용" }).click();
    await expect(page.getByText("설정됨(화면 입력)")).toBeVisible();
    await page.getByLabel("getPet id").fill("p1");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await page.getByLabel("mock에 반영").uncheck();
    await page.getByRole("button", { name: "선택한 1개 녹화" }).click();
    await expect(page.getByRole("table", { name: "녹화할 기능" }).getByText("일치", { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally { real.close(); }
});
