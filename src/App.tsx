import { FolderGit2, MousePointerClick } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { ChangesPanel } from "./components/changes/ChangesPanel";
import { ConfirmHost } from "./components/common/ConfirmDialog";
import { EmptyState } from "./components/common/EmptyState";
import { Toasts } from "./components/common/Toast";
import { GitGate } from "./components/GitGate";
import { ProjectList } from "./components/sidebar/ProjectList";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/toolbar/Toolbar";
import { useProjects } from "./queries";
import { useUi } from "./stores/ui";

// Monaco 번들은 무겁다 — 파일을 처음 열 때만 로드한다
const DiffViewer = lazy(() => import("./components/diff/DiffViewer"));

export default function App() {
  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectedFilePath = useUi((s) => s.selectedFilePath);
  const selectProject = useUi((s) => s.selectProject);

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
    <GitGate>
      <div className="flex h-screen flex-col">
        <div className="flex min-h-0 flex-1">
          <ProjectList />

          <main className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <Toolbar project={selected} />
                <div className="flex min-h-0 flex-1">
                  <ChangesPanel projectId={selected.id} />
                  <section className="min-w-0 flex-1">
                    {selectedFilePath ? (
                      <Suspense
                        fallback={<EmptyState title="diff 뷰어 로딩 중…" />}
                      >
                        <DiffViewer
                          projectId={selected.id}
                          path={selectedFilePath}
                        />
                      </Suspense>
                    ) : (
                      <EmptyState
                        icon={MousePointerClick}
                        title="파일을 선택하세요"
                        desc="왼쪽 변경 목록에서 파일을 클릭하면 side-by-side diff가 표시됩니다"
                      />
                    )}
                  </section>
                </div>
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
    </GitGate>
  );
}
