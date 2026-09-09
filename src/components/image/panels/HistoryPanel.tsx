// 좌 패널 `히스토리` 탭(시안 ⑤) — 41 이 만든 항목을 **보여 주기만** 한다.
//
// 되돌리기 모델은 여기에 없다. 목록·커서·점프는 `DocHistory`, 스냅샷은 `persist` 가 소유하고
// 이 컴포넌트는 props 로 받은 것만 그린다 — 히스토리 상태를 패널이 따로 들면 Ctrl+Z 와
// 목록 클릭이 서로 다른 스택을 밟는다.
//
// `entries` 는 **최신이 위**이고 `cursor` 가 현재 항목이다. 그러므로 `i < cursor` 인 행은
// 아직 되돌려 놓은 미래(redo 가능)라 흐리게 그린다. 이전 세션 기록(`readonly`)은 라벨과
// 시각만 있고 문서가 없어 **되돌릴 수 없다** — 클릭을 막고 그 이유를 행에 적는다. 눌러도
// 아무 일이 없는 행은 고장으로 읽힌다.
//
// 배경: DOCS/task/44-image-panels.md §3.6

import { useEffect, useMemo, useState } from "react";

import type { HistoryEntry } from "../../../lib/annotate/history";
import type { SnapshotInfo } from "../../../lib/annotate/persist";
import { relativeTime } from "../../../lib/format";
import { useImageEditorUi } from "../../../stores/imageEditor";

/** 이 간격을 넘으면 새 그룹 — 시안의 `오늘 · 15:24` / `오늘 · 14:50` 두 덩어리가 이 값에서 나온다. */
const GROUP_GAP_MS = 10 * 60_000;
/** 상대 시각 갱신 주기. 탭이 보일 때만 돈다. */
const TICK_MS = 60_000;

type Chip = "all" | "mine" | "snap";

const CHIPS: readonly { id: Chip; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "mine", label: "내 작업" },
  { id: "snap", label: "스냅샷" },
];

/**
 * 사용자가 직접 하지 않은 커밋인가(`내 작업` 필터가 걸러낸다).
 * ponytail: 문자열 접두 비교 — 자동 라벨이 셋 이상 늘면 `HistoryEntry` 에 플래그를 둔다.
 */
function isAutoLabel(label: string): boolean {
  return label.startsWith("스타일 갱신") || label.startsWith("컴포넌트 갱신");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 그룹 제목 — `오늘 · 15:24` / `어제 · 14:50` / `3월 4일 · 09:10`. */
function groupTitle(at: number, now: number): string {
  const d = new Date(at);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = (t: number) => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const diffDays = Math.round((day(now) - day(at)) / 86_400_000);
  if (diffDays === 0) return `오늘 · ${time}`;
  if (diffDays === 1) return `어제 · ${time}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 · ${time}`;
}

interface Item {
  /** 원본 배열 인덱스 — 필터로 걸러도 `onJump`/`onLoadSnapshot` 은 이 값을 받는다. */
  index: number;
  at: number;
  label: string;
  readonly: boolean;
}

/** 날짜가 바뀌거나 직전 항목과 10분 넘게 벌어지면 새 그룹. 제목은 그룹의 **최신** 시각. */
function groupItems(items: readonly Item[], now: number): { title: string; items: Item[] }[] {
  const out: { title: string; items: Item[] }[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    const prev = last?.items[last.items.length - 1];
    const sameDay = prev ? new Date(prev.at).toDateString() === new Date(it.at).toDateString() : false;
    if (!last || !prev || !sameDay || prev.at - it.at > GROUP_GAP_MS) {
      out.push({ title: groupTitle(it.at, now), items: [it] });
    } else {
      last.items.push(it);
    }
  }
  return out;
}

export interface HistoryPanelProps {
  /** 41 `DocHistory.entries` — 최신이 위. */
  entries: readonly HistoryEntry[];
  cursor: number;
  /** 41 `persist.listSnapshots()` 결과(저장 순, 오래된 것이 앞). */
  snapshots: readonly SnapshotInfo[];
  onJump(i: number): void;
  onLoadSnapshot(i: number): void;
  onSaveSnapshot(): void;
  onUndo(): void;
}

export function HistoryPanel({
  entries,
  cursor,
  snapshots,
  onJump,
  onLoadSnapshot,
  onSaveSnapshot,
  onUndo,
}: HistoryPanelProps) {
  const [chip, setChip] = useState<Chip>("all");
  const [now, setNow] = useState(() => Date.now());
  const visible = useImageEditorUi((s) => s.leftTab === "history");

  // `방금 전 → 3분 전` 이 저절로 바뀌게 한다. 탭이 안 보일 때 도는 타이머는 아무것도 갱신하지
  // 않으면서 편집기 수명 내내 리렌더를 부른다.
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [visible]);

  const groups = useMemo(() => {
    if (chip === "snap") {
      // 스냅샷은 저장 순으로 오므로 최신이 위가 되게 뒤집되, 인덱스는 원본을 유지한다.
      const items = snapshots
        .map((s, index): Item => ({ index, at: s.at, label: s.name, readonly: false }))
        .reverse();
      return groupItems(items, now);
    }
    const items = entries
      .map((e, index): Item => ({ index, at: e.at, label: e.label, readonly: e.readonly }))
      .filter((it) => chip !== "mine" || !isAutoLabel(it.label));
    return groupItems(items, now);
  }, [chip, entries, snapshots, now]);

  const snap = chip === "snap";

  return (
    <div className="flex h-full min-h-0 flex-col text-[11px]">
      <div
        style={{ height: 38 }}
        className="flex shrink-0 items-center gap-1 border-b border-edge px-2"
      >
        {CHIPS.map((c) => (
          <button
            key={c.id}
            onClick={() => setChip(c.id)}
            className={`rounded px-2 py-1 ${
              chip === c.id ? "bg-accent/15 text-accent" : "text-fg-muted hover:text-fg"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <div className="px-2 py-3 text-fg-dim">
            {snap ? "저장된 스냅샷이 없습니다" : "표시할 기록이 없습니다"}
          </div>
        )}
        {groups.map((g, gi) => (
          <div key={gi}>
            <div
              style={{ height: 26 }}
              className="flex items-center bg-panel px-2 text-fg-dim"
            >
              {g.title}
            </div>
            {g.items.map((it) => {
              const current = !snap && it.index === cursor;
              return (
                <button
                  key={`${it.index}-${it.at}`}
                  disabled={it.readonly}
                  title={
                    it.readonly ? "이전 세션 기록이라 되돌릴 수 없습니다" : undefined
                  }
                  onClick={() => (snap ? onLoadSnapshot(it.index) : onJump(it.index))}
                  style={{ height: 34 }}
                  className={`flex w-full items-center gap-2 px-2 text-left ${
                    it.readonly
                      ? "cursor-default text-fg-dim"
                      : "text-fg-muted hover:bg-raised hover:text-fg"
                  } ${!snap && it.index < cursor ? "opacity-50" : ""}`}
                >
                  {/* 세로 레일 — 현재보다 위(redo 가능) 구간이 흐린 것과 함께 진행 방향을 보인다. */}
                  <span
                    style={{ width: 2, height: 18 }}
                    className={`shrink-0 rounded ${current ? "bg-accent" : "bg-edge"}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.readonly && (
                    <span className="shrink-0 rounded border border-edge px-1 text-[9px]">
                      이전 세션
                    </span>
                  )}
                  <span className="shrink-0 text-fg-dim">{relativeTime(it.at, now)}</span>
                  {current && (
                    <span className="shrink-0 rounded bg-accent/15 px-1 text-accent">현재</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{ height: 32 }}
        className="flex shrink-0 items-center justify-end gap-1 border-t border-edge px-2"
      >
        <button
          onClick={onUndo}
          className="rounded border border-edge px-2 py-1 text-fg-muted hover:text-fg"
        >
          되돌리기
        </button>
        <button
          onClick={onSaveSnapshot}
          className="rounded bg-accent px-2 py-1 text-on-accent hover:bg-accent-hover"
        >
          스냅샷 저장
        </button>
      </div>
    </div>
  );
}
