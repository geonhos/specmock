import type { Job } from "@specmock/ui-server/api-types";

interface Props { system: string; jobs: Job[]; tick: number; go: (path: string) => void; refreshJobs: () => void; onChanged: () => void }

export function Record(_props: Props) {
  return <div className="analyze record" />;
}
