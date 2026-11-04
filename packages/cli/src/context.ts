import path from "node:path";
import { Workspace } from "@specmock/core";
import type { Command } from "commander";

export function workspaceFrom(cmd: Command): Workspace {
  const opts = cmd.optsWithGlobals() as { workspace?: string };
  return new Workspace(path.resolve(opts.workspace ?? ".specmock"));
}

export function printJsonOr(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : text()) + "\n");
}

export function fail(message: string): never {
  process.stderr.write(`오류: ${message}\n`);
  process.exit(1);
}
