import { FolderGit2 } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { AggregateTerminals } from "./components/AggregateTerminals";
import { ChangesPanel } from "./components/changes/ChangesPanel";
import { ConfirmHost } from "./components/common/ConfirmDialog";
import { PromptHost } from "./components/common/PromptDialog";
import { ConnectionDialog } from "./components/db/ConnectionDialog";
import { EmptyState } from "./components/common/EmptyState";
import { Toasts } from "./components/common/Toast";
import { GitGate } from "./components/GitGate";
import { GlobalShortcuts, KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { QuickOpenHost } from "./components/quickopen/QuickOpenHost";
import { SearchPanel } from "./components/search/SearchPanel";
import { SymbolSearch } from "./components/symbolsearch/SymbolSearch";
import { useSearch } from "./stores/search";
import { LogPanel } from "./components/log/LogPanel";
import { MemoDialog } from "./components/memo/MemoDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ProjectList } from "./components/sidebar/ProjectList";
import { ProjectPathMissing } from "./components/ProjectPathMissing";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/toolbar/Toolbar";
import { FileTreePanel } from "./components/tree/FileTreePanel";
import { WorkspaceTabs } from "./components/workspace/WorkspaceTabs";
import { useAgentNotifications } from "./lib/agent-notify";
import { ipc } from "./lib/ipc";
import { refreshTerminalThemes } from "./lib/terminal";
import {
  useProjectRootsPrefetch,
  useProjects,
  useSettings,
  useStatus,
} from "./queries";
import { useUi } from "./stores/ui";
import { useUpdater } from "./stores/updater";

// 이미지 편집기는 무겁고(canvas + avif wasm 동적 로드) 자주 안 열리므로 처음 열 때만 로드한다.
const ImageEditor = lazy(() => import("./components/image/ImageEditor"));

export default function App() {
  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const fileTreeOpen = useUi((s) => s.fileTreeOpen);
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const imageEditorPath = useUi((s) => s.imageEditorPath);
  const searchOpen = useSearch((s) => s.open);

  const { data: settings } = useSettings();
  // 자동 fetch는 Rust 스케줄러(fetch_scheduler.rs)가 담당 — 포커스 복귀 트리거는
  // events.ts의 focusManager 연결부에서 함께 배선된다(태스크 04).
  useProjectRootsPrefetch(); // 전 프로젝트 루트 병렬 프리페치 → 트리 즉시 표시
  useAgentNotifications(); // AI 작업 완료 OS 알림 (메인 창 1회 — 설정 모드별)

  // 선택 테마를 <html data-theme>로 적용 — CSS 변수 오버라이드가 전체 팔레트를 바꾼다
  useEffect(() => {
    const theme = settings?.theme ?? "darcula";
    document.documentElement.dataset.theme = theme;
    // 다음 실행의 첫 페인트용 캐시 — main.tsx가 렌더 전에 선적용해 시작 플래시를 없앤다
    try {
      localStorage.setItem("gp:theme", theme);
    } catch {
      /* localStorage 불가 환경 무시 */
    }
    // 이미 열린 xterm은 생성 시 테마가 박제되므로 즉시 재적용 (CSSOM 반영은 동기라 안전)
    refreshTerminalThemes();
  }, [settings?.theme]);

  // 이전 실행에서 크래시가 있었으면(패닉 로그가 남았으면) 1회 알린다. 같은 크래시(파일 mtime)는
  // localStorage 마커로 중복 표시하지 않는다. 자세한 내용은 설정 › 진단/로그에서 본다.
  useEffect(() => {
    void ipc
      .getLogStatus()
      .then((s) => {
        if (!s.lastCrashAt || s.panicLogBytes === 0) return;
        if (localStorage.getItem("gp:last-crash-seen") === s.lastCrashAt) return;
        localStorage.setItem("gp:last-crash-seen", s.lastCrashAt);
        useUi
          .getState()
          .pushToast(
            "error",
            "이전 실행에서 오류가 감지되었습니다 — 설정 › 진단/로그에서 확인하세요",
          );
      })
      .catch(() => {});
  }, []);

  // 시작 시 자동 업데이트 확인(옵트인, 기본 켬) — 콜드스타트 IPC 폭주와 안 겹치게 잠깐 지연.
  // 새 버전이 있으면 updater 스토어가 토스트로 알리고 설정 › 업데이트에 표시한다. 실패는 조용히.
  useEffect(() => {
    if (!useUpdater.getState().autoCheck) return;
    const t = setTimeout(() => void useUpdater.getState().check({ silent: true }), 4000);
    return () => clearTimeout(t);
  }, []);

  const selected = projects?.find((p) => p.id === selectedProjectId) ?? null;

  // 선택 프로젝트의 경로 소실(폴더 이동/삭제) 감지 — 문구는 백엔드 status_of와 동일(단일 진실).
  const { data: selStatus } = useStatus(selectedProjectId);
  const pathMissing = selStatus?.error === "프로젝트 경로를 찾을 수 없습니다";

  // 첫 로드 시 첫 프로젝트 자동 선택, 선택된 프로젝트가 제거되면 선택 정리
  useEffect(() => {
    if (!projects) return;
    if (selectedProjectId && !projects.some((p) => p.id === selectedProjectId)) {
      selectProject(projects[0]?.id ?? null);
    } else if (!selectedProjectId && projects.length > 0) {
      selectProject(projects[0].id);
    }
  }, [projects, selectedProjectId, selectProject]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="min-h-0 flex-1">
        <GitGate>
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1">
              <ProjectList />
              {selected && fileTreeOpen && (
                <FileTreePanel projectId={selected.id} />
              )}

              <main className="flex min-w-0 flex-1 flex-col">
                {aggregateOpen ? (
                  <AggregateTerminals />
                ) : selected && pathMissing ? (
                  <ProjectPathMissing project={selected} />
                ) : selected ? (
                  <>
                    <Toolbar project={selected} />
                    <div className="flex min-h-0 flex-1">
                      <ChangesPanel projectId={selected.id} />
                      <WorkspaceTabs projectId={selected.id} />
                    </div>
                    {searchOpen && <SearchPanel projectId={selected.id} />}
                    <LogPanel projectId={selected.id} />
                    <KeyboardShortcuts projectId={selected.id} />
                  </>
                ) : (
                  <EmptyState
                    icon={FolderGit2}
                    title="프로젝트를 추가하세요"
                    desc="좌측 하단 ‘프로젝트 추가’ 버튼으로 git 레포 폴더를 등록하면 상태가 표시됩니다"
                  />
                )}
              </main>
            </div>

            <StatusBar project={selected} />
            {/* 모아보기 토글 등 — 조건 분기 바깥에 상시 마운트(모아보기 중에도 닫기 동작) */}
            <GlobalShortcuts />
          </div>
          <Toasts />
          <ConfirmHost />
          <PromptHost />
          <QuickOpenHost />
          <SymbolSearch />
          <SettingsDialog />
          <MemoDialog />
          <ConnectionDialog />
          {imageEditorPath && (
            <Suspense fallback={null}>
              <ImageEditor />
            </Suspense>
          )}
        </GitGate>
      </div>
    </div>
  );
}
