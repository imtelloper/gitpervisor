import { monaco } from "../diff/monaco-setup";

import { Editor } from "@monaco-editor/react";
import { Play } from "lucide-react";

import { useSettings } from "../../queries";
import { LIMIT_OPTIONS, useDb } from "../../stores/db";
import { DbSidebar } from "./DbSidebar";

function QueryEditor() {
  const queryText = useDb((s) => s.queryText);
  const setQuery = useDb((s) => s.setQuery);
  const runQuery = useDb((s) => s.runQuery);
  const running = useDb((s) => s.running);
  const limit = useDb((s) => s.limit);
  const setLimit = useDb((s) => s.setLimit);
  const activeDatabase = useDb((s) => s.activeDatabase);
  const { data: settings } = useSettings();
  const theme =
    settings?.theme === "monokai" ? "gitpervisor-monokai" : "gitpervisor-dark";

  return (
    <div className="flex h-[210px] shrink-0 flex-col border-b border-edge">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-xs text-fg-dim">
          {activeDatabase ? `mongo-js · ${activeDatabase}` : "왼쪽에서 DB를 선택하세요"}
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
          language="javascript"
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

function renderCell(v: unknown) {
  if (v === null || v === undefined)
    return <span className="text-fg-dim">null</span>;
  if (typeof v === "object")
    return <span className="text-mod">{JSON.stringify(v)}</span>;
  if (typeof v === "boolean")
    return <span className="text-add">{String(v)}</span>;
  if (typeof v === "number") return <span className="text-mod">{v}</span>;
  return <span>{String(v)}</span>;
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

  if (running) return <Center>실행 중…</Center>;
  if (error) return <Center danger>{error}</Center>;
  if (!result) return <Center>컬렉션을 클릭하거나 쿼리를 실행하세요</Center>;
  if (result.rows.length === 0) return <Center>결과 없음</Center>;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel">
              <th className="border-b border-r border-edge px-2 py-1 text-left font-medium text-fg-dim">
                #
              </th>
              {result.columns.map((c) => (
                <th
                  key={c.name}
                  className="whitespace-nowrap border-b border-r border-edge px-2 py-1 text-left font-medium text-fg-muted"
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} className="hover:bg-raised/40">
                <td className="border-b border-r border-edge px-2 py-1 text-fg-dim">
                  {i + 1}
                </td>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="max-w-[380px] truncate border-b border-r border-edge px-2 py-1 align-top font-mono"
                  >
                    {renderCell(cell)}
                  </td>
                ))}
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
      </div>
    </div>
  );
}

/** DB 모드 워크스페이스 — 좌: 연결/스키마 트리 / 우: 쿼리 에디터 + 결과 그리드 (M6 §17). */
export function DbWorkspace() {
  return (
    <div className="flex h-full min-w-0">
      <DbSidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-base">
        <QueryEditor />
        <div className="min-h-0 flex-1">
          <ResultGrid />
        </div>
      </div>
    </div>
  );
}
