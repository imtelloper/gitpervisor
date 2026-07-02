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
import { LogPanel } from "./components/log/LogPanel";
import { MemoDialog } from "./components/memo/MemoDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ProjectList } from "./components/sidebar/ProjectList";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/toolbar/Toolbar";
import { FileTreePanel } from "./components/tree/FileTreePanel";
import { WorkspaceTabs } from "./components/workspace/WorkspaceTabs";
import { useAgentNotifications } from "./lib/agent-notify";
import { ipc } from "./lib/ipc";
import {
  useAutoFetch,
  useProjectRootsPrefetch,
  useProjects,
  useSettings,
} from "./queries";
import { useUi } from "./stores/ui";

// 이미지 편집기는 무겁고(canvas + avif wasm 동적 로드) 자주 안 열리므로 처음 열 때만 로드한다.
const ImageEditor = lazy(() => import("./components/image/ImageEditor"));

export default function App() {
  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const fileTreeOpen = useUi((s) => s.fileTreeOpen);
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const imageEditorPath = useUi((s) => s.imageEditorPath);

  const { data: settings } = useSettings();
  useAutoFetch(); // 옵트인 자동 fetch (기본 OFF)
  useProjectRootsPrefetch(); // 전 프로젝트 루트 병렬 프리페치 → 트리 즉시 표시
  useAgentNotifications(); // AI 작업 완료 OS 알림 (메인 창 1회 — 설정 모드별)

  // 선택 테마를 <html data-theme>로 적용 — CSS 변수 오버라이드가 전체 팔레트를 바꾼다
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? "darcula";
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

  const selected = projects?.find((p) => p.id === selectedProjectId) ?? null;

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
                ) : selected ? (
                  <>
                    <Toolbar project={selected} />
                    <div className="flex min-h-0 flex-1">
                      <ChangesPanel projectId={selected.id} />
                      <WorkspaceTabs projectId={selected.id} />
                    </div>
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
