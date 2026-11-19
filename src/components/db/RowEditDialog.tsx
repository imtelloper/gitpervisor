import { useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import type { DbCellValue, DbResult } from "../../lib/ipc";
import { useDb } from "../../stores/db";
import type { RowOrigin } from "../../stores/db";

/** 셀 값의 편집용 텍스트 — NULL 은 빈 칸(NULL 은 따로 체크). */
export function editText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * 이 행을 겨냥할 키 값. 그리드 값이 DB 값과 같다고 믿을 수 없으면 거절한다 — NULL(드라이버가 못 읽는 타입도 null 로 온다),
 * 2^53 을 넘는 정수(JSON 에서 이미 반올림돼 다른 행 번호가 된다), 객체.
 */
export function rowKeyOf(
  result: DbResult,
  keyCols: string[],
  row: number,
  why: {
    keyValueNull: (col: string) => string;
    keyValueImprecise: (col: string) => string;
    keyValueUnsupported: (col: string) => string;
  },
): { key: DbCellValue[] } | { refusal: string } {
  const key: DbCellValue[] = [];
  for (const col of keyCols) {
    const ci = result.columns.findIndex((c) => c.name === col);
    const value = ci >= 0 ? result.rows[row]?.[ci] : undefined;
    if (value === null || value === undefined) return { refusal: why.keyValueNull(col) };
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
      return { refusal: why.keyValueImprecise(col) };
    if (typeof value === "object") return { refusal: why.keyValueUnsupported(col) };
    key.push({ col, value });
  }
  return { key };
}

/** 행 수정 — 결과 컬럼을 한 번에 고친다. 키 컬럼은 읽기 전용, 바뀐 컬럼만 보낸다. Ctrl+Enter 저장 · Esc 닫기. */
export function RowEditDialog({
  table,
  origin,
  keyCols,
  keyValues,
  onClose,
}: {
  table: string;
  origin: RowOrigin;
  keyCols: string[];
  keyValues: DbCellValue[];
  onClose: () => void;
}) {
  const msg = useMessages();
  const t = msg.db.rowEditDialog;
  const updateRow = useDb((s) => s.updateRow);
  const columns = origin.result.columns.map((c) => c.name);
  const initial = origin.result.rows[origin.row] ?? [];
  const [vals, setVals] = useState(() => initial.map(editText));
  const [nulls, setNulls] = useState(() => initial.map((v) => v === null || v === undefined));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const seen = new Set<string>();
    const changed: { col: string; value: string | null }[] = [];
    columns.forEach((col, j) => {
      // SELECT *, col 처럼 같은 컬럼이 두 번 오면 첫 칸만 — SET 에 같은 컬럼을 두 번 넣으면 문장이 깨진다.
      if (keyCols.includes(col) || seen.has(col)) return;
      seen.add(col);
      const wasNull = initial[j] === null || initial[j] === undefined;
      if (nulls[j]) {
        if (!wasNull) changed.push({ col, value: null });
      } else if (wasNull || vals[j] !== editText(initial[j])) {
        changed.push({ col, value: vals[j] });
      }
    });
    if (!changed.length) {
      onClose();
      return;
    }
    setBusy(true);
    const ok = await updateRow(origin, table, keyValues, changed);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.title(table)}
        className="flex max-h-[80vh] w-[520px] max-w-[calc(100vw-32px)] flex-col rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="shrink-0 px-5 pt-5 font-semibold">{t.title(table)}</div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto px-5 py-3 text-[13px]">
          {columns.map((col, j) => {
            const isKey = keyCols.includes(col);
            return (
              <div key={j}>
                <div className="mb-0.5 flex items-center gap-1 text-[12px] text-fg-muted">
                  <span className={isKey ? "text-mod" : ""}>{col}</span>
                  {isKey && (
                    <span className="text-fg-dim" title={t.keyReadOnlyTitle}>
                      {t.keyBadge}
                    </span>
                  )}
                  {!isKey && (
                    <label className="ml-auto flex cursor-pointer items-center gap-1 text-fg-dim" title={t.nullTitle}>
                      <input
                        type="checkbox"
                        checked={nulls[j]}
                        onChange={(e) => setNulls((n) => n.map((x, k) => (k === j ? e.target.checked : x)))}
                      />
                      NULL
                    </label>
                  )}
                </div>
                {/* textarea — input 은 값의 줄바꿈을 지워 저장 때 내용이 바뀐다. */}
                <textarea
                  value={nulls[j] ? "" : vals[j]}
                  placeholder={nulls[j] ? "NULL" : ""}
                  disabled={isKey || nulls[j] || busy}
                  rows={Math.min(6, Math.max(1, vals[j].split("\n").length))}
                  autoFocus={j === columns.findIndex((c) => !keyCols.includes(c))}
                  onChange={(e) => setVals((v) => v.map((x, k) => (k === j ? e.target.value : x)))}
                  className="w-full resize-y rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent disabled:opacity-60"
                />
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 justify-end gap-2 px-5 pb-5 pt-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-fg-muted hover:bg-raised">
            {t.cancel}
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            title="Ctrl+Enter"
            className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? t.saving : t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
