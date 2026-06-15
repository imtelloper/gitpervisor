import { KIND_BADGE } from "../../lib/change-kind";
import { splitPath } from "../../lib/format";
import { useCommitDetail } from "../../queries";
import { useUi } from "../../stores/ui";

/** Log 패널 우측: 선택 커밋의 전체 메시지 + 변경 파일 트리. 파일 클릭 → 중앙 뷰어에 커밋 diff. */
export function CommitDetailPane({ projectId }: { projectId: string }) {
  const sha = useUi((s) => s.selectedCommitSha);
  const selectedDiff = useUi((s) => s.selectedDiff);
  const selectDiff = useUi((s) => s.selectDiff);
  const { data, isLoading } = useCommitDetail(projectId, sha);

  if (!sha) {
    return (
      <div className="flex w-80 shrink-0 items-center justify-center border-l border-edge p-3 text-xs text-fg-dim">
        커밋을 선택하세요
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="flex w-80 shrink-0 items-center justify-center border-l border-edge p-3 text-xs text-fg-dim">
        커밋 상세 …
      </div>
    );
  }

  const { commit, files } = data;
  return (
    <div className="w-80 shrink-0 overflow-y-auto border-l border-edge">
      <div className="border-b border-edge p-3">
        <div className="text-[13px] font-medium leading-snug">
          {commit.subject}
        </div>
        {commit.body && (
          <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-fg-muted">
            {commit.body}
          </pre>
        )}
        <div className="mt-2 space-y-0.5 text-[11px] text-fg-dim">
          <div className="truncate">
            {commit.authorName} &lt;{commit.authorEmail}&gt;
          </div>
          <div className="font-mono">{commit.sha.slice(0, 12)}</div>
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
    </div>
  );
}
