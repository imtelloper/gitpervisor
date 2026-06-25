import { FolderGit2 } from "lucide-react";
import { useEffect } from "react";

import { AggregateTerminals } from "./components/AggregateTerminals";
import { ChangesPanel } from "./components/changes/ChangesPanel";
import { ConfirmHost } from "./components/common/ConfirmDialog";
import { ConnectionDialog } from "./components/db/ConnectionDialog";
import { EmptyState } from "./components/common/EmptyState";
import { Toasts } from "./components/common/Toast";
import { GitGate } from "./components/GitGate";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
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
import {
  useAutoFetch,
  useProjectRootsPrefetch,
  useProjects,
  useSettings,
} from "./queries";
import { useUi } from "./stores/ui";

export default function App() {
  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const fileTreeOpen = useUi((s) => s.fileTreeOpen);
  const aggregateOpen = useUi((s) => s.aggregateOpen);

  const { data: settings } = useSettings();
  useAutoFetch(); // 옵트인 자동 fetch (기본 OFF)
  useProjectRootsPrefetch(); // 전 프로젝트 루트 병렬 프리페치 → 트리 즉시 표시
  useAgentNotifications(); // AI 작업 완료 OS 알림 (메인 창 1회 — 설정 모드별)

  // 선택 테마를 <html data-theme>로 적용 — CSS 변수 오버라이드가 전체 팔레트를 바꾼다
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? "darcula";
  }, [settings?.theme]);

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
          </div>
          <Toasts />
          <ConfirmHost />
          <SettingsDialog />
          <MemoDialog />
          <ConnectionDialog />
        </GitGate>
      </div>
    </div>
  );
}
