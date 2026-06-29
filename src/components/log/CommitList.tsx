import { GitCommitHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

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

function copyText(text: string, ok: string) {
  const pushToast = useUi.getState().pushToast;
  void navigator.clipboard
    .writeText(text)
    .then(() => pushToast("success", ok))
    .catch(() => pushToast("error", "복사에 실패했습니다"));
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
            {isFetchingNextPage ? "불러오는 중…" : "더 보기"}
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
            label="메시지 복사"
            onClick={() => {
              copyText(menu.message, "커밋 메시지를 복사했습니다");
              setMenu(null);
            }}
          />
          <CommitMenuItem
            label="전체 해시 복사"
            onClick={() => {
              copyText(menu.sha, "커밋 해시를 복사했습니다");
              setMenu(null);
            }}
          />
          <CommitMenuItem
            label="짧은 해시 복사"
            onClick={() => {
              copyText(menu.sha.slice(0, 7), "짧은 해시를 복사했습니다");
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
