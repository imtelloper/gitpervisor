import { Copy } from "lucide-react";

import { fmtDateTime } from "../../i18n/format-locale";
import { useMessages } from "../../i18n/ui-language";
import { KIND_BADGE } from "../../lib/change-kind";
import { copyWithToast } from "../../lib/clipboard";
import { splitPath } from "../../lib/format";
import { errorMessage } from "../../lib/ipc";
import type { DiffTarget } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import { useCommitDetail } from "../../queries";
import { selectActiveDiff, useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";

/** Log 패널 우측: 선택 커밋의 전체 메시지 + 변경 파일 트리. 파일 클릭 → 중앙 뷰어에 커밋 diff.
 *  onSelect·active를 주면 그 클릭이 호출자 로컬 선택이 된다(Git 모달, 태스크 55 — ChangesPanel과 동일).
 *  selectedSha를 주면 커밋 선택도 호출자 로컬이다 — 전역 selectedCommitSha를 쓰면 모달(프로젝트 B)과
 *  하단 Log 패널(프로젝트 A)이 서로의 선택을 덮어써 남의 저장소 sha를 조회하게 된다. */
export function CommitDetailPane({
  projectId,
  onSelect,
  active,
  selectedSha,
}: {
  projectId: string;
  onSelect?: (target: DiffTarget, repoId: string) => void;
  active?: { target: DiffTarget; repoId: string } | null;
  selectedSha?: string | null;
}) {
  const msg = useMessages();
  const storeSha = useUi((s) => s.selectedCommitSha);
  const sha = selectedSha !== undefined ? selectedSha : storeSha;
  const activeDiff = useUi(selectActiveDiff);
  const selectDiff = useUi((s) => s.selectDiff);
  const { data, isLoading, error } = useCommitDetail(projectId, sha);
  const { width, startResize } = usePanelWidth(
    "gp:commit-detail-width",
    320,
    200,
    600,
    "left",
  );

  if (!sha) {
    return (
      <Shell width={width} startResize={startResize}>
        <div className="flex h-full items-center justify-center p-3 text-xs text-fg-dim">
          {msg.git.log.selectCommit}
        </div>
      </Shell>
    );
  }
  // 실패를 안 그리면(예: 다른 저장소의 sha) 로딩도 데이터도 아닌 상태라 "커밋 상세 …"에 영영 멈춘다.
  if (error) {
    return (
      <Shell width={width} startResize={startResize}>
        <div className="p-3 text-xs leading-5 text-fg-dim">
          {msg.git.log.commitLoadFailed(errorMessage(error))}
        </div>
      </Shell>
    );
  }
  if (isLoading || !data) {
    return (
      <Shell width={width} startResize={startResize}>
        <div className="flex h-full items-center justify-center p-3 text-xs text-fg-dim">
          {msg.git.log.commitDetailLoading}
        </div>
      </Shell>
    );
  }

  const { commit, files } = data;
  const fullMessage = commit.body
    ? `${commit.subject}\n\n${commit.body}`
    : commit.subject;
  return (
    <Shell width={width} startResize={startResize}>
      {/* 커밋 메시지·메타는 드래그 선택 가능(select-text). 버튼은 select-none. */}
      <div className="select-text border-b border-edge p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 cursor-text text-[13px] font-medium leading-snug">
            {commit.subject}
          </div>
          <button
            onClick={() => copyWithToast(fullMessage, msg.git.log.commitMessageCopied)}
            title={msg.git.log.copyCommitMessageTitle}
            className="shrink-0 select-none rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <Copy size={13} />
          </button>
        </div>
        {commit.body && (
          <pre className="mt-1.5 cursor-text whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-fg-muted">
            {commit.body}
          </pre>
        )}
        <div className="mt-2 space-y-0.5 text-[11px] text-fg-dim">
          <div className="truncate">
            {commit.authorName} &lt;{commit.authorEmail}&gt;
          </div>
          <button
            onClick={() => copyWithToast(commit.sha, msg.git.log.commitHashCopied)}
            title={msg.git.log.copyFullHash}
            className="flex select-none items-center gap-1 font-mono hover:text-fg"
          >
            <span>{commit.sha.slice(0, 12)}</span>
            <Copy size={11} className="opacity-60" />
          </button>
          <div>{fmtDateTime(new Date(commit.authoredAt))}</div>
        </div>
      </div>

      <div className="p-1">
        <div className="px-2 py-1 text-[11px] font-semibold text-fg-muted">
          {msg.git.log.changedFiles(files.length)}
        </div>
        {files.map((f) => {
          const badge = KIND_BADGE[f.kind];
          const { dir, base } = splitPath(f.path);
          // onSelect가 오면 강조도 전역이 아닌 로컬 active를 본다.
          const shown = onSelect ? active?.target : activeDiff?.target;
          const selected =
            shown?.mode === "commit" &&
            shown.sha === commit.sha &&
            shown.path === f.path;
          return (
            <div
              key={f.path}
              onClick={() =>
                (onSelect ?? selectDiff)(
                  { mode: "commit", sha: commit.sha, path: f.path },
                  projectId,
                )
              }
              title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
              className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-xs ${
                selected ? "bg-selection" : "hover:bg-raised"
              }`}
            >
              <span
                className={`w-3 shrink-0 text-center font-mono ${badge.className}`}
              >
                {badge.letter}
              </span>
              <span className="truncate">{base}</span>
              {dir && (
                <span className="min-w-0 truncate text-fg-dim">{dir}</span>
              )}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Shell({
  width,
  startResize,
  children,
}: {
  width: number;
  startResize: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ width }} className="relative shrink-0 border-l border-edge">
      <div className="h-full overflow-y-auto">{children}</div>
      <ResizeHandle onMouseDown={startResize} side="left" />
    </div>
  );
}
