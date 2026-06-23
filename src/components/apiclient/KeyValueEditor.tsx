import { Trash2 } from "lucide-react";

import type { KvRow } from "../../stores/apiclient";

/**
 * 헤더/쿼리/form/env 공용 Key-Value 편집기(§8.5). 4곳 재사용.
 * - 각 행: ☑ enabled · key · value · ✕(삭제).
 * - 마지막에 항상 빈 "추가 행" — key 또는 value 입력 시 새 행 append.
 * - readOnly 모드(응답 Headers/Cookies 표시용): 입력 대신 텍스트, 토글/삭제 숨김.
 */
export function KeyValueEditor({
  rows,
  onChange,
  readOnly = false,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
}: {
  rows: KvRow[];
  onChange?: (rows: KvRow[]) => void;
  readOnly?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  if (readOnly) {
    if (rows.length === 0)
      return <div className="px-3 py-4 text-[12px] text-fg-dim">없음</div>;
    return (
      <div className="text-[12px]">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-start gap-2 border-b border-edge/50 px-3 py-1"
          >
            <span className="w-1/3 shrink-0 break-all font-mono text-fg-muted">
              {r.key}
            </span>
            <span className="min-w-0 flex-1 break-all font-mono text-fg">
              {r.value}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const emit = (next: KvRow[]) => onChange?.(next);

  const update = (id: string, patch: Partial<KvRow>) =>
    emit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const remove = (id: string) => emit(rows.filter((r) => r.id !== id));

  // 빈 추가 행에 입력 → 새 행 append + 다음 빈 행 유지.
  const editLast = (patch: Partial<KvRow>) => {
    const newRow: KvRow = {
      id: crypto.randomUUID(),
      enabled: true,
      key: "",
      value: "",
      ...patch,
    };
    emit([...rows, newRow]);
  };

  return (
    <div className="text-[13px]">
      {rows.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-2 border-b border-edge/50 px-3 py-1"
        >
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
            title="이 행 사용"
            className="shrink-0 accent-accent"
          />
          <input
            value={r.key}
            onChange={(e) => update(r.id, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="w-1/3 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
          />
          <input
            value={r.value}
            onChange={(e) => update(r.id, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
          />
          <button
            onClick={() => remove(r.id)}
            title="행 삭제"
            className="shrink-0 text-fg-dim hover:text-danger"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {/* 자동 추가 행 — 입력 시 새 행 생성 */}
      <div className="flex items-center gap-2 px-3 py-1 opacity-60">
        <input
          type="checkbox"
          checked={false}
          disabled
          className="shrink-0 accent-accent"
        />
        <input
          value=""
          onChange={(e) => editLast({ key: e.target.value })}
          placeholder={keyPlaceholder}
          className="w-1/3 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
        />
        <input
          value=""
          onChange={(e) => editLast({ value: e.target.value })}
          placeholder={valuePlaceholder}
          className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
        />
        <span className="w-3 shrink-0" />
      </div>
    </div>
  );
}
