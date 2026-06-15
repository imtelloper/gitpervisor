import { GitCommitHorizontal } from "lucide-react";

import { errorMessage } from "../../lib/ipc";
import { shortDate } from "../../lib/format";
import { useLog } from "../../queries";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

/** 데코레이션 칩: HEAD/브랜치는 강조, tag는 별색, 그 외(리모트)는 흐리게. */
function RefChip({ label }: { label: string }) {
  const isHead = label.startsWith("HEAD");
  const isTag = label.startsWith("tag:");
  const text = isHead ? label.replace("HEAD -> ", "") : label.replace("tag: ", "");
  const cls = isHead
    ? "bg-accent/20 text-accent"
    : isTag
      ? "bg-mod/20 text-mod"
      : "bg-edge text-fg-dim";
  return (
    <span className={`shrink-0 rounded px-1 text-[10px] leading-4 ${cls}`}>
      {isTag ? "⌂ " : ""}
      {text}
    </span>
  );
}

/** Log 패널 중앙: 커밋 리스트 + 무한 스크롤(더 보기). */
export function CommitList({ projectId }: { projectId: string }) {
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useLog(projectId);
  const selectedCommitSha = useUi((s) => s.selectedCommitSha);
  const selectCommit = useUi((s) => s.selectCommit);

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-xs text-fg-dim">
        로그 불러오는 중…
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-w-0 flex-1">
        <EmptyState title="로그를 불러오지 못했습니다" desc={errorMessage(error)} />
      </div>
    );
  }

  const commits = data?.pages.flat() ?? [];
  if (commits.length === 0) {
    return (
      <div className="min-w-0 flex-1">
        <EmptyState
          icon={GitCommitHorizontal}
          title="아직 커밋이 없습니다"
          desc="이 브랜치에는 커밋 히스토리가 없습니다"
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      {commits.map((c) => {
        const selected = c.sha === selectedCommitSha;
        return (
          <div
            key={c.sha}
            onClick={() => selectCommit(c.sha)}
            className={`cursor-pointer border-b border-edge/40 px-3 py-1.5 ${
              selected ? "bg-selection" : "hover:bg-raised"
            }`}
          >
            <div className="flex items-center gap-1.5">
              {c.refs.map((r) => (
                <RefChip key={r} label={r} />
              ))}
              <span className="truncate text-[13px]">{c.subject}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-dim">
              <span className="shrink-0 font-mono">{c.sha.slice(0, 7)}</span>
              <span className="truncate">{c.authorName}</span>
              <span className="ml-auto shrink-0">{shortDate(c.authoredAt)}</span>
            </div>
          </div>
        );
      })}
      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full py-2 text-xs text-fg-muted hover:bg-raised disabled:opacity-50"
        >
          {isFetchingNextPage ? "불러오는 중…" : "더 보기"}
        </button>
      )}
    </div>
  );
}
