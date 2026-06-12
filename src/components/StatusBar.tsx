import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project } from "../lib/ipc";
import { relativeTime } from "../lib/format";
import { useStatus } from "../queries";

export function StatusBar({ project }: { project: Project | null }) {
  const { data: status, dataUpdatedAt } = useStatus(project?.id ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-panel px-3 text-[11px] text-fg-dim">
      {project ? (
        <>
          <span className="min-w-0 truncate select-text font-mono">
            {project.path}
          </span>
          {status?.branch && (
            <span className="flex shrink-0 items-center gap-1">
              <GitBranch size={10} />
              <span className="font-mono">{status.branch}</span>
            </span>
          )}
          <span className="ml-auto shrink-0">
            {dataUpdatedAt > 0 &&
              `마지막 갱신 ${relativeTime(dataUpdatedAt, now)}`}
          </span>
        </>
      ) : (
        <span>Gitpervisor</span>
      )}
    </footer>
  );
}
