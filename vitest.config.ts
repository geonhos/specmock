import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: "node", include: ["packages/*/test/**/*.test.ts"], exclude: ["packages/web/**", "**/node_modules/**"] } },
      "packages/web/vite.config.ts",
    ],
  },
});
