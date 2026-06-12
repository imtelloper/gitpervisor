import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";

import { useAddProject, useProjects, useRemoveProject } from "../../queries";
import { useUi } from "../../stores/ui";
import { ProjectItem } from "./ProjectItem";

export function ProjectList() {
  const { data: projects } = useProjects();
  const addProject = useAddProject();
  const removeProject = useRemoveProject();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);

  async function handleAdd() {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "git 프로젝트 폴더 선택",
    });
    if (typeof dir === "string") addProject.mutate(dir);
  }

  function handleRemove(id: string) {
    removeProject.mutate(id, {
      onSuccess: () => {
        if (useUi.getState().selectedProjectId === id) selectProject(null);
      },
    });
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-edge bg-panel">
      <div className="px-3 pb-1 pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
        PROJECTS
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects?.map((p) => (
          <ProjectItem
            key={p.id}
            project={p}
            selected={p.id === selectedProjectId}
            onSelect={() => selectProject(p.id)}
            onRemove={() => handleRemove(p.id)}
          />
        ))}
        {projects && projects.length === 0 && (
          <div className="px-3 py-4 text-xs leading-5 text-fg-dim">
            아직 프로젝트가 없습니다.
            <br />
            아래 버튼으로 git 레포 폴더를 추가하세요.
          </div>
        )}
      </div>

      <button
        onClick={handleAdd}
        disabled={addProject.isPending}
        className="flex items-center gap-2 border-t border-edge px-3 py-2.5 text-[13px] text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
      >
        <Plus size={14} />
        {addProject.isPending ? "추가하는 중…" : "프로젝트 추가"}
      </button>
    </aside>
  );
}
