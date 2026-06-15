import "./monaco-setup";

import { DiffEditor } from "@monaco-editor/react";
import { FileQuestion, FileWarning } from "lucide-react";

import { errorMessage } from "../../lib/ipc";
import { languageOf } from "../../lib/language-map";
import { useDiff } from "../../queries";
import { EmptyState } from "../common/EmptyState";

const DIFF_OPTIONS = {
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  automaticLayout: true,
  hideUnchangedRegions: { enabled: true },
  ignoreTrimWhitespace: false,
  minimap: { enabled: false },
  renderOverviewRuler: false,
  scrollBeyondLastLine: false,
  fontSize: 13,
  fontFamily: '"Cascadia Code", Consolas, "D2Coding", monospace',
  lineNumbersMinChars: 4,
  padding: { top: 8 },
} as const;

export default function DiffViewer({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const {
    data: diff,
    isLoading,
    isPlaceholderData,
    error,
  } = useDiff(projectId, path);

  const stateBadge = diff
    ? diff.oldContent === null && diff.newContent !== null
      ? { text: "추가됨", className: "text-add" }
      : diff.newContent === null && diff.oldContent !== null
        ? { text: "삭제됨", className: "text-del" }
        : null
    : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-base">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="truncate font-mono text-xs text-fg-muted">{path}</span>
        {stateBadge && (
          <span className={`shrink-0 text-xs ${stateBadge.className}`}>
            {stateBadge.text}
          </span>
        )}
        <div className="flex-1" />
        <span className="shrink-0 text-[11px] text-fg-dim">
          인덱스 ↔ 워킹 트리
        </span>
      </div>

      <div
        className={`min-h-0 flex-1 ${isPlaceholderData ? "opacity-50 transition-opacity" : ""}`}
      >
        {isLoading ? (
          <EmptyState title="diff 불러오는 중…" />
        ) : error ? (
          <EmptyState
            icon={FileWarning}
            title="diff를 불러오지 못했습니다"
            desc={errorMessage(error)}
          />
        ) : diff?.isBinary ? (
          <EmptyState
            icon={FileQuestion}
            title="바이너리 파일"
            desc="텍스트 diff를 표시할 수 없습니다"
          />
        ) : diff?.tooLarge ? (
          <EmptyState
            icon={FileWarning}
            title="파일이 너무 큽니다"
            desc="1.5MB를 초과하는 파일은 표시하지 않습니다"
          />
        ) : diff ? (
          <DiffEditor
            original={diff.oldContent ?? ""}
            modified={diff.newContent ?? ""}
            language={languageOf(path)}
            theme="gitpervisor-dark"
            options={DIFF_OPTIONS}
            loading={
              <span className="text-xs text-fg-dim">에디터 로딩 중…</span>
            }
          />
        ) : null}
      </div>
    </div>
  );
}
