import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { fileIcon, folderIcon } from "../../lib/file-icon";
import type { DirEntry } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import { useDir } from "../../queries";
import { useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

const INDENT = 12;

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
  const { Icon, color } = fileIcon(name);
  const selected =
    selectedDiff?.mode === "worktree" && selectedDiff.path === path;

  return (
    <div
      onClick={() => selectDiff({ mode: "worktree", path })}
      title={path}
      style={{ paddingLeft: depth * INDENT + 8 }}
      className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-3 ${
        selected ? "bg-selection" : "hover:bg-raised"
      } ${isIgnored ? "italic text-fg-dim" : ""}`}
    >
      <span className="w-[13px] shrink-0" />
      <Icon size={14} color={color} className="shrink-0" />
      <span>{name}</span>
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
  return (
    <>
      <div
        onClick={() => setExpanded((e) => !e)}
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
        <span className="font-medium">{entry.name}</span>
      </div>
      {expanded && <DirChildren projectId={projectId} path={path} depth={depth + 1} />}
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

/** 선택 프로젝트의 전체 파일 트리 (지연 로딩). 파일 클릭 → 중앙 뷰어에 내용/diff. */
export function FileTreePanel({ projectId }: { projectId: string }) {
  const { width, startResize } = usePanelWidth("gp:filetree-width", 260, 180, 520);

  return (
    <div
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="font-semibold">Files</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-[13px]">
        <div key={projectId} className="w-max min-w-full">
          <DirChildren projectId={projectId} path="" depth={0} />
        </div>
      </div>
      <ResizeHandle onMouseDown={startResize} />
    </div>
  );
}
