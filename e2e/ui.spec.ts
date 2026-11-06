import { cp, symlink } from "node:fs/promises";
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
