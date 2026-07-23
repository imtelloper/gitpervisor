import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  Plus,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";

import type { DiffTarget, FileChange, RepoStatus } from "../../lib/ipc";
import { KIND_BADGE } from "../../lib/change-kind";
import { fileIcon } from "../../lib/file-icon";
import { splitPath } from "../../lib/format";
import { usePanelWidth } from "../../lib/use-panel-width";
import {
  useDiscardFiles,
  usePrefetchDiffs,
  useSettings,
  useStageFiles,
  useStatus,
  useStatuses,
  useUnstageFiles,
} from "../../queries";
import { useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";
import { CommitForm } from "./CommitForm";

interface RowActions {
  onToggleStage: (change: FileChange) => void;
  onDiscard: (change: FileChange) => void;
}

/** 한 저장소의 작업트리 변경 개수(staged+unstaged+untracked+conflicted). */
function changeCount(s: RepoStatus): number {
  return (
    s.staged.length +
    s.unstaged.length +
    s.untracked.length +
    s.conflicted.length
  );
}

/** 한 변경 행을 가리키는 안정 키 (스테이지/언스테이지 인스턴스를 구분). */
function rowKeyOf(c: FileChange): string {
  return `${c.staged ? "s" : "w"}:${c.path}`;
}

function MenuBtn({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        danger
          ? "text-danger hover:bg-danger/15"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </button>
  );
}

function ChangeRow({
  change,
  selected,
  multiSelected,
  onActivate,
  onContextMenu,
  actions,
}: {
  change: FileChange;
  selected: boolean;
  multiSelected: boolean;
  onActivate: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  actions: RowActions;
}) {
  const { dir, base } = splitPath(change.path);
  const kind = KIND_BADGE[change.kind];
  const { Icon, color } = fileIcon(change.path);
  const stageable = change.kind !== "conflicted";
  const discardable = !change.staged && change.kind !== "conflicted";

  return (
    <div
      onClick={onActivate}
      onContextMenu={onContextMenu}
      title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
      className={`group relative flex cursor-pointer items-center gap-2 overflow-hidden px-3 py-1 ${
        selected
          ? "bg-selection"
          : multiSelected
            ? "bg-accent/15"
            : "hover:bg-raised"
      }`}
    >
      {stageable ? (
        <input
          type="checkbox"
          checked={change.staged}
          onChange={() => actions.onToggleStage(change)}
          onClick={(e) => e.stopPropagation()}
          title={change.staged ? "언스테이지" : "스테이지"}
          className="shrink-0 accent-accent"
        />
      ) : (
        <span className="w-[13px] shrink-0" />
      )}
      <Icon size={15} color={color} className="shrink-0" />
      <span
        className={`shrink-0 whitespace-nowrap ${kind.className} ${
          change.kind === "deleted" ? "line-through" : ""
        }`}
      >
        {base}
      </span>
      {dir && (
        <span className="shrink-0 whitespace-nowrap text-xs text-fg-dim">
          {dir}
        </span>
      )}
      {discardable && (
        <button
          title={change.kind === "untracked" ? "파일 삭제" : "변경 되돌리기"}
          onClick={(e) => {
            e.stopPropagation();
            actions.onDiscard(change);
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-raised p-0.5 text-fg-dim opacity-0 hover:bg-edge hover:text-danger group-hover:opacity-100"
        >
          <Undo2 size={13} />
        </button>
      )}
    </div>
  );
}

function Group({
  title,
  changes,
  accent,
  mode,
  selectedDiff,
  selKeys,
  onRowClick,
  onRowContextMenu,
  actions,
  collapsed,
  onToggleCollapse,
}: {
  title: string;
  changes: FileChange[];
  accent?: boolean;
  /** 이 그룹의 파일을 클릭했을 때의 diff 모드: staged는 index(HEAD↔인덱스),
   *  untracked는 file(내용만), 나머지는 worktree */
  mode: "worktree" | "index" | "file";
  selectedDiff: DiffTarget | null;
  selKeys: Set<string>;
  onRowClick: (key: string, e: React.MouseEvent) => void;
  onRowContextMenu: (key: string, e: React.MouseEvent) => void;
  actions: RowActions;
  // 접힘 상태는 부모(RepoChanges)가 관리한다 — 범위 선택이 보이는 행만 대상으로 하도록.
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  if (changes.length === 0) return null;

  return (
    <div>
      <button
        onClick={onToggleCollapse}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-fg-muted hover:text-fg"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className={accent ? "text-danger" : ""}>{title}</span>
        <span className="text-fg-dim">{changes.length}</span>
      </button>
      {!collapsed &&
        changes.map((c) => {
          const key = rowKeyOf(c);
          const selected =
            selectedDiff?.mode === mode && selectedDiff.path === c.path;
          return (
            <ChangeRow
              key={key}
              change={c}
              selected={selected}
              multiSelected={selKeys.has(key)}
              onActivate={(e) => onRowClick(key, e)}
              onContextMenu={(e) => onRowContextMenu(key, e)}
              actions={actions}
            />
          );
        })}
    </div>
  );
}

/**
 * 한 저장소(최상위 프로젝트 또는 임베디드 저장소)의 변경 목록 — 그룹 렌더 + 멀티선택 +
 * 우클릭 메뉴 + 스테이지/언스테이지/롤백. projectId 하나로 모든 조작이 그 저장소에 라우팅된다
 * (임베디드 저장소는 합성 id `<outer>::<rel>` — project_path가 중첩 경로로 되풂).
 *
 * outerProjectId: 현재 선택된 최상위 프로젝트 id. diff 하이라이트가 "이 저장소가 지금 보고 있는
 * diff의 저장소인가"를 판정하는 데 쓴다(중첩·최상위가 같은 상대경로 파일을 가질 때 오하이라이트 방지).
 */
function RepoChanges({
  projectId,
  outerProjectId,
}: {
  projectId: string;
  outerProjectId: string;
}) {
  const { data: status } = useStatus(projectId);
  const selectedDiff = useUi((s) => s.selectedDiff);
  const selectedDiffRepoId = useUi((s) => s.selectedDiffRepoId);
  const selectDiff = useUi((s) => s.selectDiff);
  const pushToast = useUi((s) => s.pushToast);
  const stage = useStageFiles(projectId);
  const unstage = useUnstageFiles(projectId);
  const discard = useDiscardFiles(projectId);
  const { data: settings } = useSettings();
  usePrefetchDiffs(projectId); // 클릭 전에 diff를 미리 적재 (§12)

  // 멀티선택(Ctrl/Cmd 토글, Shift 범위). 저장소(projectId) 전환 시 비운다.
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    setSelKeys(new Set());
    lastKeyRef.current = null;
  }, [projectId]);

  // 우클릭 컨텍스트 메뉴 (롤백/스테이지/언스테이지/복사). 바깥 클릭·Esc로 닫는다.
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(
    null,
  );
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
  // 여러 저장소 섹션(outer + 중첩)이 동시에 떠 있으므로, 한 섹션에서 메뉴를 열면 다른 섹션의
  // 열린 메뉴를 닫는다 — right-click은 'click'을 발생시키지 않아 위 close 리스너로는 안 닫힌다.
  useEffect(() => {
    const onClose = () => setMenu(null);
    window.addEventListener("gitpervisor:changes-closemenus", onClose);
    return () =>
      window.removeEventListener("gitpervisor:changes-closemenus", onClose);
  }, []);

  // 접힘 상태(그룹 제목 집합) — 평탄화/범위선택이 접힌 그룹을 제외하게 한다.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  // 그룹 정의(표시 순서) — diff 모드·강조 포함.
  const groups = status
    ? [
        { title: "Conflicts", changes: status.conflicted, mode: "worktree" as const, accent: true },
        { title: "Unstaged", changes: status.unstaged, mode: "worktree" as const, accent: false },
        { title: "Staged", changes: status.staged, mode: "index" as const, accent: false },
        // Untracked는 이전 버전이 없어 diff가 통째로 all-green이라 무의미 — 파일 내용만 그대로 보여준다.
        { title: "Untracked", changes: status.untracked, mode: "file" as const, accent: false },
      ]
    : [];

  // 이 저장소가 지금 뷰어에 뜬 diff의 대상 저장소일 때만 행을 선택 표시한다.
  // (diff repo가 지정 안 됐으면 outer로 간주 — 트리/로그에서 연 diff의 하이라이트 유지.)
  const activeDiff =
    (selectedDiffRepoId ?? outerProjectId) === projectId ? selectedDiff : null;

  // 평탄화 — **펼쳐진** 그룹의 행만(범위 선택이 숨은 행을 휩쓸어 의도치 않게 롤백하는 것 방지).
  const flatRows = groups.flatMap((g) =>
    collapsed.has(g.title)
      ? []
      : g.changes.map((c) => ({ key: rowKeyOf(c), change: c, mode: g.mode })),
  );

  const onRowClick = (key: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      lastKeyRef.current = key;
    } else if (e.shiftKey && lastKeyRef.current) {
      const a = flatRows.findIndex((r) => r.key === lastKeyRef.current);
      const b = flatRows.findIndex((r) => r.key === key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelKeys((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(flatRows[i].key);
          return next;
        });
      }
    } else {
      setSelKeys((prev) => (prev.size ? new Set() : prev));
      lastKeyRef.current = key;
      const row = flatRows.find((r) => r.key === key);
      if (row) {
        const target: DiffTarget =
          row.mode === "index"
            ? { mode: "index", path: row.change.path }
            : row.mode === "file"
              ? { mode: "file", path: row.change.path }
              : { mode: "worktree", path: row.change.path };
        // 이 저장소(projectId)를 diff 대상으로 지정 — 임베디드면 그 저장소로 라우팅.
        selectDiff(target, projectId);
      }
    }
  };

  const clearSel = () => {
    setSelKeys(new Set());
    lastKeyRef.current = null;
  };

  const selectedRows = flatRows.filter((r) => selKeys.has(r.key));

  // 우클릭 메뉴 대상 행: 우클릭한 행이 멀티선택에 포함되면 **선택 전체**, 아니면 그 행만.
  const menuRows = menu
    ? selKeys.has(menu.key)
      ? selectedRows
      : flatRows.filter((r) => r.key === menu.key)
    : [];
  const menuChange = menu
    ? flatRows.find((r) => r.key === menu.key)?.change ?? null
    : null;

  type Row = (typeof flatRows)[number];
  // 스테이지는 충돌 행 제외(충돌에 add는 미해결 채로 resolved 표시됨). 언스테이지는 실제로 스테이지된
  // 행만 — untracked 등 인덱스에 없는 경로가 섞이면 git restore --staged 가 통째로 실패한다.
  const unstagePathsOf = (rows: Row[]) => [
    ...new Set(rows.filter((r) => r.change.staged).map((r) => r.change.path)),
  ];
  // 롤백 대상: 스테이지·충돌 제외(워크트리 변경만). untracked는 삭제, 그 외는 워크트리 복원.
  const discardPartsOf = (rows: Row[]) => {
    const d = rows.filter(
      (r) => !r.change.staged && r.change.kind !== "conflicted",
    );
    return {
      tracked: [
        ...new Set(
          d.filter((r) => r.change.kind !== "untracked").map((r) => r.change.path),
        ),
      ],
      untracked: [
        ...new Set(
          d.filter((r) => r.change.kind === "untracked").map((r) => r.change.path),
        ),
      ],
    };
  };

  // 여러 행의 워크트리 변경을 한꺼번에 롤백(확인 다이얼로그 경유). 액션바·우클릭 메뉴 공용.
  const discardRows = (rows: Row[]) => {
    const { tracked, untracked } = discardPartsOf(rows);
    if (tracked.length === 0 && untracked.length === 0) {
      pushToast("info", "되돌릴 항목이 없습니다 (스테이지·충돌 제외)");
      return;
    }
    const run = () => {
      discard.mutate({ tracked, untracked });
      clearSel();
    };
    if (settings?.confirmDiscard === false) {
      run();
      return;
    }
    useUi.getState().askConfirm({
      title: "선택 롤백",
      message: `선택한 ${tracked.length + untracked.length}개 항목의 변경을 되돌립니다. 복구할 수 없습니다.`,
      detail: [...tracked, ...untracked].join("\n"),
      confirmLabel: "롤백",
      danger: true,
      onConfirm: run,
    });
  };

  // 액션바용(현재 멀티선택 기준)
  const stagePaths = [
    ...new Set(
      selectedRows
        .filter((r) => r.change.kind !== "conflicted")
        .map((r) => r.change.path),
    ),
  ];
  const unstagePaths = unstagePathsOf(selectedRows);

  const onRowContextMenu = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    // 다른 저장소 섹션의 열린 메뉴를 먼저 닫는다(동시에 두 메뉴가 뜨지 않게 — 단일 메뉴 유지).
    window.dispatchEvent(new CustomEvent("gitpervisor:changes-closemenus"));
    setMenu({ x: e.clientX, y: e.clientY, key });
  };

  const copyText = (text: string, ok: string) => {
    void writeText(text)
      .then(() => pushToast("success", ok))
      .catch(() => pushToast("error", "복사에 실패했습니다"));
    setMenu(null);
  };

  // 메뉴 대상에서 각 작업 가능한 경로 집합(빈 작업은 메뉴에 표시 안 함).
  const menuStagePaths = [
    ...new Set(
      menuRows
        .filter((r) => !r.change.staged && r.change.kind !== "conflicted")
        .map((r) => r.change.path),
    ),
  ];
  const menuUnstagePaths = unstagePathsOf(menuRows);
  const menuDiscParts = discardPartsOf(menuRows);
  const menuCanDiscard =
    menuDiscParts.tracked.length > 0 || menuDiscParts.untracked.length > 0;

  const actions: RowActions = {
    onToggleStage: (change) => {
      if (change.staged) unstage.mutate([change.path]);
      else stage.mutate([change.path]);
    },
    onDiscard: (change) => {
      const untracked = change.kind === "untracked";
      const run = () =>
        discard.mutate(
          untracked
            ? { tracked: [], untracked: [change.path] }
            : { tracked: [change.path], untracked: [] },
        );
      // 설정에서 확인을 끄면 바로 실행 (기본은 확인 — 설계 §11)
      if (settings?.confirmDiscard === false) {
        run();
        return;
      }
      useUi.getState().askConfirm({
        title: untracked ? "파일 삭제" : "변경 되돌리기",
        message: untracked
          ? `'${change.path}' 은(는) 추적되지 않는 파일입니다. 삭제하면 복구할 수 없습니다.`
          : `'${change.path}' 의 저장되지 않은 변경을 되돌립니다. 복구할 수 없습니다.`,
        confirmLabel: untracked ? "삭제" : "되돌리기",
        danger: true,
        onConfirm: run,
      });
    },
  };

  return (
    <>
      {/* 멀티선택 액션 바 — 실제 존재하는 선택 행이 있을 때만(상태 갱신으로 사라진 키는 무시). */}
      {selectedRows.length > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-edge bg-raised px-3 py-1.5 text-xs">
          <span className="text-fg-muted">{selectedRows.length}개 선택</span>
          <div className="flex-1" />
          <button
            onClick={() => {
              stage.mutate(stagePaths);
              clearSel();
            }}
            disabled={stagePaths.length === 0}
            className="rounded px-2 py-0.5 text-fg-muted hover:bg-edge hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            스테이지
          </button>
          <button
            onClick={() => {
              unstage.mutate(unstagePaths);
              clearSel();
            }}
            disabled={unstagePaths.length === 0}
            className="rounded px-2 py-0.5 text-fg-muted hover:bg-edge hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            언스테이지
          </button>
          <button
            onClick={() => discardRows(selectedRows)}
            title="선택 항목의 워크트리 변경 되돌리기"
            className="flex items-center gap-1 rounded bg-danger/15 px-2 py-0.5 text-danger hover:bg-danger/25"
          >
            <RotateCcw size={12} />
            롤백
          </button>
          <button
            onClick={clearSel}
            title="선택 해제"
            className="rounded p-0.5 text-fg-dim hover:bg-edge hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {groups.map((g) => (
        <Group
          key={g.title}
          title={g.title}
          changes={g.changes}
          accent={g.accent}
          mode={g.mode}
          selectedDiff={activeDiff}
          selKeys={selKeys}
          onRowClick={onRowClick}
          onRowContextMenu={onRowContextMenu}
          actions={actions}
          collapsed={collapsed.has(g.title)}
          onToggleCollapse={() => toggleCollapse(g.title)}
        />
      ))}

      {menu && menuChange && (
        <div
          className="fixed z-50 max-h-[80vh] min-w-44 overflow-y-auto rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
          style={
            menu.y > window.innerHeight / 2
              ? {
                  left: Math.min(menu.x, window.innerWidth - 200),
                  bottom: window.innerHeight - menu.y,
                }
              : {
                  left: Math.min(menu.x, window.innerWidth - 200),
                  top: menu.y,
                }
          }
          onClick={(e) => e.stopPropagation()}
        >
          {menuRows.length > 1 && (
            <div className="px-3 py-1 text-[11px] text-fg-dim">
              {menuRows.length}개 선택
            </div>
          )}
          {menuCanDiscard ? (
            <MenuBtn
              icon={RotateCcw}
              label={menuRows.length > 1 ? "선택 롤백" : "롤백 (되돌리기)"}
              danger
              onClick={() => {
                discardRows(menuRows);
                setMenu(null);
              }}
            />
          ) : (
            <div className="px-3 py-1.5 text-fg-dim">롤백할 변경 없음</div>
          )}
          {menuStagePaths.length > 0 && (
            <MenuBtn
              icon={Plus}
              label="스테이지"
              onClick={() => {
                stage.mutate(menuStagePaths);
                clearSel();
                setMenu(null);
              }}
            />
          )}
          {menuUnstagePaths.length > 0 && (
            <MenuBtn
              icon={Undo2}
              label="스테이지 해제"
              onClick={() => {
                unstage.mutate(menuUnstagePaths);
                clearSel();
                setMenu(null);
              }}
            />
          )}
          <div className="my-1 border-t border-edge/60" />
          <MenuBtn
            icon={Copy}
            label="경로 복사"
            onClick={() => copyText(menuChange.path, "경로를 복사했습니다")}
          />
          <MenuBtn
            icon={Copy}
            label="이름 복사"
            onClick={() =>
              copyText(
                menuChange.path.split("/").pop() ?? menuChange.path,
                "파일 이름을 복사했습니다",
              )
            }
          />
        </div>
      )}
    </>
  );
}

/**
 * 임베디드(중첩) 저장소 섹션 — 폴더 경로 + 자체 branch 뱃지 헤더 + 접기. 펼치면 그 저장소의
 * 변경 목록(RepoChanges)과 전용 커밋 폼(CommitForm)을 보여준다. 조작은 모두 합성 id로 그
 * 저장소에 라우팅된다. 변경이 없는 임베디드 저장소는 기본 접힘(정보만 노출, 잡음 최소화).
 */
function NestedRepoSection({
  nested,
  outerProjectId,
}: {
  nested: RepoStatus;
  outerProjectId: string;
}) {
  const count = changeCount(nested);
  const hasChanges = count > 0;
  const [open, setOpen] = useState(hasChanges);
  // 처음엔 깨끗해서 접혀 있던 섹션도 이후 변경이 생기면 자동으로 펼친다(useState 초기값은 마운트
  // 시 1회만 적용되므로). count>0 전이에만 반응하므로, 사용자가 수동으로 접은 건 그대로 존중된다.
  useEffect(() => {
    if (hasChanges) setOpen(true);
  }, [hasChanges]);
  const label = nested.relPath ?? nested.projectId;
  const branch =
    nested.branch ?? (nested.detachedSha ? `@ ${nested.detachedSha}` : null);

  return (
    <div className="border-t border-edge/60">
      <button
        onClick={() => setOpen((v) => !v)}
        title={label}
        className="flex w-full items-center gap-1.5 bg-raised/40 px-2 py-1.5 text-left hover:bg-raised"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-fg-dim" />
        )}
        <FolderGit2 size={13} className="shrink-0 text-accent" />
        <span className="truncate text-[12px] font-medium text-fg">{label}</span>
        {branch && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-base px-1.5 py-0.5 text-[10px] text-fg-muted">
            <GitBranch size={9} />
            {branch}
          </span>
        )}
        <span className="ml-auto shrink-0 pr-1 text-[11px] text-fg-dim">
          {nested.error ? "오류" : count > 0 ? `${count}` : "깨끗함"}
        </span>
      </button>
      {open &&
        (nested.error ? (
          <div className="px-3 py-2 text-xs leading-5 text-fg-dim">
            {nested.error}
          </div>
        ) : count === 0 ? (
          <div className="px-3 py-2 text-xs text-fg-dim">
            변경 없음 — 워킹 트리가 깨끗합니다
          </div>
        ) : (
          <>
            <RepoChanges
              projectId={nested.projectId}
              outerProjectId={outerProjectId}
            />
            <CommitForm projectId={nested.projectId} bindShortcut={false} />
          </>
        ))}
    </div>
  );
}

export function ChangesPanel({ projectId }: { projectId: string }) {
  const { data: statuses } = useStatuses();
  const status = statuses?.find((s) => s.projectId === projectId);
  // 이 프로젝트에 속한 임베디드 저장소들 — 상대경로 순으로 안정 정렬.
  const nested = (statuses ?? [])
    .filter((s) => s.parentId === projectId)
    .sort((a, b) => (a.relPath ?? "").localeCompare(b.relPath ?? ""));

  const { width, startResize } = usePanelWidth("gp:changes-width", 288, 220, 680);

  const outerTotal = status ? changeCount(status) : 0;
  const nestedTotal = nested.reduce((n, s) => n + changeCount(s), 0);
  const total = outerTotal + nestedTotal;
  // 최상위·임베디드 모두 변경이 없고 임베디드 저장소 자체도 없을 때만 "변경 없음".
  const isEmpty = status && !status.error && total === 0 && nested.length === 0;

  return (
    <div
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="font-semibold">Changes</span>
        <span className="text-xs text-fg-dim">
          {status ? `${total} files` : "…"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {status?.error ? (
          <div className="px-3 py-3 text-xs leading-5 text-fg-dim">
            {status.error}
          </div>
        ) : isEmpty ? (
          <div className="px-3 py-3 text-xs text-fg-dim">
            변경 없음 — 워킹 트리가 깨끗합니다 ✨
          </div>
        ) : status ? (
          <>
            <RepoChanges projectId={projectId} outerProjectId={projectId} />
            {nested.map((n) => (
              <NestedRepoSection
                key={n.projectId}
                nested={n}
                outerProjectId={projectId}
              />
            ))}
          </>
        ) : null}
      </div>

      <CommitForm projectId={projectId} />
      <ResizeHandle onMouseDown={startResize} />
    </div>
  );
}
