import {
  ChevronDown,
  ChevronRight,
  Cog,
  Columns3,
  Database,
  KeyRound,
  Leaf,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Table2,
  Unplug,
  Zap,
} from "lucide-react";
import { useState } from "react";

import type { DbConnection, DbEngine } from "../../lib/ipc";
import { usePanelWidth } from "../../lib/use-panel-width";
import {
  useDbConnections,
  useDbDatabases,
  useDbProcedures,
  useDbTables,
  useTableMeta,
} from "../../queries";
import { dbKey, useDb } from "../../stores/db";
import { ResizeHandle } from "../common/ResizeHandle";

function EngineIcon({ engine }: { engine: DbEngine }) {
  if (engine === "mongodb")
    return <Leaf size={13} className="shrink-0 text-add" />;
  return <Database size={13} className="shrink-0 text-mod" />;
}

function MetaRow({
  pad,
  title,
  children,
}: {
  pad: number;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ paddingLeft: pad }}
      title={title}
      className="flex items-center gap-1.5 whitespace-nowrap py-0.5 pr-2 text-[12px]"
    >
      {children}
    </div>
  );
}

/** 컬럼/키/인덱스 하위 그룹 — 접을 수 있음. */
function MetaSection({
  pad,
  icon,
  label,
  count,
  children,
}: {
  pad: number;
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: pad }}
        className="flex cursor-pointer items-center gap-1 whitespace-nowrap py-0.5 pr-2 text-fg-dim hover:bg-raised"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0" />
        ) : (
          <ChevronRight size={11} className="shrink-0" />
        )}
        {icon}
        <span>
          {label} ({count})
        </span>
      </div>
      {open && children}
    </>
  );
}

/** SQL 테이블 노드 — 펼치면 컬럼/키/인덱스(오브젝트 탐색기). 이름 클릭 = 데이터 미리보기. */
function SqlTableNode({
  connId,
  database,
  coll,
  engine,
}: {
  connId: string;
  database: string;
  coll: string;
  engine: DbEngine;
}) {
  const [open, setOpen] = useState(false);
  const openCollection = useDb((s) => s.openCollection);
  const { data: meta, isLoading } = useTableMeta(connId, database, coll, open);
  return (
    <>
      <div
        style={{ paddingLeft: 28 }}
        className="flex items-center gap-1 whitespace-nowrap py-0.5 pr-2 hover:bg-raised"
      >
        <button
          onClick={() => setOpen((o) => !o)}
          title="컬럼/키/인덱스"
          className="shrink-0 text-fg-dim hover:text-fg"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div
          onClick={() => void openCollection(connId, database, coll, engine)}
          title={`${coll} — 클릭: 데이터 미리보기`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
        >
          <Table2 size={13} className="shrink-0 text-fg-dim" />
          <span className="truncate">{coll}</span>
        </div>
      </div>
      {open &&
        (isLoading ? (
          <div style={{ paddingLeft: 48 }} className="py-0.5 text-xs text-fg-dim">
            …
          </div>
        ) : meta ? (
          <>
            <MetaSection
              pad={46}
              icon={<Columns3 size={12} className="shrink-0 text-fg-dim" />}
              label="Columns"
              count={meta.columns.length}
            >
              {meta.columns.map((c) => (
                <MetaRow key={c.name} pad={66} title={`${c.name} ${c.typeName}`}>
                  {c.pk && <KeyRound size={11} className="shrink-0 text-mod" />}
                  <span className={c.pk ? "text-fg" : ""}>{c.name}</span>
                  <span className="text-fg-dim">{c.typeName}</span>
                  {!c.nullable && (
                    <span className="text-[10px] text-fg-dim">NOT NULL</span>
                  )}
                </MetaRow>
              ))}
            </MetaSection>
            <MetaSection
              pad={46}
              icon={<KeyRound size={12} className="shrink-0 text-fg-dim" />}
              label="Keys"
              count={meta.keys.length}
            >
              {meta.keys.length === 0 ? (
                <MetaRow pad={66}>
                  <span className="text-fg-dim">없음</span>
                </MetaRow>
              ) : (
                meta.keys.map((k) => (
                  <MetaRow key={k.name} pad={66} title={k.name}>
                    <span className="text-mod">
                      {k.kind === "PRIMARY KEY"
                        ? "PK"
                        : k.kind === "FOREIGN KEY"
                          ? "FK"
                          : "UQ"}
                    </span>
                    <span>{k.columns.join(", ")}</span>
                    {k.references && (
                      <span className="text-fg-dim">→ {k.references}</span>
                    )}
                  </MetaRow>
                ))
              )}
            </MetaSection>
            <MetaSection
              pad={46}
              icon={<ListTree size={12} className="shrink-0 text-fg-dim" />}
              label="Indexes"
              count={meta.indexes.length}
            >
              {meta.indexes.length === 0 ? (
                <MetaRow pad={66}>
                  <span className="text-fg-dim">없음</span>
                </MetaRow>
              ) : (
                meta.indexes.map((i) => (
                  <MetaRow key={i.name} pad={66} title={i.name}>
                    <span>{i.columns.join(", ")}</span>
                    <span className="text-[10px] text-fg-dim">
                      {i.unique ? "UNIQUE " : ""}
                      {i.kind}
                    </span>
                  </MetaRow>
                ))
              )}
            </MetaSection>
            <MetaSection
              pad={46}
              icon={<ShieldCheck size={12} className="shrink-0 text-fg-dim" />}
              label="Constraints"
              count={meta.constraints.length}
            >
              {meta.constraints.length === 0 ? (
                <MetaRow pad={66}>
                  <span className="text-fg-dim">없음</span>
                </MetaRow>
              ) : (
                meta.constraints.map((c) => (
                  <MetaRow
                    key={c.name}
                    pad={66}
                    title={`${c.name}: ${c.definition}`}
                  >
                    <span className="text-mod">
                      {c.kind === "DEFAULT" ? "DF" : "CK"}
                    </span>
                    {c.column && <span>{c.column}</span>}
                    <span className="truncate text-fg-dim">{c.definition}</span>
                  </MetaRow>
                ))
              )}
            </MetaSection>
            <MetaSection
              pad={46}
              icon={<Zap size={12} className="shrink-0 text-fg-dim" />}
              label="Triggers"
              count={meta.triggers.length}
            >
              {meta.triggers.length === 0 ? (
                <MetaRow pad={66}>
                  <span className="text-fg-dim">없음</span>
                </MetaRow>
              ) : (
                meta.triggers.map((t) => (
                  <MetaRow key={t.name} pad={66} title={t.name}>
                    <span className={t.disabled ? "text-fg-dim line-through" : ""}>
                      {t.name}
                    </span>
                    <span className="text-[10px] text-fg-dim">{t.events}</span>
                  </MetaRow>
                ))
              )}
            </MetaSection>
          </>
        ) : null)}
    </>
  );
}

function CollNode({
  connId,
  database,
  coll,
  engine,
}: {
  connId: string;
  database: string;
  coll: string;
  engine: DbEngine;
}) {
  const openCollection = useDb((s) => s.openCollection);
  // SQL 엔진은 테이블을 펼쳐 컬럼/키/인덱스 표시. Mongo는 단순 리프(클릭=쿼리).
  if (engine !== "mongodb") {
    return (
      <SqlTableNode
        connId={connId}
        database={database}
        coll={coll}
        engine={engine}
      />
    );
  }
  return (
    <div
      onClick={() => void openCollection(connId, database, coll, engine)}
      style={{ paddingLeft: 42 }}
      title={coll}
      className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-2 hover:bg-raised"
    >
      <Table2 size={13} className="shrink-0 text-fg-dim" />
      <span>{coll}</span>
    </div>
  );
}

function DatabaseNode({
  connId,
  database,
  engine,
}: {
  connId: string;
  database: string;
  engine: DbEngine;
}) {
  const expanded = useDb((s) => s.expandedDbs.includes(dbKey(connId, database)));
  const toggleDb = useDb((s) => s.toggleDb);
  const { data: tables, isLoading } = useDbTables(connId, database, expanded);

  return (
    <>
      <div
        onClick={() => toggleDb(connId, database, engine)}
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
            <CollNode
              key={t}
              connId={connId}
              database={database}
              coll={t}
              engine={engine}
            />
          ))
        ))}
      {expanded && engine !== "mongodb" && (
        <ProceduresGroup connId={connId} database={database} />
      )}
    </>
  );
}

/** 저장 프로시저 그룹 — 펼치면 목록, 클릭하면 EXEC 템플릿 생성. */
function ProceduresGroup({
  connId,
  database,
}: {
  connId: string;
  database: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: procs, isLoading } = useDbProcedures(connId, database, open);
  const openProc = useDb((s) => s.openProc);
  return (
    <>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: 28 }}
        className="flex cursor-pointer items-center gap-1 whitespace-nowrap py-0.5 pr-2 text-fg-dim hover:bg-raised"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0" />
        ) : (
          <ChevronRight size={12} className="shrink-0" />
        )}
        <Cog size={12} className="shrink-0" />
        <span>프로시저{procs ? ` (${procs.length})` : ""}</span>
      </div>
      {open &&
        (isLoading ? (
          <div style={{ paddingLeft: 46 }} className="py-0.5 text-xs text-fg-dim">
            …
          </div>
        ) : procs && procs.length === 0 ? (
          <div style={{ paddingLeft: 46 }} className="py-0.5 text-xs text-fg-dim">
            없음
          </div>
        ) : (
          procs?.map((p) => (
            <div
              key={p}
              onClick={() => void openProc(connId, database, p)}
              style={{ paddingLeft: 46 }}
              title={`${p} — 클릭: EXEC 템플릿 생성`}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap py-0.5 pr-2 hover:bg-raised"
            >
              <Cog size={13} className="shrink-0 text-fg-dim" />
              <span className="truncate">{p}</span>
            </div>
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
        onClick={() => void toggleConn(conn.id, conn.engine)}
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
            <DatabaseNode
              key={db}
              connId={conn.id}
              database={db}
              engine={conn.engine}
            />
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
