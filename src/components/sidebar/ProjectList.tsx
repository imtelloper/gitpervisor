import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownUp,
  Copy,
  FolderOpen,
  Plus,
  StickyNote,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpenTarget, Project } from "../../lib/ipc";
import { errorMessage, ipc } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import {
  useAddProject,
  useProjects,
  useRemoveProject,
  useReorderProjects,
  useStatuses,
} from "../../queries";
import { useAgentScanner } from "../../stores/agentActivity";
import { useTerminals } from "../../stores/terminals";
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
  const { data: statuses } = useStatuses();
  const addProject = useAddProject();
  const removeProject = useRemoveProject();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const sortByChanges = useUi((s) => s.projectSortByChanges);
  const toggleProjectSort = useUi((s) => s.toggleProjectSort);
  const { width, startResize } = usePanelWidth("gp:projects-width", 240, 170, 440);

  // 터미널의 Claude Code 작업중/완료 상태를 주기 스캔(1회 마운트)
  useAgentScanner();

  const [menu, setMenu] = useState<MenuState | null>(null);

  // 변경/활동 우선 정렬: 작업트리 변경 있는 프로젝트 → push/pull 대기 → 깨끗한 순.
  // 같은 등급 안에서는 변경 수 많은 순, 그 다음 등록 순서(order)로 안정 정렬.
  const orderedProjects = useMemo(() => {
    const list = projects ?? [];
    if (!sortByChanges) return list;
    const byId = new Map((statuses ?? []).map((s) => [s.projectId, s]));
    const changeCount = (p: Project) => {
      const s = byId.get(p.id);
      if (!s) return 0;
      return (
        s.staged.length +
        s.unstaged.length +
        s.untracked.length +
        s.conflicted.length
      );
    };
    const rank = (p: Project) => {
      const s = byId.get(p.id);
      if (!s) return 3; // 상태 미로딩 → 맨 뒤(기존 순서 유지)
      if (changeCount(p) > 0) return 0;
      if (s.ahead > 0 || s.behind > 0) return 1;
      return 2;
    };
    return [...list].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ca = changeCount(a);
      const cb = changeCount(b);
      if (ca !== cb) return cb - ca;
      return a.order - b.order;
    });
  }, [projects, statuses, sortByChanges]);

  // ── 드래그 순서 정렬 ── 항상 활성. 변경 우선 정렬(sortByChanges)이 켜져 있어도 드래그하면
  // 드롭 시 수동 순서 모드로 전환해 드래그가 실제로 반영되게 한다(드래그=수동 정렬 의도).
  const reorder = useReorderProjects();
  const reorderMutate = reorder.mutate;
  const dragEnabled = true;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 콜백을 안정 참조로 두기 위해 최신 목록/드래그 대상은 ref로 본다(ProjectItem memo 보존).
  const orderedRef = useRef(orderedProjects);
  orderedRef.current = orderedProjects;
  const dragRef = useRef<string | null>(null);
  dragRef.current = dragId;

  const handleDragStart = useCallback((id: string) => setDragId(id), []);
  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setOverId(null);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    setOverId((cur) => (cur === id ? cur : id));
  }, []);
  const handleDrop = useCallback(
    (targetId: string) => {
      const from = dragRef.current;
      setDragId(null);
      setOverId(null);
      if (!from || from === targetId) return;
      const ids = orderedRef.current.map((p) => p.id);
      const fromIdx = ids.indexOf(from);
      if (fromIdx === -1) return;
      ids.splice(fromIdx, 1); // 끌고 온 항목을 빼고
      const at = ids.indexOf(targetId);
      ids.splice(at === -1 ? ids.length : at, 0, from); // 대상 앞에 삽입
      // 드래그로 직접 순서를 정했으니 변경 우선 정렬은 끄고 수동 순서로 전환(드래그가 보이게 반영)
      if (useUi.getState().projectSortByChanges)
        useUi.getState().toggleProjectSort();
      reorderMutate(ids);
    },
    [reorderMutate],
  );

  // Ctrl+Shift+↑/↓ 로 프로젝트 선택을 위/아래로 이동 (표시 순서 기준, 양끝 wrap-around).
  // 최신 목록/선택을 ref로 참조해 리스너를 1회만 등록한다(KeyboardShortcuts와 동일 패턴).
  // 터미널 포커스 중에도 동작하도록 xterm은 이 조합을 PTY로 보내지 않고 흘려보낸다(terminal-engine).
  const navRef = useRef({ orderedProjects, selectedProjectId });
  navRef.current = { orderedProjects, selectedProjectId };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const { orderedProjects: list, selectedProjectId: sel } = navRef.current;
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.findIndex((p) => p.id === sel);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      // 선택이 없으면 방향에 맞춰 양끝에서 시작
      const base = idx === -1 ? (delta === 1 ? -1 : 0) : idx;
      const next = (base + delta + list.length) % list.length;
      selectProject(list[next].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectProject]);

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
    const picked = await open({
      directory: true,
      multiple: true,
      title: "git 프로젝트 폴더 선택 (여러 개 선택 가능)",
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    // 순차 추가 — 동시 add는 projects 저장이 경합할 수 있다. 감시 등록을 백엔드가
    // 백그라운드로 미루므로 각 추가는 빠르다. 개별 실패(비-git 폴더 등)는 토스트로 알리고 계속.
    for (const p of paths) {
      try {
        await addProject.mutateAsync(p);
      } catch {
        /* onError가 토스트를 띄운다 — 다음 폴더 계속 */
      }
    }
  }

  // 안정 참조 콜백 — ProjectItem(memo)이 부모 로컬 상태 변화에 재렌더되지 않게 한다.
  // removeProject(useMutation 결과)는 매 렌더 새 객체라 dep로 쓰면 콜백이 매번 새로 생겨
  // memo가 무력화된다 — v5에서 안정 참조인 .mutate만 dep로 잡는다.
  const removeMutate = removeProject.mutate;
  const handleRemove = useCallback(
    (id: string) => {
      // 제거되는 프로젝트의 열린 터미널 PTY를 정리한다 (설계 §16.8)
      useTerminals.getState().closeProjectTerminals(id);
      removeMutate(id, {
        onSuccess: () => {
          if (useUi.getState().selectedProjectId === id) selectProject(null);
        },
      });
    },
    [removeMutate, selectProject],
  );

  const handleItemContextMenu = useCallback(
    (e: React.MouseEvent, project: Project) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, project });
    },
    [],
  );

  function handleOpenIn(project: Project, target: OpenTarget) {
    void ipc
      .openIn(project.id, target)
      .catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
    setMenu(null);
  }

  function handleMemo(project: Project) {
    selectProject(project.id); // memoOpen 초기화됨 → 아래서 다시 연다
    useUi.getState().setMemoOpen(true);
    setMenu(null);
  }

  function handleCopyPath(project: Project) {
    void navigator.clipboard
      .writeText(project.path)
      .then(() =>
        useUi.getState().pushToast("success", "프로젝트 경로를 복사했습니다"),
      )
      .catch(() => useUi.getState().pushToast("error", "경로 복사에 실패했습니다"));
    setMenu(null);
  }

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className="text-[11px] font-semibold tracking-widest text-fg-dim">
          PROJECTS
        </span>
        <button
          onClick={toggleProjectSort}
          title={
            sortByChanges
              ? "변경 우선 정렬 끄기 (등록 순서로)"
              : "변경/활동 있는 프로젝트 먼저 보기"
          }
          className={`shrink-0 rounded p-1 ${
            sortByChanges
              ? "text-accent"
              : "text-fg-dim hover:bg-raised hover:text-fg"
          }`}
        >
          <ArrowDownUp size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {orderedProjects.map((p) => (
          <ProjectItem
            key={p.id}
            project={p}
            selected={p.id === selectedProjectId}
            onSelect={selectProject}
            onRemove={handleRemove}
            onContextMenu={handleItemContextMenu}
            draggable={dragEnabled}
            isOver={dragEnabled && overId === p.id && dragId !== p.id}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        ))}
        {projects && orderedProjects.length === 0 && (
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
            icon={StickyNote}
            label="메모"
            onClick={() => handleMemo(menu.project)}
          />
          <div className="my-1 border-t border-edge" />
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
          <MenuItem
            icon={Copy}
            label="프로젝트 경로 복사"
            onClick={() => handleCopyPath(menu.project)}
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
