import type { Job } from "@specmock/ui-server/api-types";

/** Shell, replaced by the flow screen in the next commit. */
export function Flows(_: { system: string; jobs: Job[]; tick: number; refreshJobs: () => void }) {
  return null;
}
