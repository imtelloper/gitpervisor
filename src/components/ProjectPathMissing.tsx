import { open } from "@tauri-apps/plugin-dialog";
import { FolderX } from "lucide-react";

import { useMessages } from "../i18n/ui-language";
import type { Project } from "../lib/ipc";
import { useRemoveProjectFull, useUpdateProjectPath } from "../queries";
import { EmptyState } from "./common/EmptyState";

/** 프로젝트 경로 소실(폴더 이동/삭제) 복구 화면 — 뷰어 자리 전체를 차지한다.
 *  폴더를 옮겼으면 새 위치 지정, 지웠으면 프로젝트 제거. App.tsx가 status.error로 분기한다. */
export function ProjectPathMissing({ project }: { project: Project }) {
  const msg = useMessages();
  const updatePath = useUpdateProjectPath();
  const removeProject = useRemoveProjectFull();

  async function pickNewPath() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: msg.app.projectPathMissing.pickDialogTitle(project.name),
    });
    if (!picked || Array.isArray(picked)) return;
    updatePath.mutate({ id: project.id, path: picked });
  }

  return (
    <EmptyState
      icon={FolderX}
      title={msg.app.projectPathMissing.title}
      desc={msg.app.projectPathMissing.desc(project.path)}
      action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => void pickNewPath()}
            disabled={updatePath.isPending}
            className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {msg.app.projectPathMissing.fixPath}
          </button>
          <button
            onClick={() => removeProject(project.id)}
            className="rounded-md border border-danger/40 px-4 py-1.5 text-[13px] text-danger hover:bg-danger/10"
          >
            {msg.app.projectPathMissing.remove}
          </button>
        </div>
      }
    />
  );
}
