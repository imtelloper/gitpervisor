import {
  ChevronDown,
  ChevronRight,
  Database,
  Leaf,
  Loader2,
  Pencil,
  Plus,
  Table2,
  Unplug,
} from "lucide-react";

import type { DbConnection, DbEngine } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import { useDbConnections, useDbDatabases, useDbTables } from "../../queries";
import { dbKey, useDb } from "../../stores/db";
import { ResizeHandle } from "../common/ResizeHandle";

function EngineIcon({ engine }: { engine: DbEngine }) {
  if (engine === "mongodb")
    return <Leaf size={13} className="shrink-0 text-add" />;
  return <Database size={13} className="shrink-0 text-mod" />;
}

function CollNode({
  connId,
  database,
  coll,
}: {
  connId: string;
  database: string;
  coll: string;
}) {
  const openCollection = useDb((s) => s.openCollection);
  return (
    <div
      onClick={() => void openCollection(connId, database, coll)}
      style={{ paddingLeft: 42 }}
      title={coll}
      className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-2 hover:bg-raised"
    >
      <Table2 size={13} className="shrink-0 text-fg-dim" />
      <span>{coll}</span>
    </div>
  );
}

function DatabaseNode({ connId, database }: { connId: string; database: string }) {
  const expanded = useDb((s) => s.expandedDbs.includes(dbKey(connId, database)));
  const toggleDb = useDb((s) => s.toggleDb);
  const { data: tables, isLoading } = useDbTables(connId, database, expanded);

  return (
    <>
      <div
        onClick={() => toggleDb(connId, database)}
        style={{ paddingLeft: 24 }}
        className="flex cursor-pointer items-center gap-1 whitespace-nowrap py-0.5 pr-2 hover:bg-raised"
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-fg-dim" />
        )}
        <Database size={12} className="shrink-0 text-fg-dim" />
        <span>{database}</span>
      </div>
      {expanded &&
        (isLoading ? (
          <div style={{ paddingLeft: 42 }} className="py-0.5 text-xs text-fg-dim">
            …
          </div>
        ) : (
          tables?.map((t) => (
            <CollNode key={t} connId={connId} database={database} coll={t} />
          ))
        ))}
    </>
  );
}

function ConnNode({ conn }: { conn: DbConnection }) {
  const expanded = useDb((s) => s.expandedConns.includes(conn.id));
  const connecting = useDb((s) => s.connectingIds.includes(conn.id));
  const connected = useDb((s) => s.connectedIds.includes(conn.id));
  const toggleConn = useDb((s) => s.toggleConn);
  const openDialog = useDb((s) => s.openDialog);
  const disconnect = useDb((s) => s.disconnect);
  const { data: databases, isLoading } = useDbDatabases(
    conn.id,
    expanded && connected,
  );

  return (
    <>
      <div
        onClick={() => void toggleConn(conn.id)}
        title={`${conn.host}:${conn.port}`}
        className="group flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-2 py-1 hover:bg-raised"
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-fg-dim" />
        )}
        <EngineIcon engine={conn.engine} />
        <span className="font-medium">{conn.name}</span>
        {connecting && <Loader2 size={12} className="animate-spin text-fg-dim" />}
        {connected && !connecting && (
          <span className="h-1.5 w-1.5 rounded-full bg-ok" title="연결됨" />
        )}
        <div className="ml-auto flex items-center opacity-0 group-hover:opacity-100">
          {connected && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void disconnect(conn.id);
              }}
              title="연결 끊기"
              className="rounded p-0.5 text-fg-dim hover:bg-edge hover:text-fg"
            >
              <Unplug size={12} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              openDialog(conn);
            }}
            title="연결 편집"
            className="rounded p-0.5 text-fg-dim hover:bg-edge hover:text-fg"
          >
            <Pencil size={12} />
          </button>
        </div>
      </div>
      {expanded &&
        connected &&
        (isLoading ? (
          <div style={{ paddingLeft: 24 }} className="py-0.5 text-xs text-fg-dim">
            데이터베이스 불러오는 중…
          </div>
        ) : (
          databases?.map((db) => (
            <DatabaseNode key={db} connId={conn.id} database={db} />
          ))
        ))}
    </>
  );
}

export function DbSidebar() {
  const { data: connections } = useDbConnections();
  const openDialog = useDb((s) => s.openDialog);
  const { width, startResize } = usePanelWidth("gp:db-sidebar-width", 260, 180, 480);

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-edge bg-panel"
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className="text-[11px] font-semibold tracking-widest text-fg-dim">
          CONNECTIONS
        </span>
        <button
          onClick={() => openDialog("new")}
          title="연결 추가"
          className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto text-[13px]">
        {connections?.map((c) => <ConnNode key={c.id} conn={c} />)}
        {connections && connections.length === 0 && (
          <div className="px-3 py-4 text-xs leading-5 text-fg-dim">
            연결이 없습니다.
            <br />위 + 버튼으로 DB를 추가하세요.
          </div>
        )}
      </div>

      <ResizeHandle onMouseDown={startResize} />
    </aside>
  );
}
