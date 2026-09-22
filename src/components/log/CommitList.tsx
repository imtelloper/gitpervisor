import { GitCommitHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { copyWithToast } from "../../lib/clipboard";
import { errorMessage } from "../../lib/ipc";
import { shortDate } from "../../lib/format";
import { useLog } from "../../queries";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

interface CommitMenu {
  x: number;
  y: number;
  sha: string;
  message: string; // 제목 + 본문(있으면) — 상세 패널의 "메시지 복사"와 동일
}

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

/** Log 패널 중앙: 커밋 리스트 + 무한 스크롤(더 보기).
 *  selectedSha·onSelectCommit을 주면 커밋 선택이 **호출자 로컬**이 된다(Git 모달, 태스크 55 —
 *  ChangesPanel의 onSelect·active와 같은 관례). 안 주면 전역 스토어로 하단 Log 패널과 통신한다. */
export function CommitList({
  projectId,
  selectedSha,
  onSelectCommit,
}: {
  projectId: string;
  selectedSha?: string | null;
  onSelectCommit?: (sha: string) => void;
}) {
  const msg = useMessages();
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useLog(projectId);
  const storeSha = useUi((s) => s.selectedCommitSha);
  const storeSelectCommit = useUi((s) => s.selectCommit);
  const selectedCommitSha = onSelectCommit ? (selectedSha ?? null) : storeSha;
  const selectCommit = onSelectCommit ?? storeSelectCommit;
  const [menu, setMenu] = useState<CommitMenu | null>(null);

  // 메뉴 열림 동안 바깥 클릭 / Esc 로 닫는다 (FileTreePanel과 동일 패턴).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-xs text-fg-dim">
        {msg.git.log.logLoading}
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-w-0 flex-1">
        <EmptyState title={msg.git.log.logLoadFailed} desc={errorMessage(error)} />
      </div>
    );
  }

  const commits = data?.pages.flat() ?? [];
  if (commits.length === 0) {
    return (
      <div className="min-w-0 flex-1">
        <EmptyState
          icon={GitCommitHorizontal}
          title={msg.git.log.noCommitsTitle}
          desc={msg.git.log.noCommitsDesc}
        />
      </div>
    );
  }

  return (
    <>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {commits.map((c) => {
        const selected = c.sha === selectedCommitSha;
        return (
          <div
            key={c.sha}
            onClick={() => selectCommit(c.sha)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                sha: c.sha,
                message: c.body ? `${c.subject}\n\n${c.body}` : c.subject,
              });
            }}
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
            {isFetchingNextPage ? msg.git.log.loadingMore : msg.git.log.loadMore}
          </button>
        )}
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 110),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <CommitMenuItem
            label={msg.git.log.copyMessage}
            onClick={() => {
              copyWithToast(menu.message, msg.git.log.commitMessageCopied);
              setMenu(null);
            }}
          />
          <CommitMenuItem
            label={msg.git.log.copyFullHash}
            onClick={() => {
              copyWithToast(menu.sha, msg.git.log.commitHashCopied);
              setMenu(null);
            }}
          />
          <CommitMenuItem
            label={msg.git.log.copyShortHash}
            onClick={() => {
              copyWithToast(menu.sha.slice(0, 7), msg.git.log.shortHashCopied);
              setMenu(null);
            }}
          />
        </div>
      )}
    </>
  );
}

function CommitMenuItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
    >
      {label}
    </button>
  );
}
