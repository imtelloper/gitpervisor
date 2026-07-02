import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownUp,
  Copy,
  FolderOpen,
  HardDrive,
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
  useRefreshProjectSizes,
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
  const refreshSizes = useRefreshProjectSizes();
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
        s.conflicted.length +
        s.nestedChanges
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

  // ── 드래그 순서 정렬 (포인터 기반) ──
  // HTML5 drag&drop은 WebView2(Windows)에서 OS 드래그-드롭 가로채기·user-select 등으로 불안정하다.
  // 패널 리사이즈와 동일한 포인터 이벤트 방식으로 직접 구현: 좌클릭 후 임계(5px) 넘게 움직이면
  // 드래그로 전환 → 항목 중점 기준으로 삽입 위치(overId, null=맨 끝) 계산·표시 → 떼면 재정렬.
  const reorder = useReorderProjects();
  const reorderMutate = reorder.mutate;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const orderedRef = useRef(orderedProjects);
  orderedRef.current = orderedProjects;
  const listRef = useRef<HTMLDivElement | null>(null);

  const beginDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0) return; // 좌클릭만 (우클릭=컨텍스트 메뉴)
      const startY = e.clientY;
      let dragging = false;
      let over: string | null = null;

      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) < 5) return; // 클릭/드래그 구분 임계
          dragging = true;
          setDragId(id);
        }
        const cont = listRef.current;
        if (!cont) return;
        // 포인터 Y가 어느 항목의 위쪽 절반에 있는지로 "그 항목 앞에 삽입"을 정한다. 끝이면 null.
        let target: string | null = null;
        for (const el of cont.querySelectorAll<HTMLElement>("[data-project-id]")) {
          const r = el.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            target = el.dataset.projectId ?? null;
            break;
          }
        }
        over = target;
        setOverId(target);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDragId(null);
        setOverId(null);
        if (!dragging) return; // 임계 미달 = 단순 클릭 → onClick이 선택 처리
        const ids = orderedRef.current.map((p) => p.id);
        const fromIdx = ids.indexOf(id);
        if (fromIdx === -1) return;
        ids.splice(fromIdx, 1);
        let at = over == null ? ids.length : ids.indexOf(over);
        if (at === -1) at = ids.length;
        ids.splice(at, 0, id);
        // 드래그로 순서를 정했으니 변경 우선 정렬은 끄고 수동 순서로 전환(드래그가 보이게 반영)
        if (useUi.getState().projectSortByChanges)
          useUi.getState().toggleProjectSort();
        reorderMutate(ids);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
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

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {orderedProjects.map((p) => (
          <ProjectItem
            key={p.id}
            project={p}
            selected={p.id === selectedProjectId}
            onSelect={selectProject}
            onRemove={handleRemove}
            onContextMenu={handleItemContextMenu}
            isOver={overId === p.id && dragId !== p.id}
            isDragging={dragId === p.id}
            onPointerDownDrag={beginDrag}
          />
        ))}
        {/* 맨 끝에 삽입할 때의 표시선 */}
        {dragId && overId === null && (
          <div className="mx-2 h-0.5 bg-accent" />
        )}
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
          <MenuItem
            icon={HardDrive}
            label="용량 새로고침"
            onClick={() => {
              refreshSizes();
              setMenu(null);
            }}
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
