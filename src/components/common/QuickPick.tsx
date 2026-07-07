import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

// QuickPick — 09(Quick Open)이 정의하고 13(심볼 검색)이 재사용하는 공유 프리미티브.
// 입력 + 리스트 + 키보드 내비 + 백드롭. 동기 소스(퍼지)와 비동기 소스(IPC)를 모두 지원하며,
// 비동기 경합은 내부 seq 토큰으로 최신 쿼리 응답만 반영한다(디바운스·로딩 스피너도 내부 책임).
// PromptDialog의 z-[60] 백드롭·stopPropagation·자동 포커스 관례 미러.

export interface QuickPickItem<T = unknown> {
  id: string; // 리스트 key(고유값)
  label: string; // 주 표기
  labelHighlights?: number[]; // label 내 매치 문자 인덱스(퍼지 하이라이트)
  description?: string; // 보조 표기(경로/시그니처) — truncate
  hint?: string; // 우측 배지
  data: T; // onPick으로 되돌려줄 페이로드
}

export interface QuickPickProps<T> {
  placeholder: string;
  /** 쿼리 → 정렬·캡 완료된 항목. 동기 또는 Promise 모두 허용. 비동기 경합은 내부 seq로 처리. */
  source: (query: string) => QuickPickItem<T>[] | Promise<QuickPickItem<T>[]>;
  /** source 호출 디바운스(ms). 기본 0(동기 소스). 비동기 소스는 250 권장. */
  debounceMs?: number;
  onPick: (item: QuickPickItem<T>) => void; // 선택 — 호출 측이 onClose까지 수행
  onClose: () => void;
  emptyText?: string;
  footer?: React.ReactNode;
}

/** label에 하이라이트 인덱스를 굵게 표시. */
function Highlighted({ label, positions }: { label: string; positions?: number[] }) {
  if (!positions || positions.length === 0) return <>{label}</>;
  const set = new Set(positions);
  return (
    <>
      {label.split("").map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-accent">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export function QuickPick<T>({
  placeholder,
  source,
  debounceMs = 0,
  onPick,
  onClose,
  emptyText = "결과 없음",
  footer,
}: QuickPickProps<T>) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<QuickPickItem<T>[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0); // 비동기 응답 무효화 토큰

  // 자동 포커스
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // 쿼리 → source(디바운스 + seq 무효화). 동기 소스는 즉시 반영, 비동기는 pending 로딩.
  useEffect(() => {
    const seq = ++seqRef.current;
    const run = () => {
      const out = source(query);
      if (out instanceof Promise) {
        setLoading(true);
        out
          .then((res) => {
            if (seqRef.current !== seq) return; // 더 최신 쿼리가 있음 — 버림
            setItems(res);
            setActive(0);
            setLoading(false);
          })
          .catch(() => {
            if (seqRef.current !== seq) return;
            setItems([]);
            setLoading(false);
          });
      } else {
        setItems(out);
        setActive(0);
        setLoading(false);
      }
    };
    if (debounceMs > 0) {
      const id = window.setTimeout(run, debounceMs);
      return () => window.clearTimeout(id);
    }
    run();
    // source는 부모가 useMemo/useCallback로 안정화한다고 가정(매 렌더 재조회 방지).
  }, [query, source, debounceMs]);

  // 활성 항목이 리스트 밖이면 스크롤
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const clampActive = useMemo(() => Math.min(active, Math.max(0, items.length - 1)), [active, items]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const it = items[clampActive];
      if (it) onPick(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-dim"
          />
          {loading && <Loader2 size={14} className="shrink-0 animate-spin text-fg-dim" />}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-3 py-4 text-center text-[12px] text-fg-dim">{emptyText}</div>
          ) : (
            items.map((it, i) => (
              <div
                key={it.id}
                data-idx={i}
                onMouseMove={() => setActive(i)}
                onClick={() => onPick(it)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] ${
                  i === clampActive ? "bg-accent/20 text-fg" : "text-fg-muted"
                }`}
              >
                <span className="shrink-0 truncate">
                  <Highlighted label={it.label} positions={it.labelHighlights} />
                </span>
                {it.description && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim">
                    {it.description}
                  </span>
                )}
                {it.hint && (
                  <span className="ml-auto shrink-0 rounded bg-raised px-1.5 text-[10px] text-fg-dim">
                    {it.hint}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
        {footer && (
          <div className="border-t border-edge px-3 py-1 text-[11px] text-fg-dim">{footer}</div>
        )}
      </div>
    </div>
  );
}
