import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy } from "lucide-react";

import { KIND_BADGE } from "../../lib/change-kind";
import { splitPath } from "../../lib/format";
import { usePanelWidth } from "../../lib/use-panel-width";
import { useCommitDetail } from "../../queries";
import { useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";

/** 클립보드 복사 + 토스트 (커밋 메시지·해시). */
function copyText(text: string, ok: string) {
  const pushToast = useUi.getState().pushToast;
  void writeText(text)
    .then(() => pushToast("success", ok))
    .catch(() => pushToast("error", "복사에 실패했습니다"));
}

/** Log 패널 우측: 선택 커밋의 전체 메시지 + 변경 파일 트리. 파일 클릭 → 중앙 뷰어에 커밋 diff. */
export function CommitDetailPane({ projectId }: { projectId: string }) {
  const sha = useUi((s) => s.selectedCommitSha);
  const selectedDiff = useUi((s) => s.selectedDiff);
  const selectDiff = useUi((s) => s.selectDiff);
  const { data, isLoading } = useCommitDetail(projectId, sha);
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
          커밋을 선택하세요
        </div>
      </Shell>
    );
  }
  if (isLoading || !data) {
    return (
      <Shell width={width} startResize={startResize}>
        <div className="flex h-full items-center justify-center p-3 text-xs text-fg-dim">
          커밋 상세 …
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
            onClick={() => copyText(fullMessage, "커밋 메시지를 복사했습니다")}
            title="커밋 메시지 복사"
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
            onClick={() => copyText(commit.sha, "커밋 해시를 복사했습니다")}
            title="전체 해시 복사"
            className="flex select-none items-center gap-1 font-mono hover:text-fg"
          >
            <span>{commit.sha.slice(0, 12)}</span>
            <Copy size={11} className="opacity-60" />
          </button>
          <div>{new Date(commit.authoredAt).toLocaleString()}</div>
        </div>
      </div>

      <div className="p-1">
        <div className="px-2 py-1 text-[11px] font-semibold text-fg-muted">
          변경 파일 {files.length}
        </div>
        {files.map((f) => {
          const badge = KIND_BADGE[f.kind];
          const { dir, base } = splitPath(f.path);
          const selected =
            selectedDiff?.mode === "commit" &&
            selectedDiff.sha === commit.sha &&
            selectedDiff.path === f.path;
          return (
            <div
              key={f.path}
              onClick={() =>
                selectDiff({ mode: "commit", sha: commit.sha, path: f.path })
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
