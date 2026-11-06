import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startUiServer } from "@specmock/ui-server";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "e2e", ".tmp");
await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
const ui = await startUiServer({ root: ROOT, port: 41517, claudeCommand: path.join(REPO, "packages", "core", "test", "bin", "claude") });
process.stdout.write(`ready ${ui.url}\n`);
process.once("SIGTERM", () => void ui.close().then(() => process.exit(0)));
