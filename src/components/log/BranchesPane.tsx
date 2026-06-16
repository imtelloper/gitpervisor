import { Check, GitBranch } from "lucide-react";

import { usePanelWidth } from "../../lib/use-panel-width";
import { useBranches } from "../../queries";
import { ResizeHandle } from "../common/ResizeHandle";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <div className="px-1 py-1 text-[10px] font-semibold tracking-wide text-fg-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Log 패널 좌측: 로컬/리모트 브랜치 트리 (현재 HEAD 체크 표시). */
export function BranchesPane({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useBranches(projectId);
  const { width, startResize } = usePanelWidth("gp:branches-width", 192, 130, 360);

  return (
    <div
      style={{ width }}
      className="relative shrink-0 border-r border-edge"
    >
      <div className="h-full overflow-y-auto p-2 text-xs">
        {isLoading ? (
        <span className="text-fg-dim">브랜치 …</span>
      ) : error ? (
        <span className="text-fg-dim">브랜치를 불러오지 못했습니다</span>
      ) : data ? (
        <>
          <Section title="Local">
            {data.local.length === 0 ? (
              <div className="px-1 text-fg-dim">없음</div>
            ) : (
              data.local.map((b) => {
                const current = b.name === data.head;
                return (
                  <div
                    key={b.name}
                    title={b.upstream ? `↥ ${b.upstream}` : "업스트림 없음"}
                    className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-raised"
                  >
                    {current ? (
                      <Check size={11} className="shrink-0 text-accent" />
                    ) : (
                      <span className="w-[11px] shrink-0" />
                    )}
                    <GitBranch size={11} className="shrink-0 text-fg-dim" />
                    <span
                      className={`truncate ${current ? "font-medium text-fg" : "text-fg-muted"}`}
                    >
                      {b.name}
                    </span>
                    {(b.ahead > 0 || b.behind > 0) && (
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-dim">
                        {b.ahead > 0 ? `↑${b.ahead}` : ""}
                        {b.behind > 0 ? `↓${b.behind}` : ""}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </Section>
          <Section title="Remote">
            {data.remote.length === 0 ? (
              <div className="px-1 text-fg-dim">없음</div>
            ) : (
              data.remote.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-fg-muted hover:bg-raised"
                >
                  <span className="w-[11px] shrink-0" />
                  <GitBranch size={11} className="shrink-0 text-fg-dim" />
                  <span className="truncate">{r.name}</span>
                </div>
              ))
            )}
          </Section>
        </>
      ) : null}
      </div>
      <ResizeHandle onMouseDown={startResize} />
    </div>
  );
}
