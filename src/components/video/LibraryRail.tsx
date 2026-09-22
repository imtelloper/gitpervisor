// 라이브러리 레일 (좌측) — 미디어 목록과 분할 클립 목록만 그리는 표시 전용 컴포넌트.
//
// 상태를 스스로 갖지 않는다(검색어조차 부모 소유) — 플레이어가 재생 중 rAF로 60fps
// 리렌더되는 동안 이 레일까지 흔들리면 안 되므로 memo + 안정화된 props가 전제다.
// 검색은 여기서 이름 부분일치로 거른다 — 부모가 미리 걸러 넘겨도 결과는 같다(멱등).
import {
  ChevronsLeft,
  ChevronsRight,
  FileVideo2,
  Play,
  Save,
  Scissors,
  Search,
  Square,
} from "lucide-react";
import { memo, useMemo } from "react";

import { useMessages } from "../../i18n/ui-language";
import { fmtTime } from "./VideoPlayer";

export interface RailMedia {
  path: string;
  name: string;
  /** 부제 한 줄 — "1:24.6 · 2886×1622" 처럼 이미 조립된 문자열. */
  sub: string;
  active: boolean;
}

export interface RailClip {
  index: number;
  label: string;
  startMs: number;
  endMs: number;
  /** 좌측 색 바에 그대로 넣는 CSS 색 — 프로젝트 색 모듈이 주는 값이라 토큰화하지 않는다. */
  color: string;
}

const rowCls =
  "relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-raised";

export const LibraryRail = memo(function LibraryRail({
  media,
  clips,
  query,
  onQueryChange,
  onOpen,
  onPlayClip,
  playingClip = null,
  onSaveAllSplits,
  saveDisabled = false,
  collapsed = false,
  onToggleCollapse,
}: {
  media: RailMedia[];
  clips: RailClip[];
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (path: string) => void;
  /** 클립 시작으로 탐색 — 초가 아니라 ms 그대로 넘긴다(부모가 단위를 안다). */
  /** 클립 미리보기 — 시작으로 이동해 재생하고 **클립 끝에서 자동 정지**한다.
   *  재생 중인 클립을 다시 누르면 정지(토글). */
  onPlayClip: (clip: RailClip) => void;
  /** 지금 미리보기 중인 클립의 index. 없으면 null. */
  playingClip?: number | null;
  onSaveAllSplits: () => void;
  saveDisabled?: boolean;
  collapsed?: boolean;
  onToggleCollapse: () => void;
}) {
  const msg = useMessages();
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? media.filter((m) => m.name.toLowerCase().includes(q)) : media),
    [media, q],
  );

  if (collapsed) {
    return (
      <aside className="flex w-10 flex-col items-center gap-2 border-r border-edge bg-panel py-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={msg.media.libraryRail.expand}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-raised hover:text-fg"
        >
          <ChevronsRight size={14} />
        </button>
        <div className="h-px w-6 bg-edge" />
        <div
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim"
          title={msg.media.libraryRail.mediaCount(media.length)}
        >
          <FileVideo2 size={14} />
        </div>
        <div className="text-[10px] text-fg-dim">{media.length}</div>
        <div
          className="mt-1 flex h-6 w-6 items-center justify-center rounded text-fg-dim"
          title={msg.media.libraryRail.clipCount(clips.length)}
        >
          <Scissors size={14} />
        </div>
        <div className="text-[10px] text-fg-dim">{clips.length}</div>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-panel text-xs">
      <div className="flex items-center gap-1 px-2 py-2">
        <span className="flex-1 text-[11px] font-semibold text-fg-muted">{msg.media.libraryRail.title}</span>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={msg.media.libraryRail.collapse}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-raised hover:text-fg"
        >
          <ChevronsLeft size={14} />
        </button>
      </div>

      <div className="relative px-2 pb-2">
        <Search
          size={13}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={msg.media.libraryRail.searchPlaceholder}
          aria-label={msg.media.libraryRail.searchLabel}
          className="h-7 w-full rounded border border-edge bg-base pl-7 pr-2 text-xs text-fg placeholder:text-fg-dim"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-fg-dim">
            {media.length === 0 ? msg.media.libraryRail.noMedia : msg.media.libraryRail.noResults}
          </p>
        ) : (
          shown.map((m) => (
            <button
              key={m.path}
              type="button"
              onClick={() => onOpen(m.path)}
              aria-current={m.active ? "true" : undefined}
              title={m.path}
              className={`${rowCls} ${m.active ? "bg-selection text-fg" : "text-fg-muted"}`}
            >
              {m.active && <span className="absolute inset-y-1 left-0 w-0.5 rounded bg-accent" />}
              <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded border border-edge bg-raised">
                <FileVideo2 size={14} className="text-fg-dim" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{m.name}</span>
                <span className="block truncate text-[11px] text-fg-dim">{m.sub}</span>
              </span>
            </button>
          ))
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-edge px-2 py-2">
        <span className="text-[11px] font-semibold text-fg-muted">{msg.media.libraryRail.clipsTitle}</span>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-dim">
          {clips.length}
        </span>
      </div>

      <div className="max-h-56 overflow-y-auto px-1">
        {clips.length === 0 ? (
          <p className="px-2 pb-2 text-[11px] leading-relaxed text-fg-dim">
            {msg.media.libraryRail.clipsEmpty}
          </p>
        ) : (
          clips.map((c) => (
            <div
              key={c.index}
              className={`${rowCls} ${playingClip === c.index ? "bg-selection text-fg" : "text-fg-muted"}`}
            >
              <span
                className="h-7 w-0.5 shrink-0 rounded"
                style={{ backgroundColor: c.color }}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-fg">
                  {String(c.index).padStart(2, "0")} · {c.label}
                </span>
                <span className="block font-mono text-[11px] text-fg-dim">
                  {fmtTime(c.startMs / 1000)} – {fmtTime(c.endMs / 1000)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onPlayClip(c)}
                aria-label={
                  playingClip === c.index
                    ? msg.media.libraryRail.stopPreview(c.label)
                    : msg.media.libraryRail.playSegment(c.label)
                }
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-raised hover:text-fg ${
                  playingClip === c.index ? "text-accent" : "text-fg-dim"
                }`}
              >
                {playingClip === c.index ? (
                  <Square size={11} fill="currentColor" />
                ) : (
                  <Play size={13} />
                )}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-edge p-2">
        <button
          type="button"
          onClick={onSaveAllSplits}
          disabled={saveDisabled || clips.length === 0}
          className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-edge text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Save size={13} />
          {msg.media.libraryRail.saveAllSplits}
        </button>
      </div>
    </aside>
  );
});
