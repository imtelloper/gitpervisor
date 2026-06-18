import { monaco } from "./monaco-setup";

import { DiffEditor, Editor } from "@monaco-editor/react";
import type { DiffOnMount } from "@monaco-editor/react";
import {
  Code2,
  Eye,
  FileQuestion,
  FileWarning,
  FoldVertical,
  UnfoldVertical,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../../lib/ipc";
import type { DiffTarget } from "../../lib/ipc";
import { languageOf } from "../../lib/language-map";
import { useDiff, useSettings } from "../../queries";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import MarkdownView from "./MarkdownView";

function monacoThemeOf(theme: string | undefined): string {
  return theme === "monokai" ? "gitpervisor-monokai" : "gitpervisor-dark";
}

function modeLabel(target: DiffTarget): string {
  switch (target.mode) {
    case "worktree":
      return "인덱스 ↔ 워킹 트리";
    case "index":
      return "HEAD ↔ 인덱스 (staged)";
    case "commit":
      return `부모 ↔ 커밋 ${target.sha.slice(0, 7)}`;
    case "file":
      return "파일";
  }
}

/** 단일 파일 보기(트리 클릭)용 — diff 전용 옵션 제외. */
const FILE_OPTIONS = {
  readOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  renderOverviewRuler: false,
  scrollBeyondLastLine: false,
  fontSize: 13,
  fontFamily: '"Cascadia Code", Consolas, "D2Coding", monospace',
  lineNumbersMinChars: 4,
  padding: { top: 8 },
} as const;

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
  target,
}: {
  projectId: string;
  target: DiffTarget;
}) {
  const { data: diff, isLoading, error } = useDiff(projectId, target);
  const { data: settings } = useSettings();
  const monacoTheme = monacoThemeOf(settings?.theme);
  const collapseUnchanged = useUi((s) => s.diffCollapseUnchanged);
  const toggleDiffCollapse = useUi((s) => s.toggleDiffCollapse);

  const options = useMemo(
    () => ({
      ...DIFF_OPTIONS,
      fontSize: settings?.diffFontSize ?? 13,
      hideUnchangedRegions: { enabled: collapseUnchanged },
    }),
    [settings?.diffFontSize, collapseUnchanged],
  );
  const fileOptions = useMemo(
    () => ({ ...FILE_OPTIONS, fontSize: settings?.diffFontSize ?? 13 }),
    [settings?.diffFontSize],
  );
  const isFileView = target.mode === "file";
  const isMarkdown = isFileView && languageOf(target.path) === "markdown";

  // Monaco 테마는 전역 — 열려 있는 에디터도 즉시 바뀌도록 명시적으로 적용한다.
  useEffect(() => {
    monaco.editor.setTheme(monacoTheme);
  }, [monacoTheme]);

  // onMount 콜백(1회 등록)에서 최신 토글 값을 참조하기 위한 ref
  const collapseRef = useRef(collapseUnchanged);
  collapseRef.current = collapseUnchanged;

  const path = target.path;
  const editorKey =
    target.mode === "commit"
      ? `commit:${target.sha}:${path}`
      : `${target.mode}:${path}`;

  // .md 파일은 기본 미리보기(렌더). 파일이 바뀌면 다시 미리보기로 돌아간다.
  const [mdRaw, setMdRaw] = useState(false);
  useEffect(() => setMdRaw(false), [editorKey]);

  // 파일 전환 시 "펼쳐진 채 잠깐 보였다가 접히는" 깜빡임을 없앤다:
  // 대상이 바뀌면 에디터를 숨기고(opacity-0), 접기가 적용된 뒤 다시 보여준다.
  const [pendingCollapse, setPendingCollapse] = useState(false);
  useEffect(() => {
    setPendingCollapse(true);
    // 안전 폴백 — onDidUpdateDiff가 오지 않는 경우에도 일정 시간 뒤 노출
    const t = window.setTimeout(() => setPendingCollapse(false), 500);
    return () => window.clearTimeout(t);
  }, [editorKey]);

  // Monaco 버그 우회: 모델만 교체되는 파일 전환에서는 hideUnchangedRegions 접기가
  // 재계산되지 않아 전체가 펼쳐진 채 나온다(옵션 값이 그대로라 변화 없음으로 간주).
  // 같은 값 재설정은 no-op이므로, diff 계산 완료(onDidUpdateDiff) 시점에 반대값으로
  // 한 번 뒤집었다 되돌려 강제로 재계산시킨다(동기 호출이라 그 자체로 깜빡임 없음).
  // 접기가 적용된 직후 에디터를 다시 노출해 펼쳐진 중간 프레임이 보이지 않게 한다.
  const handleMount: DiffOnMount = useCallback((editor) => {
    editor.onDidUpdateDiff(() => {
      const want = collapseRef.current;
      editor.updateOptions({ hideUnchangedRegions: { enabled: !want } });
      editor.updateOptions({ hideUnchangedRegions: { enabled: want } });
      requestAnimationFrame(() => setPendingCollapse(false));
    });
  }, []);

  const stateBadge =
    !isFileView && diff
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
        {isMarkdown && (
          <button
            onClick={() => setMdRaw((v) => !v)}
            title={mdRaw ? "미리보기 (렌더된 마크다운)" : "원본 보기 (마크다운 소스)"}
            className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            {mdRaw ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
        )}
        {!isFileView && (
          <button
            onClick={toggleDiffCollapse}
            title={
              collapseUnchanged
                ? "전체 펼치기 (변경 없는 영역까지 표시)"
                : "변경 없는 영역 접기"
            }
            className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            {collapseUnchanged ? (
              <UnfoldVertical size={14} />
            ) : (
              <FoldVertical size={14} />
            )}
          </button>
        )}
        <span className="shrink-0 text-[11px] text-fg-dim">
          {modeLabel(target)}
        </span>
      </div>

      <div className="min-h-0 flex-1">
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
        ) : diff && isMarkdown && !mdRaw ? (
          <MarkdownView content={diff.newContent ?? ""} />
        ) : diff && isFileView ? (
          <Editor
            value={diff.newContent ?? ""}
            language={languageOf(path)}
            theme={monacoTheme}
            options={fileOptions}
            loading={
              <span className="text-xs text-fg-dim">에디터 로딩 중…</span>
            }
          />
        ) : diff ? (
          <div
            className={`h-full ${pendingCollapse ? "opacity-0" : "opacity-100"}`}
          >
            <DiffEditor
              original={diff.oldContent ?? ""}
              modified={diff.newContent ?? ""}
              language={languageOf(path)}
              theme={monacoTheme}
              options={options}
              onMount={handleMount}
              loading={
                <span className="text-xs text-fg-dim">에디터 로딩 중…</span>
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
