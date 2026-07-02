import { monaco } from "../diff/monaco-setup";

import { Editor } from "@monaco-editor/react";
import { Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isSqlEngine } from "../../lib/ipc";
import { monacoThemeOf } from "../../lib/themes";
import { useDbConnections, useSettings, useTableMeta } from "../../queries";
import { LIMIT_OPTIONS, useDb } from "../../stores/db";
import { useUi } from "../../stores/ui";
import { DbSidebar } from "./DbSidebar";

function QueryEditor() {
  const queryText = useDb((s) => s.queryText);
  const setQuery = useDb((s) => s.setQuery);
  const runQuery = useDb((s) => s.runQuery);
  const runExplain = useDb((s) => s.runExplain);
  const running = useDb((s) => s.running);
  const limit = useDb((s) => s.limit);
  const setLimit = useDb((s) => s.setLimit);
  const activeDatabase = useDb((s) => s.activeDatabase);
  const activeEngine = useDb((s) => s.activeEngine);
  const sql = isSqlEngine(activeEngine);
  const lang = sql ? "sql" : activeEngine === "redis" ? "plaintext" : "javascript";
  const dialect = sql ? "sql" : activeEngine === "redis" ? "redis" : "mongo-js";
  const { data: settings } = useSettings();
  const theme = monacoThemeOf(settings?.theme);

  return (
    <div className="flex h-[210px] shrink-0 flex-col border-b border-edge">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-xs text-fg-dim">
          {activeDatabase
            ? `${dialect} · ${activeDatabase}`
            : "왼쪽에서 DB를 선택하세요"}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-fg-dim">
          행
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            title="조회 행 수 제한"
            className="rounded border border-edge bg-base px-1 py-0.5 text-fg outline-none focus:border-accent"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {activeEngine === "mssql" && (
          <button
            onClick={() => void runExplain()}
            disabled={running || !activeDatabase}
            title="예상 실행 계획 (쿼리 미실행)"
            className="rounded border border-edge px-2 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
          >
            실행 계획
          </button>
        )}
        <button
          onClick={() => void runQuery()}
          disabled={running || !activeDatabase}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          <Play size={12} /> 실행{" "}
          <span className="font-mono opacity-70">Ctrl+↵</span>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          language={lang}
          value={queryText}
          onChange={(v) => setQuery(v ?? "")}
          theme={theme}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            lineNumbersMinChars: 3,
            fontFamily: '"Cascadia Code", Consolas, monospace',
            padding: { top: 8 },
          }}
          onMount={(editor) => {
            editor.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
              () => void useDb.getState().runQuery(),
            );
          }}
          loading={<span className="text-xs text-fg-dim">에디터 로딩 중…</span>}
        />
      </div>
    </div>
  );
}

/** "2020-01-02T03:04:05.123Z" → "2020-01-02 03:04:05" (저장된 UTC 그대로, 가독성만). */
function trimIso(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** relaxed 확장 JSON 단일 키 래퍼($oid·$date·$numberDecimal 등)를 읽기 좋은 값으로 푼다. */
function unwrapExtjson(
  v: Record<string, unknown>,
): { text: string; kind: "id" | "date" | "num"; title?: string } | null {
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const k = keys[0];
  const inner = v[k];
  switch (k) {
    case "$oid":
      return typeof inner === "string" ? { text: inner, kind: "id" } : null;
    case "$date": {
      if (typeof inner === "string")
        return { text: trimIso(inner), kind: "date", title: inner };
      // 범위 밖 날짜: {"$date":{"$numberLong":"ms"}}
      if (inner && typeof inner === "object" && "$numberLong" in inner) {
        const ms = Number((inner as Record<string, unknown>).$numberLong);
        if (!Number.isNaN(ms)) {
          const iso = new Date(ms).toISOString();
          return { text: trimIso(iso), kind: "date", title: iso };
        }
      }
      return null;
    }
    case "$numberDecimal":
    case "$numberLong":
    case "$numberInt":
      return typeof inner === "string" ? { text: inner, kind: "num" } : null;
    default:
      return null;
  }
}

function renderCell(v: unknown) {
  if (v === null || v === undefined)
    return <span className="text-fg-dim">null</span>;
  if (typeof v === "object") {
    const u = unwrapExtjson(v as Record<string, unknown>);
    if (u) {
      const cls =
        u.kind === "date" ? "text-add" : u.kind === "num" ? "text-mod" : "";
      return (
        <span className={cls} title={u.title}>
          {u.text}
        </span>
      );
    }
    return <span className="text-mod">{JSON.stringify(v)}</span>;
  }
  if (typeof v === "boolean")
    return <span className="text-add">{String(v)}</span>;
  if (typeof v === "number") return <span className="text-mod">{v}</span>;
  return <span>{String(v)}</span>;
}

/** 셀의 표시 문자열 — 컬럼 너비 측정용(renderCell과 동일한 텍스트). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") {
    const u = unwrapExtjson(v as Record<string, unknown>);
    return u ? u.text : JSON.stringify(v);
  }
  return String(v);
}

let measureCanvas: HTMLCanvasElement | null = null;
// 셀 폰트(ui-monospace)가 캔버스 폴백 폰트보다 넓을 수 있어 약간 키운다(잘림 방지).
const FONT_SAFETY = 1.1;
/** 컬럼명 + 모든 셀 텍스트의 최대 폭(px)으로 적정 너비 계산(패딩 여유 + 최소/최대 클램프). */
function measureColWidth(name: string, values: unknown[]): number {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return 160;
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  let max = ctx.measureText(name).width + 8; // 헤더 + 핸들 여백
  for (const v of values) {
    const w = ctx.measureText(cellText(v)).width;
    if (w > max) max = w;
  }
  // 안전 계수 + 좌우 패딩(px-2 = 16px) 여유
  return Math.min(600, Math.max(56, Math.ceil(max * FONT_SAFETY) + 22));
}

function Center({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div
      className={`flex h-full items-center justify-center px-6 text-center text-[13px] ${
        danger ? "text-danger" : "text-fg-dim"
      }`}
    >
      {children}
    </div>
  );
}

function ResultGrid() {
  const result = useDb((s) => s.result);
  const error = useDb((s) => s.resultError);
  const running = useDb((s) => s.running);
  const limit = useDb((s) => s.limit);
  const activeEngine = useDb((s) => s.activeEngine);
  const activeConnId = useDb((s) => s.activeConnId);
  const editTable = useDb((s) => s.editTable);
  const editPk = useDb((s) => s.editPk);
  const updateCell = useDb((s) => s.updateCell);
  const deleteRow = useDb((s) => s.deleteRow);
  const askConfirm = useUi((s) => s.askConfirm);
  const { data: connections } = useDbConnections();
  const [edit, setEdit] = useState<{
    row: number;
    col: number;
    value: string;
  } | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);

  // 콘텐츠 맞춤 자동 너비 — 결과가 바뀔 때만 재계산
  const autoWidths = useMemo(() => {
    const w: Record<string, number> = {};
    if (result) {
      result.columns.forEach((c, j) => {
        w[c.name] = measureColWidth(
          c.name,
          result.rows.map((r) => r[j]),
        );
      });
    }
    return w;
  }, [result]);

  // 드래그로 덮어쓴 너비 — 결과가 바뀌면 초기화
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  useEffect(() => setOverrides({}), [result]);

  if (running) return <Center>실행 중…</Center>;
  if (error) return <Center danger>{error}</Center>;
  if (!result) return <Center>컬렉션을 클릭하거나 쿼리를 실행하세요</Center>;
  if (result.rows.length === 0) return <Center>결과 없음</Center>;

  const widthOf = (name: string) => overrides[name] ?? autoWidths[name] ?? 160;

  // 편집 가능: SQL 테이블 미리보기 + PK 존재 + 읽기전용 아님
  const conn = connections?.find((c) => c.id === activeConnId);
  const editable =
    isSqlEngine(activeEngine) &&
    !!editTable &&
    !!editPk &&
    editPk.length > 0 &&
    !conn?.readOnly;
  const idxColW = editable ? 64 : 44;
  const total = idxColW + result.columns.reduce((s, c) => s + widthOf(c.name), 0);

  // 헤더 경계 드래그 → 해당 컬럼 너비 조절
  const startResize = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(name);
    const onMove = (ev: MouseEvent) =>
      setOverrides((o) => ({
        ...o,
        [name]: Math.max(48, startW + (ev.clientX - startX)),
      }));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // 더블클릭 → 최대값에 맞춰 자동 너비(수동 덮어쓰기 해제)
  const autoFit = (name: string) =>
    setOverrides((o) => {
      const n = { ...o };
      delete n[name];
      return n;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="table-fixed border-collapse text-[12px]"
          style={{ width: total }}
        >
          <colgroup>
            <col style={{ width: idxColW }} />
            {result.columns.map((c) => (
              <col key={c.name} style={{ width: widthOf(c.name) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel">
              <th className="border-b border-r border-edge px-2 py-1 text-left font-medium text-fg-dim">
                #
              </th>
              {result.columns.map((c) => (
                <th
                  key={c.name}
                  className="relative border-b border-r border-edge px-2 py-1 text-left font-medium text-fg-muted"
                >
                  <span className="block truncate" title={c.name}>
                    {c.name}
                  </span>
                  <div
                    onMouseDown={(e) => startResize(e, c.name)}
                    onDoubleClick={() => autoFit(c.name)}
                    title="드래그: 너비 조절 · 더블클릭: 자동 맞춤"
                    className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className="group hover:bg-raised/40">
                <td className="border-b border-r border-edge px-2 py-1 text-fg-dim">
                  <div className="flex items-center gap-1">
                    {editable && (
                      <button
                        onClick={() =>
                          askConfirm({
                            title: "행 삭제",
                            message: "이 행을 삭제할까요? 되돌릴 수 없습니다.",
                            confirmLabel: "삭제",
                            danger: true,
                            onConfirm: () => void deleteRow(i),
                          })
                        }
                        title="행 삭제"
                        className="text-fg-dim opacity-0 hover:text-danger group-hover:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    {i + 1}
                  </div>
                </td>
                {row.map((cell, j) => {
                  const colName = result.columns[j]?.name;
                  const isPk = editPk?.includes(colName) ?? false;
                  const cellEditable = editable && !isPk;
                  const isEditing = edit?.row === i && edit?.col === j;
                  return (
                    <td
                      key={j}
                      onDoubleClick={
                        cellEditable
                          ? () =>
                              setEdit({ row: i, col: j, value: cellText(cell) })
                          : undefined
                      }
                      title={cellEditable ? "더블클릭으로 편집" : undefined}
                      className={`truncate border-b border-r border-edge px-2 py-1 align-top font-mono ${
                        cellEditable ? "cursor-text" : ""
                      }`}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={edit.value}
                          onChange={(e) =>
                            setEdit({ row: i, col: j, value: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void updateCell(i, j, edit.value);
                              setEdit(null);
                            } else if (e.key === "Escape") setEdit(null);
                          }}
                          onBlur={() => setEdit(null)}
                          className="w-full bg-base px-0.5 text-fg outline outline-1 outline-accent"
                        />
                      ) : (
                        renderCell(cell)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-edge bg-panel px-3 py-1 text-[11px] text-fg-dim">
        {result.rowCount} docs · {result.columns.length} fields
        {result.rowCount >= limit && (
          <span className="ml-2 text-mod">
            · 상위 {limit}개만 표시 — 더 있을 수 있어요 (행 수를 늘려보세요)
          </span>
        )}
        {editable && (
          <>
            <span className="ml-2 text-fg-dim">· 셀 더블클릭 → 편집(Enter)</span>
            <button
              onClick={() => setInsertOpen(true)}
              className="ml-2 rounded border border-edge px-1.5 align-middle hover:bg-raised hover:text-fg"
            >
              <Plus size={11} className="inline" /> 행 추가
            </button>
          </>
        )}
      </div>
      {insertOpen && <InsertRowDialog onClose={() => setInsertOpen(false)} />}
    </div>
  );
}

/** 행 추가 폼 — non-identity 컬럼 입력. 비우면 nullable/기본값 컬럼은 생략. */
function InsertRowDialog({ onClose }: { onClose: () => void }) {
  const editTable = useDb((s) => s.editTable);
  const activeConnId = useDb((s) => s.activeConnId);
  const insertRow = useDb((s) => s.insertRow);
  const { data: meta } = useTableMeta(
    activeConnId ?? "",
    editTable?.database ?? "",
    editTable?.table ?? "",
    !!editTable && !!activeConnId,
  );
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!editTable) return null;
  const cols = (meta?.columns ?? []).filter((c) => !c.identity);

  const submit = async () => {
    const values = cols
      .filter((c) => {
        const v = vals[c.name];
        // 비웠고 NULL/기본값이 가능하면 생략
        return !((v === undefined || v === "") && (c.nullable || c.hasDefault));
      })
      .map((c) => ({ col: c.name, value: vals[c.name] ?? "" }));
    setBusy(true);
    try {
      await insertRow(values);
      onClose();
    } catch {
      /* 토스트로 안내 — 폼 유지 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[440px] overflow-auto rounded-lg border border-edge bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-semibold">행 추가 · {editTable.table}</div>
        <div className="space-y-2 text-[13px]">
          {!meta && <div className="text-fg-dim">컬럼 불러오는 중…</div>}
          {cols.map((c) => {
            const required = !c.nullable && !c.hasDefault;
            return (
              <label key={c.name} className="block">
                <div className="mb-0.5 flex items-center gap-1 text-[12px] text-fg-muted">
                  <span className={c.pk ? "text-mod" : ""}>{c.name}</span>
                  <span className="text-fg-dim">{c.typeName}</span>
                  {required && <span className="text-danger">*</span>}
                  {c.hasDefault && <span className="text-fg-dim">기본값</span>}
                </div>
                <input
                  value={vals[c.name] ?? ""}
                  onChange={(e) =>
                    setVals((v) => ({ ...v, [c.name]: e.target.value }))
                  }
                  placeholder={
                    c.nullable
                      ? "(비우면 NULL)"
                      : c.hasDefault
                        ? "(비우면 기본값)"
                        : ""
                  }
                  className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
                />
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-fg-muted hover:bg-raised"
          >
            취소
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !meta}
            className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "추가 중…" : "추가"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** DB 모드 워크스페이스 — 좌: 연결/스키마 트리 / 우: 쿼리 에디터 + 결과 그리드 (M6 §17). */
interface PlanNode {
  op: string;
  rows: string;
  cost: string;
  object: string | null;
  children: PlanNode[];
}

/** SQL Server ShowPlan XML → 연산자 트리. 기본 네임스페이스를 제거해 querySelector로 다룬다. */
function parsePlan(xml: string): PlanNode[] {
  const clean = xml.replace(/xmlns(:\w+)?="[^"]*"/g, "");
  const doc = new DOMParser().parseFromString(clean, "application/xml");
  const childRelOps = (el: Element): Element[] =>
    [...el.querySelectorAll("RelOp")].filter(
      (r) => r.parentElement?.closest("RelOp") === el,
    );
  const toNode = (relop: Element): PlanNode => {
    const objEl = [...relop.querySelectorAll("Object")].find(
      (o) => o.closest("RelOp") === relop,
    );
    const obj = objEl
      ? [objEl.getAttribute("Table"), objEl.getAttribute("Index")]
          .filter(Boolean)
          .map((s) => (s ?? "").replace(/[[\]]/g, ""))
          .join(".")
      : null;
    return {
      op: relop.getAttribute("PhysicalOp") ?? "?",
      rows: relop.getAttribute("EstimateRows") ?? "",
      cost: relop.getAttribute("EstimatedTotalSubtreeCost") ?? "",
      object: obj || null,
      children: childRelOps(relop).map(toNode),
    };
  };
  return [...doc.querySelectorAll("RelOp")]
    .filter((r) => r.parentElement?.closest("RelOp") == null)
    .map(toNode);
}

/** 연산자 박스 — 이름·대상·예상행·상대비용 막대(SSMS식). */
function PlanBox({ node, total }: { node: PlanNode; total: number }) {
  const cost = parseFloat(node.cost);
  const pct =
    total > 0 && !Number.isNaN(cost) ? Math.round((cost / total) * 100) : null;
  const rows = Math.round(parseFloat(node.rows) || 0);
  return (
    <div className="my-1 w-[152px] shrink-0 rounded border border-edge bg-panel px-2 py-1.5 text-[11px] shadow-sm">
      <div className="truncate font-medium text-fg" title={node.op}>
        {node.op}
      </div>
      {node.object && (
        <div
          className="truncate font-mono text-[10px] text-fg-dim"
          title={node.object}
        >
          {node.object}
        </div>
      )}
      <div className="mt-0.5 text-fg-dim">
        rows {rows}
        {pct != null && <span className="text-mod"> · {pct}%</span>}
      </div>
      {pct != null && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-edge">
          <div className="h-1 rounded bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** 재귀 트리 — 부모는 왼쪽, 자식은 오른쪽(데이터 흐름 오른쪽→왼쪽). 연결선은 CSS로. */
function PlanTreeNode({
  node,
  total,
  root,
}: {
  node: PlanNode;
  total: number;
  root?: boolean;
}) {
  return (
    <div
      className={`flex items-center ${
        root
          ? ""
          : "relative before:absolute before:left-[-16px] before:top-1/2 before:w-4 before:border-t before:border-edge"
      }`}
    >
      <PlanBox node={node} total={total} />
      {node.children.length > 0 && (
        <div className="ml-4 flex flex-col justify-center border-l border-edge">
          {node.children.map((c, i) => (
            <PlanTreeNode key={i} node={c} total={total} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanView() {
  const xml = useDb((s) => s.planXml);
  const closePlan = useDb((s) => s.closePlan);
  const nodes = useMemo(() => (xml ? parsePlan(xml) : []), [xml]);
  const total = nodes.reduce((m, n) => Math.max(m, parseFloat(n.cost) || 0), 0);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-xs text-fg-dim">
        <span>예상 실행 계획</span>
        <span className="text-[11px]">데이터 흐름: 오른쪽 → 왼쪽</span>
        <div className="flex-1" />
        <button
          onClick={closePlan}
          className="rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
        >
          결과로 ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {nodes.length ? (
          nodes.map((n, i) => (
            <PlanTreeNode key={i} node={n} total={total} root />
          ))
        ) : (
          <Center>계획을 표시할 수 없습니다</Center>
        )}
      </div>
    </div>
  );
}

function ResultArea() {
  const planXml = useDb((s) => s.planXml);
  return planXml ? <PlanView /> : <ResultGrid />;
}

export function DbWorkspace() {
  return (
    <div className="flex h-full min-w-0">
      <DbSidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-base">
        <QueryEditor />
        <div className="min-h-0 flex-1">
          <ResultArea />
        </div>
      </div>
    </div>
  );
}
