import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderPlus,
  Trash2,
} from "lucide-react";

import { methodColor } from "../../lib/method-color";
import { usePanelWidth } from "../../lib/use-panel-width";
import type { ApiNode } from "../../stores/apiclient";
import { useApiClient } from "../../stores/apiclient";
import { useUi } from "../../stores/ui";
import { ResizeHandle } from "../common/ResizeHandle";

/** 컬렉션 트리 노드(폴더/요청) — DbSidebar ConnNode/CollNode 미러. depth*16 패딩. */
function TreeNode({
  nodeId,
  depth,
  tabId,
}: {
  nodeId: string;
  depth: number;
  tabId: string;
}) {
  const node = useApiClient((s) => s.nodes[nodeId]) as ApiNode | undefined;
  const expanded = useApiClient((s) => s.expandedFolders.includes(nodeId));
  const activeReqId = useApiClient((s) => s.items[tabId]?.requestNodeId ?? null);
  const toggleFolder = useApiClient((s) => s.toggleFolder);
  const selectRequest = useApiClient((s) => s.selectRequest);
  const addFolder = useApiClient((s) => s.addFolder);
  const addRequest = useApiClient((s) => s.addRequest);
  const removeNode = useApiClient((s) => s.removeNode);
  const askConfirm = useUi((s) => s.askConfirm);

  if (!node) return null;
  const pad = 8 + depth * 16;

  if (node.kind === "folder") {
    return (
      <>
        <div
          className="group flex items-center gap-1 whitespace-nowrap py-0.5 pr-2 hover:bg-raised"
          style={{ paddingLeft: pad }}
        >
          <button
            onClick={() => toggleFolder(nodeId)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-fg-muted hover:text-fg"
          >
            {expanded ? (
              <ChevronDown size={12} className="shrink-0" />
            ) : (
              <ChevronRight size={12} className="shrink-0" />
            )}
            <span className="truncate text-[13px]">{node.name}</span>
          </button>
          <button
            onClick={() => {
              const nid = addRequest(nodeId, {});
              selectRequest(tabId, nid); // 새 요청을 빌더에 바로 로드(편집 시작점)
              if (!expanded) toggleFolder(nodeId); // 접혀 있으면 펼쳐서 보이게
            }}
            title="요청 추가"
            className="shrink-0 text-fg-dim opacity-0 hover:text-fg group-hover:opacity-100"
          >
            <FilePlus2 size={12} />
          </button>
          <button
            onClick={() => addFolder(nodeId, "새 폴더")}
            title="폴더 추가"
            className="shrink-0 text-fg-dim opacity-0 hover:text-fg group-hover:opacity-100"
          >
            <FolderPlus size={12} />
          </button>
          <button
            onClick={() =>
              askConfirm({
                title: "폴더 삭제",
                message: `"${node.name}" 폴더와 하위 항목을 삭제할까요?`,
                confirmLabel: "삭제",
                danger: true,
                onConfirm: () => removeNode(nodeId),
              })
            }
            title="삭제"
            className="shrink-0 text-fg-dim opacity-0 hover:text-danger group-hover:opacity-100"
          >
            <Trash2 size={12} />
          </button>
        </div>
        {expanded &&
          node.childIds.map((cid) => (
            <TreeNode key={cid} nodeId={cid} depth={depth + 1} tabId={tabId} />
          ))}
      </>
    );
  }

  // request 노드
  const req = node.request;
  const active = activeReqId === nodeId;
  return (
    <div
      className={`group flex items-center gap-1.5 whitespace-nowrap py-0.5 pr-2 hover:bg-raised ${
        active ? "bg-raised" : ""
      }`}
      style={{ paddingLeft: pad + 16 }}
    >
      <button
        onClick={() => selectRequest(tabId, nodeId)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span
          className={`shrink-0 font-mono text-[10px] font-semibold ${methodColor(
            req.method,
          )}`}
        >
          {req.method}
        </span>
        <span className="truncate text-[13px] text-fg">{req.name}</span>
      </button>
      <button
        onClick={() =>
          askConfirm({
            title: "요청 삭제",
            message: `"${req.name}" 요청을 삭제할까요?`,
            confirmLabel: "삭제",
            danger: true,
            onConfirm: () => removeNode(nodeId),
          })
        }
        title="삭제"
        className="shrink-0 text-fg-dim opacity-0 hover:text-danger group-hover:opacity-100"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** 하단 HISTORY 섹션(§8.1) — DbSidebar MetaSection 패턴. */
function HistorySection({ projectId }: { projectId: string }) {
  const history = useApiClient((s) => s.history);
  void projectId;

  return (
    <div className="shrink-0 border-t border-edge">
      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-widest text-fg-dim">
        HISTORY
      </div>
      <div className="max-h-40 overflow-auto pb-2">
        {history.length === 0 && (
          <div className="px-3 py-1 text-[12px] text-fg-dim">기록 없음</div>
        )}
        {history.map((h) => (
          <div
            key={h.id}
            title={`${h.method} ${h.url}`}
            className="flex items-center gap-1.5 whitespace-nowrap px-3 py-0.5 text-[12px] hover:bg-raised"
          >
            <span
              className={`shrink-0 font-mono text-[10px] font-semibold ${methodColor(
                h.method,
              )}`}
            >
              {h.method}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">{h.url}</span>
            <span
              className={`shrink-0 text-[10px] ${
                h.status >= 200 && h.status < 400
                  ? "text-ok"
                  : "text-danger"
              }`}
            >
              {h.status || "ERR"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 컬렉션 사이드바(§8.5) — DbSidebar aside 골격 미러 + 하단 HISTORY + ResizeHandle. */
export function CollectionSidebar({
  tabId,
  projectId,
}: {
  tabId: string;
  projectId: string;
}) {
  const rootIds = useApiClient((s) => s.rootIds);
  const addFolder = useApiClient((s) => s.addFolder);
  const addRequest = useApiClient((s) => s.addRequest);
  const selectRequest = useApiClient((s) => s.selectRequest);
  const { width, startResize } = usePanelWidth(
    "gp:apiclient-sidebar-width",
    240,
    180,
    480,
  );

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className="text-[11px] font-semibold tracking-widest text-fg-dim">
          COLLECTIONS
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => selectRequest(tabId, addRequest(null, {}))}
            title="요청 추가"
            className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <FilePlus2 size={14} />
          </button>
          <button
            onClick={() => addFolder(null, "새 컬렉션")}
            title="컬렉션(폴더) 추가"
            className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rootIds.map((id) => (
          <TreeNode key={id} nodeId={id} depth={0} tabId={tabId} />
        ))}
        {rootIds.length === 0 && (
          <div className="px-3 py-4 text-xs leading-5 text-fg-dim">
            저장된 요청이 없습니다.
            <br />위 버튼으로 요청/컬렉션을 추가하세요.
          </div>
        )}
      </div>

      <HistorySection projectId={projectId} />

      <ResizeHandle onMouseDown={startResize} />
    </aside>
  );
}
