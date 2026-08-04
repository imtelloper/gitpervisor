import { monaco } from "./monaco-setup";
import {
  registerGotoDefinition,
  setDefContext,
  warmDefinitionCache,
} from "./goto-definition";
import { registerFindReferences } from "./find-references";
import { registerFormatProviders, setFormatContext } from "./format-provider";
import { clearLintMarkers, refreshLintMarkers } from "./lint-markers";
import { registerPythonOutline } from "./python-outline";

import { extToLang } from "../../lib/lsp/client";
import { registerLspProviders } from "../../lib/lsp/providers";
import { lspChangeDoc, lspCloseDoc, lspOpenDoc, lspSaveDoc } from "../../lib/lsp/sync";

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
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../../lib/ipc";
import type { DiffTarget } from "../../lib/ipc";
import { isMod } from "../../lib/platform";
import { isImage, languageOf } from "../../lib/language-map";
import { monacoThemeOf } from "../../lib/themes";
import { useDiff, useSettings, useWriteFile } from "../../queries";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import ImageView from "./ImageView";
import MarkdownView from "./MarkdownView";

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

// ── 미저장 편집 초안 ──
//
// 편집 내용을 담고 있는 곳은 Monaco 모델 하나뿐이고, <Editor>의 key가 바뀌면(파일 전환·프로젝트
// 전환·커밋 뷰 전환) 모델이 dispose되면서 통째로 사라진다. 저장 전이면 git에도 없어 복구 수단이
// 0이다. 커밋 메시지는 CommitForm이 이미 같은 이유로 초안을 남기고 있는데(gp:commit-draft:*)
// 파일 편집만 빠져 있었다. 앱이 어떤 식으로 죽든(패닉·강제 종료·전원 차단) 살아남게 한다.
const fileDraftKey = (editorKey: string) => `gp:file-draft:${editorKey}`;

function loadFileDraft(editorKey: string): string | null {
  try {
    return localStorage.getItem(fileDraftKey(editorKey));
  } catch {
    return null;
  }
}

/** 디스크 내용(baseline)과 같아지면 지운다 — 되돌린 편집이 초안으로 남지 않게. */
function saveFileDraft(editorKey: string, content: string, baseline: string) {
  try {
    if (content === baseline) localStorage.removeItem(fileDraftKey(editorKey));
    else localStorage.setItem(fileDraftKey(editorKey), content);
  } catch {
    // 초안은 편의 기능이라 저장 실패(용량 초과 등)는 조용히 무시한다 — CommitForm과 동일.
  }
}

function clearFileDraft(editorKey: string) {
  try {
    localStorage.removeItem(fileDraftKey(editorKey));
  } catch {
    /* 위와 동일 */
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
  hover: { delay: 150 }, // 기본 300ms — 시그니처 툴팁 반응을 반 박자 빠르게
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
  hover: { delay: 150 },
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
  // 이미지 파일은 모드와 무관하게 워크트리 파일을 이미지로 렌더(텍스트 diff 대신).
  const isImageView = isImage(target.path);
  const isMarkdown =
    isFileView && !isImageView && languageOf(target.path) === "markdown";
  // 파일뷰만 직접 편집한다. diff뷰(worktree/index)는 "편집" 버튼으로 파일뷰 전환. 이미지는 편집 불가.
  const editable = isFileView && !isImageView;
  const fileOptions = useMemo(
    () => ({ ...FILE_OPTIONS, readOnly: !editable, fontSize: settings?.diffFontSize ?? 13 }),
    [settings?.diffFontSize, editable],
  );

  const path = target.path;
  // 포맷 지원 언어(ruff/biome) — 파일뷰에서만. 포맷 버튼·저장 시 포맷 게이트.
  const canFormat =
    editable &&
    ["py", "pyi", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css"].includes(
      path.split(".").pop() ?? "",
    );
  // LSP 옵트인 — 이 프로젝트가 활성 목록에 있고 지원 언어일 때만 서버 기동(태스크 17 §3.4).
  const lspOn =
    editable &&
    (settings?.lspEnabledProjects ?? []).includes(projectId) &&
    extToLang(path.split(".").pop() ?? "") != null;
  // projectId 포함 — 프로젝트가 달라도 상대경로가 같으면(예: 둘 다 src/App.tsx) 키가 겹쳐
  // 리마운트가 안 되고 이전 프로젝트의 내용·편집 상태가 그대로 남는 사고를 막는다.
  const editorKey =
    target.mode === "commit"
      ? `${projectId}:commit:${target.sha}:${path}`
      : `${projectId}:${target.mode}:${path}`;

  // go-to-def로 줄 지정해 열린 경우 그 줄로 스크롤(파일뷰만). editorKey엔 line을 안 넣어
  // 같은 파일 내 줄 이동은 재마운트 없이 effect로 처리한다.
  const targetLine = target.mode === "file" ? target.line : undefined;
  const targetColumn = target.mode === "file" ? target.column : undefined;
  const targetLineRef = useRef<number | undefined>(undefined);
  targetLineRef.current = targetLine;
  const targetColRef = useRef<number | undefined>(undefined);
  targetColRef.current = targetColumn;

  // 점프 도착 표시 — 줄로 스크롤하고 커서를 심볼 위에 놓는다(단어 전체 선택 + 포커스).
  // 열 정보가 없거나 단어가 아니면 커서만 그 위치로.
  const revealTarget = useCallback((editor: Parameters<OnMount>[0]) => {
    const ln = targetLineRef.current;
    if (!ln || ln <= 0) return;
    const col = targetColRef.current ?? 1;
    editor.revealPositionInCenter({ lineNumber: ln, column: col });
    const word = editor.getModel()?.getWordAtPosition({ lineNumber: ln, column: col });
    if (word) {
      editor.setSelection(new monaco.Range(ln, word.startColumn, ln, word.endColumn));
    } else {
      editor.setPosition({ lineNumber: ln, column: col });
    }
    editor.focus();
  }, []);

  // Go-to-Definition + 파이썬 아웃라인 provider 1회 등록 + 현재 파일 컨텍스트 갱신.
  useEffect(() => {
    registerGotoDefinition();
    registerPythonOutline();
    registerFindReferences();
    registerFormatProviders();
    registerLspProviders();
  }, []);

  // mod+Shift+O 구조 팝업 비포커스 폴백 — 뷰어는 보이지만 에디터에 포커스가 없을 때(파일트리
  // 클릭 직후 등) 구조 팝업을 연다. 에디터 포커스 중엔 Monaco 내장 바인딩이 처리하므로 통과.
  // (monaco를 KeyboardShortcuts에 import하면 콜드스타트 번들이 무거워지므로 여기에 둔다.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "o") return;
      const ed = editorRef.current;
      if (!ed || ed.hasTextFocus()) return; // 포커스 중이면 내장 바인딩에 맡김
      e.preventDefault();
      ed.focus();
      void ed.getAction("editor.action.quickOutline")?.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    setDefContext(projectId, path.split(".").pop() ?? "");
    setFormatContext(projectId, path);
  }, [projectId, path]);
  // 파일 내용이 로드되면 import 심볼 정의를 백그라운드로 예열 — Ctrl+호버 첫 반응 가속.
  // setDefContext 효과 뒤에 선언돼 컨텍스트가 잡힌 상태에서 돈다. 캐시가 중복을 걸러낸다.
  const warmedKeyRef = useRef("");
  useEffect(() => {
    const content = diff?.newContent;
    if (!content || isImageView || warmedKeyRef.current === editorKey) return;
    warmedKeyRef.current = editorKey;
    warmDefinitionCache(content);
  }, [diff, editorKey, isImageView]);

  // ── 편집/저장 상태 ──
  const writeFile = useWriteFile(projectId);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const baselineRef = useRef<string>(""); // 로드(또는 저장) 시 내용 — 변경 판정 기준
  const saveRef = useRef<() => void>(() => {});
  // 미저장 편집 초안 저장기. onFileMount는 1회 등록 useCallback이라 stale 클로저이므로,
  // 이 파일의 lintRef/lspChangeRef와 같은 "매 렌더 갱신 ref" 패턴으로 최신 editorKey를 본다.
  const [recoveredDraft, setRecoveredDraft] = useState(false);
  const editorKeyRef = useRef(editorKey);
  editorKeyRef.current = editorKey;
  const draftTimerRef = useRef<number | undefined>(undefined);
  const draftSaveRef = useRef<() => void>(() => {});
  draftSaveRef.current = () => {
    const ed = editorRef.current;
    if (!editable || !ed) return;
    // 키·내용·기준을 **예약 시점에** 캡처한다. 타이머가 도는 300ms 사이에 파일이 바뀌면
    // editorRef.current는 이미 새 파일의 에디터라, 발화 시점에 읽으면 새 파일 내용을
    // 옛 파일 키로 쓰게 된다.
    const key = editorKeyRef.current;
    const value = ed.getValue();
    const baseline = baselineRef.current;
    window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(
      () => saveFileDraft(key, value, baseline),
      300,
    );
  };
  // 린트 재실행 — 매 렌더 갱신(saveRef 미러)이라 projectId/path가 항상 최신. 파일뷰만.
  const lintTimerRef = useRef<number | undefined>(undefined);
  const lintRef = useRef<(debounce?: boolean) => void>(() => {});
  lintRef.current = (debounce = false) => {
    const model = editorRef.current?.getModel();
    if (!isFileView || !model) return;
    window.clearTimeout(lintTimerRef.current);
    // 버퍼 내용을 넘긴다 — ruff는 저장 전 편집 중 코드를 실시간 린트(구문 오류 즉시 밑줄).
    const go = () => void refreshLintMarkers(model, projectId, path, model.getValue());
    if (debounce) lintTimerRef.current = window.setTimeout(go, 500);
    else go();
  };
  // LSP 문서 동기화 — 현재 바인딩된 모델 추적(파일 전환 시 didClose 대상) + didChange 디바운스.
  // onFileMount는 stale 클로저라 lintRef처럼 매 렌더 갱신 ref로 최신 lspOn/projectId/path를 본다.
  const lspModelRef = useRef<Parameters<typeof lspOpenDoc>[3] | null>(null);
  const lspChangeTimerRef = useRef<number | undefined>(undefined);
  const lspOpenRef = useRef<() => void>(() => {});
  lspOpenRef.current = () => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    // 파일 전환: 이전 바인딩 닫기(didClose + 마커 정리).
    if (lspModelRef.current && lspModelRef.current !== model) {
      lspCloseDoc(lspModelRef.current);
      lspModelRef.current = null;
    }
    if (lspOn) {
      lspModelRef.current = model;
      void lspOpenDoc(projectId, path.split(".").pop() ?? "", path, model);
    }
  };
  const lspChangeRef = useRef<() => void>(() => {});
  lspChangeRef.current = () => {
    if (!lspOn) return;
    const model = editorRef.current?.getModel();
    if (!model) return;
    window.clearTimeout(lspChangeTimerRef.current);
    lspChangeTimerRef.current = window.setTimeout(() => lspChangeDoc(model), 250);
  };

  // 저장 — 에디터 현재 내용을 디스크에 쓴다. addCommand 클로저가 최신 값을 보도록 ref로.
  saveRef.current = () => {
    const ed = editorRef.current;
    if (!editable || !ed || writeFile.isPending) return;
    void (async () => {
      // 저장 시 자동 포맷(옵트인) — 포맷 실패(미설치·구문 오류)여도 저장은 진행.
      if (settings?.formatOnSave && canFormat) {
        try {
          await ed.getAction("editor.action.formatDocument")?.run();
        } catch {
          /* 포맷 실패는 무시 — 저장을 인질로 잡지 않는다 */
        }
      }
      const content = ed.getValue();
      if (content === baselineRef.current) return; // 변경 없음
      try {
        await writeFile.mutateAsync({ path, content });
        baselineRef.current = content;
        setDirty(false);
        // 디스크에 반영됐으니 초안은 역할이 끝났다(대기 중 디바운스도 함께 취소).
        window.clearTimeout(draftTimerRef.current);
        clearFileDraft(editorKeyRef.current);
        setRecoveredDraft(false);
        pushToast("success", "저장됨");
        lintRef.current(true); // 저장 후 린트 재실행(500ms 디바운스)
        const savedModel = ed.getModel();
        if (savedModel) lspSaveDoc(savedModel); // LSP didSave(바인딩 안 됐으면 no-op)
      } catch {
        /* useWriteFile onError가 토스트 처리 */
      }
    })();
  };

  // 초안 버리기 — 디스크 내용으로 되돌리고 저장된 초안을 지운다.
  const discardDraft = useCallback(() => {
    window.clearTimeout(draftTimerRef.current);
    clearFileDraft(editorKeyRef.current);
    editorRef.current?.setValue(baselineRef.current);
    setDirty(false);
    setRecoveredDraft(false);
  }, []);

  // 파일 전환 시 dirty 해제(새 에디터 mount가 baseline을 다시 잡는다).
  // 복구 배너도 같이 내린다 — 새 파일의 onFileMount가 초안이 있을 때만 다시 올린다
  // (Monaco 로딩이 비동기라 이 효과보다 onMount가 항상 뒤에 돈다).
  useEffect(() => {
    setDirty(false);
    setRecoveredDraft(false);
  }, [editorKey]);

  // 화면 내용을 실제 데이터와 동기화 — useDiff는 keepPreviousData라 파일 전환 직후엔
  // "이전 파일" 내용이 placeholder로 들어오고, <Editor defaultValue>는 마운트 후 값 변경을
  // 무시하므로 그대로 두면 이전 파일이 새 탭 이름 아래 영구 표시된다(내용·경로 불일치 버그).
  // 진짜 내용이 도착하면 여기서 교체한다. 디스크 변경(watcher invalidate) 반영도 겸한다.
  // 사용자가 편집 중(dirty)이면 입력을 보존하기 위해 덮어쓰지 않는다.
  // dirty는 ref로만 읽는다 — 의존성에 넣으면 저장 직후(dirty→false, 쿼리는 아직 이전 내용)
  // 효과가 돌아 방금 저장한 화면을 구 데이터로 되돌린다. 쿼리 데이터가 바뀔 때만 동기화.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const ed = editorRef.current;
    const content = diff?.newContent;
    if (!isFileView || !ed || content == null || dirtyRef.current) return;
    if (ed.getValue() === content) return;
    baselineRef.current = content; // setValue의 change 리스너가 새 기준으로 dirty를 계산하게 선행
    ed.setValue(content);
    setDirty(false);
    revealTarget(ed); // 교체로 스크롤/선택이 초기화되므로 점프 대상 재표시
    lintRef.current(); // 외부 디스크 변경 반영 시 구 마커 위치가 무효 → 재계산
  }, [diff, isFileView, revealTarget]);

  const onFileMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    // 파일뷰 에디터는 항상 편집 가능 — options.readOnly가 마운트 시 안 먹는 경우가 있어
    // 에디터 API로 명시 적용한다(편집 보장).
    editor.updateOptions({ readOnly: false });
    baselineRef.current = editor.getValue();
    // 미저장 초안 복구 — 지난번 편집이 남아 있고 디스크 내용과 다르면 그 내용으로 되살린다.
    // 변경 리스너를 걸기 **전에** setValue 해야 복구 자체가 초안 저장을 다시 트리거하지 않는다.
    const draft = loadFileDraft(editorKeyRef.current);
    let recovered = false;
    if (draft !== null && draft !== baselineRef.current) {
      editor.setValue(draft);
      recovered = true;
    }
    setDirty(recovered);
    setRecoveredDraft(recovered);
    editor.onDidChangeModelContent(() => {
      setDirty(editor.getValue() !== baselineRef.current);
      draftSaveRef.current(); // 미저장 편집 초안(300ms 디바운스)
      // on-type 린트: 파이썬만(ruff는 stdin 버퍼 린트 지원 → 저장 전 실시간 밑줄).
      // biome는 stdin JSON이 안 돼서 저장 시에만 재계산(디스크). 디바운스로 타자 중 폭주 방지.
      if (editor.getModel()?.getLanguageId() === "python") lintRef.current(true);
      lspChangeRef.current(); // LSP didChange(full sync, 250ms 디바운스)
    });
    // Ctrl+S / Cmd+S 저장 (Monaco 내부에서 가로채 브라우저 저장 다이얼로그 방지).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    // go-to-def로 줄 지정해 열렸으면 해당 심볼로 스크롤 + 선택(마운트 시점 1회).
    revealTarget(editor);
    lintRef.current(); // 열람 시 1회 린트
    lspOpenRef.current(); // LSP didOpen(옵트인 + 지원 언어일 때만 서버 기동)
  }, [revealTarget]);

  // 파일뷰 언마운트 시 마커 정리(모델 dispose가 원 방어 — 이중 방어 + 대기 중 디바운스 취소).
  useEffect(() => {
    return () => {
      // draftTimerRef는 **일부러 취소하지 않는다.** 그 콜백은 예약 시점에 캡처한 값만 쓰고
      // localStorage만 건드리므로 언마운트 뒤 발화해도 안전하며, 여기서 취소하면 마지막
      // 300ms 분량의 편집이 사라진다 — 초안이 막으려는 바로 그 상황이다.
      window.clearTimeout(lintTimerRef.current);
      window.clearTimeout(lspChangeTimerRef.current);
      if (lspModelRef.current) lspCloseDoc(lspModelRef.current); // LSP didClose(전체 언마운트)
      const model = editorRef.current?.getModel();
      if (model) clearLintMarkers(model);
    };
  }, []);

  // 같은 파일 내에서 위치만 바뀌면(에디터 미재마운트) 그 심볼로 이동.
  useEffect(() => {
    if (targetLine && targetLine > 0 && editorRef.current)
      revealTarget(editorRef.current);
  }, [targetLine, targetColumn, editorKey, revealTarget]);

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
  const canEditFromDiff =
    !isImageView && (target.mode === "worktree" || target.mode === "index");

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
        {canFormat && (
          <button
            onClick={() => void editorRef.current?.getAction("editor.action.formatDocument")?.run()}
            title="포맷 (Shift+Alt+F)"
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-fg-dim hover:bg-raised hover:text-fg"
          >
            <Wand2 size={13} />
            포맷
          </button>
        )}
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
            onClick={() => selectDiff({ mode: "file", path }, projectId)}
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
        {!isFileView && !isImageView && (
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

      {recoveredDraft && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px]">
          <FileWarning size={12} className="shrink-0 text-warn" />
          <span className="flex-1 truncate text-fg-muted">
            저장하지 않은 편집을 복구했습니다.
          </span>
          <button
            type="button"
            onClick={discardDraft}
            className="shrink-0 rounded px-1.5 py-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            버리기
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {isImageView ? (
          <ImageView projectId={projectId} path={path} />
        ) : isLoading ? (
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
