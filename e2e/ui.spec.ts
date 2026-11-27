import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// 루트 package.json이 "type": "module"이라 __dirname이 없다.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "e2e", ".tmp");

test("흐름: 서비스 등록 → 흐름 화면 → 빈 입력 채우기 → mock 실행", async ({ page }) => {
  await page.goto("/new");
  await page.getByLabel("스펙 URL").fill(path.join(REPO, "packages", "core", "test", "fixtures", "flow", "github-issues.yaml"));
  await page.getByLabel("서비스 이름").fill("gh");
  await page.getByRole("button", { name: "스펙 읽기" }).click();
  await expect(page.getByLabel("주소")).toHaveValue("https://api.github.com");
  await page.getByRole("button", { name: "+ 값" }).click();
  await page.getByLabel("공통 값 1 이름").fill("owner");
  await page.getByLabel("공통 값 1 값").fill("octo"); // owner만 params로 둔다. repo는 흐름이 만든다(C6).
  await page.getByRole("checkbox", { name: /^issues 그룹 전체 선택$/ }).click();
  await page.getByRole("checkbox", { name: /^repos 그룹 전체 선택$/ }).click();
  await expect(page.getByText(/8개 선택/)).toBeVisible(); // 묶음 행은 체크할 때 받으므로 두 묶음이 다 들어온 뒤 누른다
  await page.getByRole("button", { name: "등록하고 흐름 만들기" }).click();
  await expect(page).toHaveURL(/\/systems\/gh\/flows$/);
  await page.getByRole("button", { name: /issue 다루기/ }).click();
  for (const [step, slot, value] of [["create_repo", "body.name", "flowtest"], ["create_issue", "body.title", "hello"]] as const) {
    await page.getByRole("button", { name: new RegExp(step) }).click();
    await page.getByLabel(`${slot} 값`).fill(value);
    await page.getByRole("button", { name: `${slot} 저장` }).click();
  }
  // repo는 앞 단계가 만든 것을 한 번 연결한다. get_issue·update_issue·delete_repo의 빈 path.repo에도 퍼진다.
  // create_issue 카드는 위 반복의 마지막에 열려 있다. Astryx Selector는 combobox라 열고 옵션을 누른다.
  await page.getByRole("combobox", { name: "path.repo 출처" }).click();
  await page.getByRole("option", { name: "앞 단계 응답" }).click();
  await page.getByRole("combobox", { name: "path.repo 앞 단계" }).click();
  await page.getByRole("option", { name: "create_repo" }).click();
  await page.getByLabel("path.repo 응답 필드").fill("name");
  await page.getByRole("button", { name: "path.repo 저장" }).click();
  await expect(page.getByText("입력 필요")).toHaveCount(0);
  // 첫 실행은 mock을 만들고 npm install을 한다. 설치가 안 되는 환경(네트워크 없음)에서는 기동 실패로 끝나므로,
  // 그때는 루트 node_modules를 링크해 한 번 더 실행한다(설계 §5: mock 실행만 실패로 표시).
  test.setTimeout(300_000);
  await page.getByRole("button", { name: "전체 실행" }).click();
  const success = page.locator(".flow-node .st-success").first();
  const failure = page.getByText(/mock을 띄우지 못했습니다/);
  await expect(success.or(failure)).toBeVisible({ timeout: 150_000 });
  if (await failure.isVisible()) {
    const modules = path.join(ROOT, "mock", "gh", "node_modules");
    await rm(modules, { recursive: true, force: true });
    await symlink(path.join(REPO, "node_modules"), modules, "dir");
    await page.getByRole("button", { name: "전체 실행" }).click();
  }
  await expect(success).toBeVisible({ timeout: 90_000 });
});
