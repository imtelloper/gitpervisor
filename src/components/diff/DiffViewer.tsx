import { monaco } from "./monaco-setup";
import { registerGotoDefinition, setDefContext } from "./goto-definition";

import { DiffEditor, Editor } from "@monaco-editor/react";
import type { DiffOnMount, OnMount } from "@monaco-editor/react";
import {
  Code2,
  Eye,
  FileQuestion,
  FileWarning,
  FoldVertical,
  Pencil,
  Save,
  UnfoldVertical,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../../lib/ipc";
import type { DiffTarget } from "../../lib/ipc";
import { languageOf } from "../../lib/language-map";
import { useDiff, useSettings, useWriteFile } from "../../queries";
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

/** 단일 파일 보기(트리 클릭)용 — diff 전용 옵션 제외. 편집 가능(readOnly는 동적). */
const FILE_OPTIONS = {
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
  const selectDiff = useUi((s) => s.selectDiff);
  const pushToast = useUi((s) => s.pushToast);

  const options = useMemo(
    () => ({
      ...DIFF_OPTIONS,
      fontSize: settings?.diffFontSize ?? 13,
      hideUnchangedRegions: { enabled: collapseUnchanged },
    }),
    [settings?.diffFontSize, collapseUnchanged],
  );
  const isFileView = target.mode === "file";
  const isMarkdown = isFileView && languageOf(target.path) === "markdown";
  // 파일뷰만 직접 편집한다. diff뷰(worktree/index)는 "편집" 버튼으로 파일뷰 전환.
  const editable = isFileView;
  const fileOptions = useMemo(
    () => ({ ...FILE_OPTIONS, readOnly: !editable, fontSize: settings?.diffFontSize ?? 13 }),
    [settings?.diffFontSize, editable],
  );

  const path = target.path;
  const editorKey =
    target.mode === "commit"
      ? `commit:${target.sha}:${path}`
      : `${target.mode}:${path}`;

  // go-to-def로 줄 지정해 열린 경우 그 줄로 스크롤(파일뷰만). editorKey엔 line을 안 넣어
  // 같은 파일 내 줄 이동은 재마운트 없이 effect로 처리한다.
  const targetLine = target.mode === "file" ? target.line : undefined;
  const targetLineRef = useRef<number | undefined>(undefined);
  targetLineRef.current = targetLine;

  // Go-to-Definition provider 1회 등록 + 현재 파일 컨텍스트(검색 프로젝트·언어) 갱신.
  useEffect(() => {
    registerGotoDefinition();
  }, []);
  useEffect(() => {
    setDefContext(projectId, path.split(".").pop() ?? "");
  }, [projectId, path]);

  // ── 편집/저장 상태 ──
  const writeFile = useWriteFile(projectId);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const baselineRef = useRef<string>(""); // 로드(또는 저장) 시 내용 — 변경 판정 기준
  const saveRef = useRef<() => void>(() => {});

  // 저장 — 에디터 현재 내용을 디스크에 쓴다. addCommand 클로저가 최신 값을 보도록 ref로.
  saveRef.current = () => {
    const ed = editorRef.current;
    if (!editable || !ed || writeFile.isPending) return;
    const content = ed.getValue();
    if (content === baselineRef.current) return; // 변경 없음
    void writeFile
      .mutateAsync({ path, content })
      .then(() => {
        baselineRef.current = content;
        setDirty(false);
        pushToast("success", "저장됨");
      })
      .catch(() => {
        /* useWriteFile onError가 토스트 처리 */
      });
  };

  // 파일 전환 시 dirty 해제(새 에디터 mount가 baseline을 다시 잡는다).
  useEffect(() => setDirty(false), [editorKey]);

  const onFileMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    // 파일뷰 에디터는 항상 편집 가능 — options.readOnly가 마운트 시 안 먹는 경우가 있어
    // 에디터 API로 명시 적용한다(편집 보장).
    editor.updateOptions({ readOnly: false });
    baselineRef.current = editor.getValue();
    setDirty(false);
    editor.onDidChangeModelContent(() =>
      setDirty(editor.getValue() !== baselineRef.current),
    );
    // Ctrl+S / Cmd+S 저장 (Monaco 내부에서 가로채 브라우저 저장 다이얼로그 방지).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    // go-to-def로 줄 지정해 열렸으면 해당 줄로 스크롤(마운트 시점 1회).
    const ln = targetLineRef.current;
    if (ln && ln > 0) {
      editor.revealLineInCenter(ln);
      editor.setPosition({ lineNumber: ln, column: 1 });
    }
  }, []);

  // 같은 파일 내에서 line만 바뀌면(에디터 미재마운트) 그 줄로 이동.
  useEffect(() => {
    if (targetLine && targetLine > 0 && editorRef.current) {
      editorRef.current.revealLineInCenter(targetLine);
      editorRef.current.setPosition({ lineNumber: targetLine, column: 1 });
    }
  }, [targetLine, editorKey]);

  // Monaco 테마는 전역 — 열려 있는 에디터도 즉시 바뀌도록 명시적으로 적용한다.
  useEffect(() => {
    monaco.editor.setTheme(monacoTheme);
  }, [monacoTheme]);

  // onMount 콜백(1회 등록)에서 최신 토글 값을 참조하기 위한 ref
  const collapseRef = useRef(collapseUnchanged);
  collapseRef.current = collapseUnchanged;

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

  // diff뷰에서 워킹 파일을 편집 가능한 파일뷰로 여는 버튼 표시 여부.
  const canEditFromDiff = target.mode === "worktree" || target.mode === "index";

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
        {editable && (
          <button
            onClick={() => saveRef.current()}
            disabled={!dirty || writeFile.isPending}
            title="저장 (Ctrl+S)"
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs ${
              dirty
                ? "bg-accent/20 text-accent hover:bg-accent/30"
                : "text-fg-dim"
            } disabled:opacity-50`}
          >
            <Save size={13} />
            {writeFile.isPending ? "저장 중…" : dirty ? "저장 *" : "저장됨"}
          </button>
        )}
        {canEditFromDiff && (
          <button
            onClick={() => selectDiff({ mode: "file", path })}
            title="이 파일을 편집 가능한 뷰로 열기"
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-fg-dim hover:bg-raised hover:text-fg"
          >
            <Pencil size={13} />
            편집
          </button>
        )}
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
            key={editorKey}
            defaultValue={diff.newContent ?? ""}
            language={languageOf(path)}
            theme={monacoTheme}
            options={fileOptions}
            onMount={onFileMount}
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
