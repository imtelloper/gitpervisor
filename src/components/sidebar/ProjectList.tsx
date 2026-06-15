import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, Terminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { OpenTarget, Project } from "../../lib/ipc";
import { errorMessage, ipc } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import { useAddProject, useProjects, useRemoveProject } from "../../queries";
import { useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";
import { ProjectItem } from "./ProjectItem";

interface MenuState {
  x: number;
  y: number;
  project: Project;
}

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof FolderOpen;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raised ${
        danger ? "text-danger" : "text-fg-muted hover:text-fg"
      }`}
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </button>
  );
}

export function ProjectList() {
  const { data: projects } = useProjects();
  const addProject = useAddProject();
  const removeProject = useRemoveProject();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const { width, startResize } = usePanelWidth("gp:projects-width", 240, 170, 440);

  const [menu, setMenu] = useState<MenuState | null>(null);

  // 메뉴 열림 동안 바깥 클릭 / Esc 로 닫는다
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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

  function handleOpenIn(project: Project, target: OpenTarget) {
    void ipc
      .openIn(project.id, target)
      .catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
    setMenu(null);
  }

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
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
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, project: p });
            }}
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

      {menu && (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 130),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={FolderOpen}
            label="탐색기에서 열기"
            onClick={() => handleOpenIn(menu.project, "explorer")}
          />
          <MenuItem
            icon={Terminal}
            label="터미널에서 열기"
            onClick={() => handleOpenIn(menu.project, "terminal")}
          />
          <div className="my-1 border-t border-edge" />
          <MenuItem
            icon={Trash2}
            label="프로젝트 제거"
            danger
            onClick={() => {
              handleRemove(menu.project.id);
              setMenu(null);
            }}
          />
        </div>
      )}

      <ResizeHandle onMouseDown={startResize} />
    </aside>
  );
}
