import { defineConfig, chromium } from "@playwright/test";
import { existsSync } from "node:fs";

if (!existsSync(chromium.executablePath())) {
  throw new Error("E2E용 브라우저가 없어요. `pnpm exec playwright install chromium`을 한 번 실행한 뒤 다시 `pnpm test:e2e`를 실행하세요.");
}

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:41517", browserName: "chromium" },
  webServer: { command: "node --import tsx e2e/serve.ts", url: "http://127.0.0.1:41517/api/env", reuseExistingServer: false, timeout: 60_000 },
});
