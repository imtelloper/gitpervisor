// 오디오 플레이어 왼쪽 트랙 목록 — 같은 폴더의 오디오 파일. 표시 전용(검색어·접힘도 부모 소유).
//
// memo + 안정화된 props가 전제다 — 재생 중 timeupdate로 플레이어가 초당 4번 리렌더되는 동안 목록까지
// 다시 그리면 안 된다(LibraryRail과 같은 규칙). 동영상 레일과 따로 둔 이유: 행 모양(번호·이퀄라이저)과
// 하단 동작(폴더 전체 재생)이 다르고, 레일의 분할 클립 칸은 오디오에 없다.
import { ChevronsLeft, ChevronsRight, Folder, ListMusic, Music, Search } from "lucide-react";
import { memo, useMemo } from "react";

import { useMessages } from "../../i18n/ui-language";

export interface AudioTrack {
  path: string;
  /** 파일 이름 그대로 — 검색·툴팁용. */
  name: string;
  /** 행에 보이는 이름(확장자 제외). */
  label: string;
}

/** 현재 곡 번호 자리의 막대 셋 — 재생 중에만 움직인다(styles.css `.eq-bar`, 모션 최소화면 정지). */
function EqBars({ playing }: { playing: boolean }) {
  return (
    <span className="flex h-3.5 w-5 items-end justify-center gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`w-[3px] rounded-sm bg-accent ${playing ? "eq-bar" : ""}`}
          style={{ height: `${[70, 100, 50][i]}%`, animationDelay: `${i * -0.3}s` }}
        />
      ))}
    </span>
  );
}

export const AudioTrackList = memo(function AudioTrackList({
  tracks,
  currentPath,
  currentSub,
  folderName,
  playing,
  query,
  onQueryChange,
  onOpen,
  onPlayFolder,
  collapsed,
  onToggleCollapse,
}: {
  tracks: AudioTrack[];
  currentPath: string;
  /** 현재 곡 행의 부제(길이) — 나머지 곡은 비운다. */
  currentSub: string;
  folderName: string;
  playing: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (path: string) => void;
  onPlayFolder: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const msg = useMessages();
  const lr = msg.media.libraryRail;
  const ap = msg.media.audioPlayer;
  const q = query.trim().toLowerCase();
  // 번호는 **폴더 목록의 순번**이다 — 검색으로 걸러도 01·02… 가 다시 매겨지지 않는다.
  const shown = useMemo(
    () =>
      tracks
        .map((t, i) => ({ t, no: String(i + 1).padStart(2, "0") }))
        .filter(({ t }) => !q || t.name.toLowerCase().includes(q)),
    [tracks, q],
  );

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-edge bg-panel py-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={lr.expand}
          title={lr.expand}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-raised hover:text-fg"
        >
          <ChevronsRight size={14} />
        </button>
        <div className="h-px w-6 bg-edge" />
        <div
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim"
          title={ap.trackCount(tracks.length)}
        >
          <Music size={14} />
        </div>
        <div className="text-[10px] text-fg-dim">{tracks.length}</div>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-panel text-xs">
      <div className="flex items-center gap-1 px-2 py-2">
        <span className="flex-1 text-[11px] font-semibold text-fg-muted">{lr.title}</span>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={lr.collapse}
          title={lr.collapse}
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
          placeholder={ap.searchTracks}
          aria-label={ap.searchTracks}
          className="h-7 w-full rounded border border-edge bg-base pl-7 pr-2 text-xs text-fg placeholder:text-fg-dim"
        />
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-1.5 text-[11px] text-fg-dim">
        <Folder size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{folderName}</span>
        <span className="shrink-0">{ap.trackCount(tracks.length)}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-fg-dim">{lr.noResults}</p>
        ) : (
          shown.map(({ t, no }) => {
            const active = t.path === currentPath;
            return (
              <button
                key={t.path}
                type="button"
                data-gpv="audio-track"
                data-path={t.path}
                onClick={() => onOpen(t.path)}
                aria-current={active ? "true" : undefined}
                title={t.name}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-raised ${
                  active ? "bg-selection text-fg" : "text-fg-muted"
                }`}
              >
                <span className="flex w-5 shrink-0 justify-center font-mono text-[11px] text-fg-dim">
                  {active ? <EqBars playing={playing} /> : no}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-xs ${active ? "font-medium" : ""}`}>{t.label}</span>
                  {active && currentSub && (
                    <span className="block font-mono text-[11px] text-fg-dim">{currentSub}</span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="border-t border-edge p-2">
        <button
          type="button"
          data-gpv="audio-play-folder"
          onClick={onPlayFolder}
          className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-edge text-xs text-fg-muted hover:bg-raised hover:text-fg"
        >
          <ListMusic size={13} />
          {ap.playFolder}
        </button>
      </div>
    </aside>
  );
});
