import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { HealthBanner } from "./components/common/HealthBanner";
import { Toolbar } from "./components/toolbar/Toolbar";
import { FileTreePanel } from "./components/tree/FileTreePanel";
import { WorkspaceTabs } from "./components/workspace/WorkspaceTabs";
import { useAgentNotifications } from "./lib/agent-notify";
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

  // 시작 시 자동 업데이트 확인(옵트인, 기본 켬) — 콜드스타트 IPC 폭주와 안 겹치게 잠깐 지연.
  // 새 버전이 있으면 updater 스토어가 토스트로 알리고 설정 › 업데이트에 표시한다. 실패는 조용히.
  useEffect(() => {
    if (!useUpdater.getState().autoCheck) return;
    const t = setTimeout(() => void useUpdater.getState().check({ silent: true }), 4000);
    return () => clearTimeout(t);
  }, []);

  // 메인 창 닫기 확인 — 백엔드가 살아있는 PTY 세션이 있을 때만 닫기를 막고 이 이벤트를 보낸다.
  // 확인하면 destroy()로 곧장 닫는다(CloseRequested를 다시 타지 않는다). 취소하면 백엔드 표식을
  // 되돌려 다음 X에서 다시 묻는다 — 안 되돌리면 그다음 오클릭이 확인 없이 통과한다.
  useEffect(() => {
    const un = listen<number>("app://close-requested", (e) => {
      const n = e.payload;
      useUi.getState().askConfirm({
        title: "터미널이 실행 중입니다",
        message: `실행 중인 터미널 세션이 ${n}개 있습니다. 지금 닫으면 그 안에서 돌고 있는 명령(빌드·개발 서버·에이전트)이 모두 종료됩니다.`,
        confirmLabel: "닫기",
        danger: true,
        onConfirm: () => void getCurrentWindow().destroy(),
        onCancel: () => void invoke("reset_close_guard").catch(() => {}),
      });
    });
    return () => void un.then((f) => f());
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
      {/* 강제 종료 경보 / 지난 실행 비정상 종료 안내 — 최상단 고정 */}
      <HealthBanner />
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
