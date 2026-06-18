import { ChevronDown, ChevronRight, Copy, Link, Type } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { fileIcon, folderIcon } from "../../lib/file-icon";
import type { ChangeKind, DirEntry, FileChange, RepoStatus } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import { useDir, useProjects, useStatus } from "../../queries";
import { useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

const INDENT = 12;

// ── git 변경 색상 (JetBrains 컨벤션: 수정=파랑, 추가=초록, 삭제=회색, untracked=빨강) ──
function colorClassOf(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return "text-add";
    case "deleted":
      return "text-del";
    case "conflicted":
      return "text-danger";
    case "untracked":
      return "text-untrk";
    default:
      return "text-mod"; // modified / renamed / typechange
  }
}

interface TreeStatus {
  /** repo-상대 경로 → 변경 종류 */
  fileKind: Map<string, ChangeKind>;
  /** 하위에 변경이 있는 디렉토리(repo-상대 경로) */
  dirChanged: Set<string>;
}

/** RepoStatus → 파일/디렉토리 변경 맵. 우선순위: untracked < staged < unstaged < conflicted. */
function buildTreeStatus(status: RepoStatus | undefined): TreeStatus {
  const fileKind = new Map<string, ChangeKind>();
  const dirChanged = new Set<string>();
  if (status) {
    const apply = (changes: FileChange[]) => {
      for (const c of changes) {
        fileKind.set(c.path, c.kind);
        // 조상 디렉토리를 모두 "변경 포함"으로 표시
        let idx = c.path.lastIndexOf("/");
        while (idx > 0) {
          dirChanged.add(c.path.slice(0, idx));
          idx = c.path.lastIndexOf("/", idx - 1);
        }
      }
    };
    apply(status.untracked);
    apply(status.staged);
    apply(status.unstaged);
    apply(status.conflicted);
  }
  return { fileKind, dirChanged };
}

const TreeStatusCtx = createContext<TreeStatus | null>(null);

interface TreeMenu {
  x: number;
  y: number;
  path: string;
  name: string;
}
const TreeMenuCtx = createContext<(m: TreeMenu) => void>(() => {});

function FileRow({
  name,
  path,
  isIgnored,
  depth,
}: {
  name: string;
  path: string;
  isIgnored: boolean;
  depth: number;
}) {
  const selectedDiff = useUi((s) => s.selectedDiff);
  const selectDiff = useUi((s) => s.selectDiff);
  const ts = useContext(TreeStatusCtx);
  const openMenu = useContext(TreeMenuCtx);
  const { Icon, color } = fileIcon(name);
  const selected = selectedDiff?.mode === "file" && selectedDiff.path === path;
  const kind = ts?.fileKind.get(path);
  const nameColor = kind ? colorClassOf(kind) : "";

  return (
    <div
      onClick={() => selectDiff({ mode: "file", path })}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY, path, name });
      }}
      title={path}
      style={{ paddingLeft: depth * INDENT + 8 }}
      className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-3 ${
        selected ? "bg-selection" : "hover:bg-raised"
      } ${isIgnored ? "italic text-fg-dim" : ""}`}
    >
      <span className="w-[13px] shrink-0" />
      <Icon size={14} color={color} className="shrink-0" />
      <span className={nameColor}>{name}</span>
    </div>
  );
}

function TreeNode({
  projectId,
  entry,
  path,
  depth,
}: {
  projectId: string;
  entry: DirEntry;
  path: string;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const ts = useContext(TreeStatusCtx);
  const openMenu = useContext(TreeMenuCtx);

  if (!entry.isDir) {
    return (
      <FileRow
        name={entry.name}
        path={path}
        isIgnored={entry.isIgnored}
        depth={depth}
      />
    );
  }

  const { Icon, color } = folderIcon(expanded);
  const dirHasChanges = !entry.isIgnored && ts?.dirChanged.has(path);
  return (
    <>
      <div
        onClick={() => setExpanded((e) => !e)}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY, path, name: entry.name });
        }}
        title={path}
        style={{ paddingLeft: depth * INDENT + 8 }}
        className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-3 hover:bg-raised ${
          entry.isIgnored ? "italic text-fg-dim" : ""
        }`}
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-fg-dim" />
        )}
        <Icon size={14} color={color} className="shrink-0" />
        <span className={`font-medium ${dirHasChanges ? "text-mod" : ""}`}>
          {entry.name}
        </span>
      </div>
      {expanded && (
        <DirChildren projectId={projectId} path={path} depth={depth + 1} />
      )}
    </>
  );
}

function DirChildren({
  projectId,
  path,
  depth,
}: {
  projectId: string;
  path: string;
  depth: number;
}) {
  const { data, isLoading, error } = useDir(projectId, path);
  const pad = { paddingLeft: depth * INDENT + 24 };

  if (isLoading)
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-dim">
        …
      </div>
    );
  if (error)
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-dim">
        불러오지 못함
      </div>
    );
  if (!data || data.length === 0)
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-dim">
        비어 있음
      </div>
    );

  return (
    <>
      {data.map((e) => (
        <TreeNode
          key={e.name}
          projectId={projectId}
          entry={e}
          path={joinPath(path, e.name)}
          depth={depth}
        />
      ))}
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </button>
  );
}

/** 선택 프로젝트의 전체 파일 트리 (지연 로딩). 파일 클릭 → 중앙 뷰어에 내용/diff. */
export function FileTreePanel({ projectId }: { projectId: string }) {
  const { width, startResize } = usePanelWidth("gp:filetree-width", 260, 180, 520);
  const { data: status } = useStatus(projectId);
  const { data: projects } = useProjects();
  const pushToast = useUi((s) => s.pushToast);

  const projectPath = projects?.find((p) => p.id === projectId)?.path ?? "";
  const treeStatus = useMemo(() => buildTreeStatus(status), [status]);

  const [menu, setMenu] = useState<TreeMenu | null>(null);

  // 메뉴 열림 동안 바깥 클릭 / Esc 로 닫는다 (ProjectList와 동일 패턴)
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

  // 윈도우는 역슬래시, 그 외 슬래시 — project.path 형식을 따른다.
  const sep = projectPath.includes("\\") ? "\\" : "/";
  const toOsPath = (rel: string) => rel.split("/").join(sep);
  const absOf = (rel: string) =>
    projectPath ? `${projectPath}${sep}${toOsPath(rel)}` : toOsPath(rel);

  function copy(text: string, ok: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => pushToast("success", ok))
      .catch(() => pushToast("error", "복사에 실패했습니다"));
    setMenu(null);
  }

  return (
    <div
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="font-semibold">Files</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-[13px]">
        <TreeStatusCtx.Provider value={treeStatus}>
          <TreeMenuCtx.Provider value={setMenu}>
            <div key={projectId} className="w-max min-w-full">
              <DirChildren projectId={projectId} path="" depth={0} />
            </div>
          </TreeMenuCtx.Provider>
        </TreeStatusCtx.Provider>
      </div>
      <ResizeHandle onMouseDown={startResize} />

      {menu && (
        <div
          className="fixed z-50 min-w-48 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 110),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={Copy}
            label="경로 복사"
            onClick={() => copy(absOf(menu.path), "경로를 복사했습니다")}
          />
          <MenuItem
            icon={Link}
            label="상대 경로 복사"
            onClick={() => copy(toOsPath(menu.path), "상대 경로를 복사했습니다")}
          />
          <MenuItem
            icon={Type}
            label="이름 복사"
            onClick={() => copy(menu.name, "파일 이름을 복사했습니다")}
          />
        </div>
      )}
    </div>
  );
}
