// 오디오 플레이어 — 폴더 플레이리스트(왼쪽 트랙 목록) · 히어로(커버·태그) · 파형 진행바 · 재생바 · 상태바.
//
// - 스트리밍·유휴 서버 복구(1회 재발급)·keep-alive·코덱 실패 안내는 옛 MediaView AudioView를 그대로 옮겼다
//   (루프백 Range가 탐색을 가능하게 한다 — 그 이유는 MediaView 머리 주석).
// - 곡 전환(목록 클릭·다음/이전·곡 끝)은 전부 onOpenPath — 뷰어가 형제 파일을 여는 통로다. 이 컴포넌트는 path가
//   바뀌는 것만 알고, 새 곡 재생은 자동재생 규칙(onCanPlay)이 잇는다.
// - 단축키는 포커스된 컨테이너에만(VideoPlayer와 같은 이유 — 전역 Ctrl+W 등과 충돌 없음). Space만 전역이다.
import {
  ExternalLink,
  FileWarning,
  FolderOpen,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { hasUserEngaged } from "../../lib/engagement";
import { openDocWindow } from "../../lib/floating";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import { isAudio } from "../../lib/language-map";
import { useAudioCoverArt, useDir, useVideoProbe, useVideoToolStatus, useVideoWaveform } from "../../queries";
import { useDb } from "../../stores/db";
import { useOcclusion } from "../../stores/occlusion";
import { selectBlockingOverlay, useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { PlayerStatusBar } from "../video/PlayerStatusBar";
import { fmtClock, SkipBtn } from "../video/VideoPlayer";
import { AudioTrackList, type AudioTrack } from "./AudioTrackList";
import { endedIndex, NEXT_REPEAT, stepIndex, type RepeatMode } from "./playlist";

const RATES = [0.75, 1, 1.25, 1.5, 2];
/** 파형 막대 수 — 폭이 넓어도 막대가 읽히는 밀도. 파일당 한 번 뽑아 캐시한다(staleTime Infinity). */
const WAVE_BUCKETS = 160;
const PREFS_KEY = "gp:audio-player";

/** 곡을 바꿔도·재시작해도 유지하는 재생 취향. */
interface AudioPrefs {
  volume: number;
  muted: boolean;
  rate: number;
  repeat: RepeatMode;
  shuffle: boolean;
}

const DEFAULT_PREFS: AudioPrefs = { volume: 1, muted: false, rate: 1, repeat: "off", shuffle: false };

function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      volume: typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : 1,
      muted: p.muted === true,
      rate: typeof p.rate === "number" && RATES.includes(p.rate) ? p.rate : 1,
      repeat: p.repeat === "all" || p.repeat === "one" ? p.repeat : "off",
      shuffle: p.shuffle === true,
    };
  } catch {
    // 비공개 창·저장소 차단·손상된 값 — 기본값으로 트는 것이 맞다(알릴 것이 없다).
    return DEFAULT_PREFS;
  }
}

function saveAudioPrefs(p: AudioPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // 저장 차단(비공개 창 등) — 다음에 기본값으로 뜰 뿐 무해하다.
  }
}

/** play()는 자동재생 정책·곡 전환 중 load로 거절될 수 있다 — 그러면 일시정지로 남는 것이 정상이라 알릴 것이 없다. */
function playQuietly(el: HTMLMediaElement) {
  void el.play().catch(() => {});
}

/** 초 단위 시계 — "3:42". 내림: 반올림하면 59.6초가 "0:60"이 된다. */
const clock = (sec: number) => fmtClock(Math.floor(Math.max(0, sec)), 0);

const stemOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

const iconBtn =
  "grid h-8 w-8 place-items-center rounded-full text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-40";

/**
 * 파형 진행바 — 막대(피크)를 그리고 재생된 만큼 accent로 덮는다. 클릭·드래그로 탐색(pointer capture).
 * 두 겹은 같은 SVG이고 윗겹만 clip-path로 자른다 — 재생 중엔 그 % 하나만 바뀐다. 피크가 없으면(ffmpeg 없음·빈
 * 배열) 얇은 일반 진행바로 같은 동작을 한다.
 */
function WaveformSeek({
  peaks,
  time,
  duration,
  label,
  onSeek,
}: {
  peaks: number[];
  time: number;
  duration: number;
  label: string;
  onSeek: (t: number) => void;
}) {
  const pct = duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;
  // 같은 엘리먼트를 두 겹에 넣는다 — 참조가 같아 timeupdate 리렌더에서 React가 막대 160개를 다시 비교하지 않는다.
  const bars = useMemo(
    () =>
      peaks.length === 0 ? null : (
        <g fill="currentColor">
          {peaks.map((v, i) => {
            const h = Math.max(4, Math.min(1, Math.max(0, v)) * 100);
            return <rect key={i} x={i + 0.2} y={(100 - h) / 2} width={0.6} height={h} />;
          })}
        </g>
      ),
    [peaks],
  );
  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || duration <= 0) return;
    onSeek(((e.clientX - r.left) / r.width) * duration);
  };
  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      data-gpv="audio-seek"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e);
      }}
      className={`relative w-full cursor-pointer touch-none select-none ${bars ? "h-28" : "h-5"}`}
    >
      {bars ? (
        <>
          <svg
            viewBox={`0 0 ${peaks.length} 100`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full text-fg-dim/40"
          >
            {bars}
          </svg>
          <svg
            viewBox={`0 0 ${peaks.length} 100`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full text-accent"
            style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
          >
            {bars}
          </svg>
        </>
      ) : (
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-raised">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function AudioPlayer({
  projectId,
  path,
  onOpenPath,
}: {
  projectId: string;
  path: string;
  /** 다른 곡을 **이 자리에서** 연다(뷰어의 형제 파일 통로). 안 주면 새 문서 창 — VideoPlayer와 같은 규칙. */
  onOpenPath?: (path: string) => void;
}) {
  const msg = useMessages();
  const tp = msg.media.player;
  const ap = msg.media.audioPlayer;
  const pushToast = useUi((s) => s.pushToast);

  // src는 **어느 곡의** URL인지 함께 든다 — path가 바뀐 렌더에서 옛 URL로 새 요소를 만들지 않게(아래 <audio> 조건).
  const [src, setSrc] = useState<{ path: string; url: string } | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [playError, setPlayError] = useState(false);
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const retriedRef = useRef(false);
  /** 이 파일에 대해 자동재생을 이미 시도했는가 — VideoPlayer의 autoplayedRef와 같은 규칙. */
  const autoplayedRef = useRef(false);
  /** 곡 끝(ended)으로 넘어간 곡은 포커스를 뺏지 않는다 — 음악을 틀어 두고 터미널에서 일하는 중일 수 있다. */
  const quietOpenRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [prefs, setPrefs] = useState(loadAudioPrefs);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [query, setQuery] = useState("");

  const url = src && src.path === path ? src.url : null;

  useEffect(() => saveAudioPrefs(prefs), [prefs]);
  // 취향은 요소에 즉시 입힌다. 새 곡은 load가 playbackRate를 defaultPlaybackRate로 되돌리므로 onLoadedMetadata가 한 번 더 입힌다.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = prefs.volume;
    el.muted = prefs.muted;
    el.playbackRate = prefs.rate;
  }, [prefs.volume, prefs.muted, prefs.rate, url]);

  /** 루프백 URL 발급. 서버가 살아 있으면 같은 URL이 돌아와 멱등이다. */
  const mint = useCallback(async () => {
    try {
      const u = await ipc.previewLocalUrl(projectId, path);
      // 응답 전에 다른 곡으로 넘어갔으면 버린다(N 연타) — 늦게 온 옛 URL은 이미 조건에서 걸러지지만 오류 표시도 막는다.
      if (pathRef.current !== path) return null;
      setSrc({ path, url: u });
      setMintError(null);
      return u;
    } catch (e) {
      if (pathRef.current === path) setMintError(errorMessage(e));
      return null;
    }
  }, [projectId, path]);

  // 곡이 바뀌면 전부 리셋. 이전 곡 요소는 조건(src.path === path)에서 빠지며 bindMedia 정리가 세운다.
  useEffect(() => {
    setSrc(null);
    setMintError(null);
    setPlayError(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    retriedRef.current = false;
    autoplayedRef.current = false;
    void mint();
  }, [mint]);

  /** 요소를 붙이고 뗀다. 곡이 바뀌어 빠질 때 **명시적으로** 세운다 — 떼어낸 미디어 요소의 자동 정지(HTML 명세)에만
   *  기대면 엔진마다 소리가 겹칠 여지가 남는다(React 19 ref 정리 함수). */
  const bindMedia = useCallback((el: HTMLAudioElement | null) => {
    mediaRef.current = el;
    return () => {
      el?.pause();
      if (mediaRef.current === el) mediaRef.current = null;
    };
  }, []);

  // 파일을 열면 바로 단축키가 듣도록 컨테이너에 포커스(VideoPlayer와 같다) — 곡 끝으로 넘어간 곡만 예외.
  useEffect(() => {
    if (!url) return;
    if (quietOpenRef.current) {
      quietOpenRef.current = false;
      return;
    }
    containerRef.current?.focus();
  }, [path, url]);

  // 프리뷰 서버 keep-alive — 긴 오디오도 선버퍼 후 10분 넘게 조용해지면 유휴 종료로
  // 다음 탐색이 연결 거부가 된다. mint는 멱등 + 유휴 시계 리셋(VideoPlayer와 동일).
  useEffect(() => {
    const id = window.setInterval(
      () => void ipc.previewLocalUrl(projectId, path).catch(() => {}),
      4 * 60_000,
    );
    return () => window.clearInterval(id);
  }, [projectId, path]);

  // Space 재생/정지 **전역** — VideoPlayer의 전역 Space 핸들러를 그대로 옮겼다(보일 때만 · 입력 요소·모달 양보).
  // 포커스가 플레이어 밖(파일트리·로그 패널 등)으로 옮겨가도 듣는다. 내부 포커스는 컨테이너 onKeyDown 몫(이중 토글 방지).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.repeat) return; // 꾹 누름 자동 반복이 재생/정지를 파닥거리게 하면 안 된다
      // 다른 워크스페이스 탭이 활성이면 ViewerTab이 display:none으로 마운트 유지된다 — 보이지 않는 플레이어는 양보.
      const box = containerRef.current;
      if (!box || box.offsetWidth === 0) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      // 입력 요소·버튼은 자기 의미(입력·활성화)가 우선. 터미널(xterm)·에디터(monaco)는 TEXTAREA.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      if (t?.isContentEditable) return;
      if (t && box.contains(t)) return; // 내부는 컨테이너 핸들러 담당
      // 모달 위에선 양보 — ui 모달들 + DB 다이얼로그 + 로컬 메뉴(occlusion 카운터)까지.
      if (
        selectBlockingOverlay(useUi.getState()) ||
        !!useDb.getState().dialog ||
        useOcclusion.getState().count > 0
      )
        return;
      e.preventDefault();
      const el = mediaRef.current;
      if (!el) return;
      if (el.paused) playQuietly(el);
      else el.pause();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /**
   * 재생 오류 처리. 프리뷰 서버는 요청이 10분간 없으면 스스로 종료하는데(IDLE_SECS),
   * 일시정지해 두면 요청이 끊겨 그 뒤 재생·탐색이 연결 거부로 실패한다. 그래서 먼저 **한 번
   * 재발급**해 되살려 보고(재생 위치 유지), 그래도 실패하면 코덱 문제로 판단해 안내한다.
   */
  const onError = () => {
    const el = mediaRef.current;
    if (retriedRef.current || !el) {
      setPlayError(true);
      return;
    }
    retriedRef.current = true;
    const at = el.currentTime;
    const wasPlaying = !el.paused; // 치명 오류로 멈춰도 paused는 false — 재개 의도 판단
    const failedPath = path;
    void mint().then((u) => {
      if (pathRef.current !== failedPath) return; // 복구 중 다른 곡으로 넘어갔다 — 새 곡에 오류를 옮기지 않는다
      if (!u) {
        setPlayError(true);
        return;
      }
      // 서버가 살아 있으면 재발급 URL이 동일해 src 변경 재로드가 없다 — load()로 강제
      // 재시도해야 하고, 그마저 실패(코덱)하면 두 번째 error가 안내 화면으로 간다.
      // load()는 정지 상태로 되돌리므로 재생 중이었으면 play()로 재개한다.
      requestAnimationFrame(() => {
        const m = mediaRef.current;
        if (!m) return;
        m.load();
        if (at > 0) m.currentTime = at;
        if (wasPlaying) playQuietly(m);
      });
    });
  };

  // OS 기본 앱으로 넘긴다 — 웹뷰가 못 여는 코덱의 유일한 탈출구.
  const openExternally = () => {
    void ipc.runExecutable(projectId, path).catch((e) => pushToast("error", errorMessage(e)));
  };
  const revealFile = () => {
    void ipc.revealInRepo(projectId, path).catch((e) => pushToast("error", errorMessage(e)));
  };

  // ── 메타(현재 곡만) — ffprobe·파형·커버 ──
  const tool = useVideoToolStatus();
  const probe = useVideoProbe(projectId, path, !!tool.data?.found && !!tool.data?.probeFound);
  // 파형은 ffmpeg만 쓴다(video_waveform은 ffprobe가 필요 없다).
  const waveform = useVideoWaveform(projectId, path, WAVE_BUCKETS, !!tool.data?.found);
  // 커버 스트림(attached_pic = video)이 있을 때만 ffmpeg를 띄운다 — 커버 없는 곡에 스폰하지 않는다.
  const cover = useAudioCoverArt(projectId, path, !!probe.data?.hasVideo);

  // ── 플레이리스트 — 같은 폴더의 오디오. 파일트리가 이미 쓰는 dir 쿼리를 재사용한다(워처가 신선도 책임, VideoPlayer 레일과 같다) ──
  const dirRel = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const dir = useDir(projectId, dirRel);
  // ponytail: 목록 행 태그/길이는 현재 곡만 — 다른 곡마다 ffprobe를 띄우지 않는다(프로세스 위생, VideoPlayer 레일과
  // 같은 이유). 행마다 제목·길이가 필요해지면 폴더 단위 배치 probe 커맨드 하나로.
  const tracks: AudioTrack[] = useMemo(() => {
    const prefix = dirRel ? `${dirRel}/` : "";
    const rows = (dir.data ?? [])
      .filter((e) => !e.isDir && isAudio(e.name))
      .map((e) => ({ path: prefix + e.name, name: e.name, label: stemOf(e.name) }));
    // 목록을 못 읽었어도(권한·워처 지연) 현재 파일은 항상 보인다.
    if (rows.some((r) => r.path === path)) return rows;
    const here = path.slice(prefix.length);
    return [...rows, { path, name: here, label: stemOf(here) }];
  }, [dir.data, dirRel, path]);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const curIdx = tracks.findIndex((t) => t.path === path);

  // ── 트랜스포트 ──
  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) playQuietly(el);
    else el.pause();
  }, []);
  const restart = () => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = 0;
    playQuietly(el);
  };
  const seekTo = (t: number) => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = Math.min(Math.max(t, 0), duration || el.duration || 0);
    setTime(el.currentTime);
  };
  const seekBy = (d: number) => seekTo((mediaRef.current?.currentTime ?? 0) + d);

  /** 목록 클릭·다음/이전의 공용 입구. 지금 곡을 다시 고르면 멈춰 있을 때만 이어서 튼다. */
  const openTrack = useCallback(
    (p: string) => {
      if (p === pathRef.current) {
        const el = mediaRef.current;
        if (el?.paused) playQuietly(el);
        return;
      }
      if (onOpenPath) onOpenPath(p);
      else openDocWindow(projectId, p);
    },
    [onOpenPath, projectId],
  );
  const openIndex = (i: number | null) => {
    if (i == null) return;
    const t = tracks[i];
    if (!t) return;
    if (t.path === path) restart();
    else openTrack(t.path);
  };
  const goStep = (d: 1 | -1) => openIndex(stepIndex(tracks.length, curIdx, d, prefs.shuffle));
  const onPlayFolder = useCallback(() => {
    const first = tracksRef.current[0];
    if (!first) return;
    if (first.path === pathRef.current) {
      const el = mediaRef.current;
      if (!el) return;
      el.currentTime = 0;
      playQuietly(el);
    } else openTrack(first.path);
  }, [openTrack]);
  const onEnded = () => {
    const next = endedIndex(tracks.length, curIdx, prefs.repeat, prefs.shuffle);
    if (next == null) return; // 반복 끔 · 마지막 곡 — 끝에서 멈춘다
    if (next !== curIdx) quietOpenRef.current = true;
    openIndex(next);
  };

  const toggleMute = () => setPrefs((p) => ({ ...p, muted: !p.muted }));
  const cycleRepeat = () => setPrefs((p) => ({ ...p, repeat: NEXT_REPEAT[p.repeat] }));
  const toggleShuffle = () => setPrefs((p) => ({ ...p, shuffle: !p.shuffle }));
  const cycleRate = () =>
    setPrefs((p) => ({ ...p, rate: RATES[(RATES.indexOf(p.rate) + 1) % RATES.length] }));
  const stepRate = (d: 1 | -1) =>
    setPrefs((p) => {
      const i = RATES.indexOf(p.rate);
      return { ...p, rate: RATES[Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 1 : i) + d))] };
    });
  const toggleList = useCallback(() => setListCollapsed((v) => !v), []);

  // ── 단축키(포커스된 컨테이너 한정) ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // 포커스된 버튼의 Space는 그 버튼 활성화가 기대 동작 — 가로채면 키보드 탐색이 깨진다.
    if (tag === "BUTTON" && e.key === " ") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 전역 단축키(Ctrl+W 등)에 양보
    let handled = true;
    switch (e.key) {
      case " ":
      case "k":
      case "K":
        if (!e.repeat) togglePlay(); // 꾹 누름 반복 무시
        break;
      case "ArrowLeft":
        seekBy(e.shiftKey ? -1 : -10);
        break;
      case "ArrowRight":
        seekBy(e.shiftKey ? 1 : 10);
        break;
      case "n":
      case "N":
        if (!e.repeat) goStep(1); // 꾹 누르면 곡마다 프리뷰 URL·probe가 줄줄이 뜬다
        break;
      case "p":
      case "P":
        if (!e.repeat) goStep(-1);
        break;
      case "l":
      case "L":
        cycleRepeat();
        break;
      case "s":
      case "S":
        toggleShuffle();
        break;
      case "m":
      case "M":
        toggleMute();
        break;
      case "-":
        stepRate(-1);
        break;
      case "=":
      case "+":
        stepRate(1);
        break;
      default:
        if (/^[0-9]$/.test(e.key) && duration > 0) seekTo((duration * Number(e.key)) / 10);
        else handled = false;
    }
    if (handled) e.preventDefault();
  };

  // ── 표시 값 ──
  const meta = probe.data;
  const tags = meta?.tags;
  const stream = meta?.audioStreams[0];
  const title = tags?.title || tracks[curIdx]?.label || stemOf(path);
  const year = tags?.date ? (/^\d{4}/.exec(tags.date)?.[0] ?? tags.date) : null;
  const albumLine = [tags?.album, year].filter(Boolean).join(" · ");
  const metaLine = meta
    ? [
        meta.bitrateKbps ? `${meta.bitrateKbps} kbps` : null,
        stream?.sampleRate ? `${Number((stream.sampleRate / 1000).toFixed(1))} kHz` : null,
        stream?.channels ? ap.channels(stream.channels) : null,
        meta.acodec,
        meta.sizeBytes != null ? formatBytes(meta.sizeBytes) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const nextIdx = !prefs.shuffle && tracks.length > 1 ? stepIndex(tracks.length, curIdx, 1, false) : null;
  const nextTrack = nextIdx != null ? tracks[nextIdx] : undefined;
  const folderName = dirRel.split("/").pop() || "/";
  const currentSub = duration > 0 ? clock(duration) : "";
  const RepeatIcon = prefs.repeat === "one" ? Repeat1 : Repeat;
  const VolumeIcon = prefs.muted || prefs.volume === 0 ? VolumeX : prefs.volume < 0.5 ? Volume1 : Volume2;

  const failure = mintError ? (
    <EmptyState icon={FileWarning} title={tp.mintFailed} desc={mintError} />
  ) : playError ? (
    <EmptyState
      icon={FileWarning}
      title={tp.unplayableTitle}
      desc={tp.codecUnsupported}
      action={
        <button
          onClick={openExternally}
          className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={13} /> {tp.openExternally}
        </button>
      }
    />
  ) : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-gpv="audio-player"
      className="flex h-full flex-col bg-base outline-none"
    >
      {/* 상단 바 — VideoPlayer 상단 바와 같은 h-8 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-xs text-fg-dim">
        <span data-gpv="audio-meta" className="truncate font-mono">
          {metaLine}
        </span>
        <div className="flex-1" />
        <button
          onClick={openExternally}
          title={tp.openSystemTitle}
          className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={12} /> {tp.externalApp}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <AudioTrackList
          tracks={tracks}
          currentPath={path}
          currentSub={currentSub}
          folderName={folderName}
          playing={playing}
          query={query}
          onQueryChange={setQuery}
          onOpen={openTrack}
          onPlayFolder={onPlayFolder}
          collapsed={listCollapsed}
          onToggleCollapse={toggleList}
        />

        {/* @container — 뷰어 칸 폭(분할·좁은 문서 창)에 맞춘다. 화면 폭 기준(md:·xl:)이면 좁은 칸에서 큰 커버가 글 칸을 0으로 눌렀다. */}
        <div className="@container flex min-w-0 flex-1 flex-col">
          {failure ?? (
            <>
              {/* 히어로 — 커버 | 지금 재생 중 · 제목 · 아티스트 · 앨범/연도 · 장르 · 파일 위치 */}
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-hidden px-6 py-4 @lg:flex-row @lg:gap-8 @3xl:gap-10 @3xl:px-8">
                <div
                  data-gpv="audio-cover"
                  className="size-32 shrink-0 overflow-hidden rounded-lg border border-edge bg-raised shadow-lg @lg:size-40 @3xl:size-56 @5xl:size-72"
                >
                  {cover.data ? (
                    <img src={cover.data} alt={ap.coverAlt} className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-fg-dim">
                      <Music size={56} strokeWidth={1.25} />
                    </div>
                  )}
                </div>
                <div className="w-full min-w-0 max-w-md text-center @lg:w-auto @lg:flex-1 @lg:text-left">
                  <div className="text-[11px] font-semibold tracking-wider text-accent">
                    {ap.nowPlaying(curIdx + 1, tracks.length)}
                  </div>
                  <h2 data-gpv="audio-title" className="mt-2 truncate text-2xl font-bold text-fg @3xl:text-3xl" title={title}>
                    {title}
                  </h2>
                  {tags?.artist && <div className="mt-1.5 truncate text-base text-fg-muted">{tags.artist}</div>}
                  {albumLine && <div className="mt-0.5 truncate text-sm text-fg-dim">{albumLine}</div>}
                  {tags?.genre && (
                    <span className="mt-4 inline-block rounded-full border border-edge px-2.5 py-0.5 text-xs text-fg-muted">
                      {tags.genre}
                    </span>
                  )}
                  <div>
                    <button
                      onClick={revealFile}
                      className="mt-4 inline-flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
                    >
                      <FolderOpen size={13} /> {ap.revealInFolder}
                    </button>
                  </div>
                </div>
              </div>

              {/* 파형 진행바 + 경과/전체 */}
              <div className="shrink-0 px-6 pb-3 @3xl:px-8">
                <WaveformSeek
                  peaks={waveform.data ?? []}
                  time={time}
                  duration={duration}
                  label={ap.seekLabel}
                  onSeek={seekTo}
                />
                <div className="mt-1.5 flex justify-between font-mono text-xs tabular-nums">
                  <span className="font-semibold text-fg">{clock(time)}</span>
                  <span className="text-fg-dim">{clock(duration)}</span>
                </div>
              </div>

              {/* 재생바 — 다음 곡 | 트랜스포트 | 배속·볼륨. flex-wrap: 좁은 칸에서 오른쪽 도구가 잘리는 대신 다음 줄로(VideoPlayer와 같다). */}
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge px-4 py-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-dim">
                  {nextTrack && (
                    <>
                      <SkipForward size={11} className="shrink-0" />
                      <span className="truncate">{ap.upNext(nextTrack.label)}</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    data-gpv="audio-shuffle"
                    onClick={toggleShuffle}
                    aria-pressed={prefs.shuffle}
                    title={ap.shuffleTitle}
                    className={`${iconBtn} ${prefs.shuffle ? "bg-raised text-accent" : ""}`}
                  >
                    <Shuffle size={15} />
                  </button>
                  <button data-gpv="audio-prev" onClick={() => goStep(-1)} title={ap.prevTitle} className={iconBtn}>
                    <SkipBack size={15} />
                  </button>
                  <SkipBtn secs={-10} label="10s" onSkip={seekBy} />
                  <button
                    data-gpv="audio-play"
                    onClick={togglePlay}
                    title={tp.playPause}
                    className="mx-1.5 grid h-11 w-11 place-items-center rounded-full bg-accent text-on-accent shadow hover:bg-accent-hover"
                  >
                    {playing ? (
                      <Pause size={18} fill="currentColor" />
                    ) : (
                      <Play size={18} fill="currentColor" className="translate-x-px" />
                    )}
                  </button>
                  <SkipBtn secs={10} label="10s" onSkip={seekBy} />
                  <button data-gpv="audio-next" onClick={() => goStep(1)} title={ap.nextTitle} className={iconBtn}>
                    <SkipForward size={15} />
                  </button>
                  <button
                    data-gpv="audio-repeat"
                    data-mode={prefs.repeat}
                    onClick={cycleRepeat}
                    aria-pressed={prefs.repeat !== "off"}
                    title={ap.repeatTitle[prefs.repeat]}
                    className={`${iconBtn} ${prefs.repeat !== "off" ? "bg-raised text-accent" : ""}`}
                  >
                    <RepeatIcon size={15} />
                  </button>
                </div>
                <div className="flex flex-1 items-center justify-end gap-2">
                  <button
                    onClick={cycleRate}
                    title={ap.rateTitle}
                    className="min-w-12 rounded-md border border-edge bg-panel px-2 py-1 font-mono text-xs font-semibold text-fg hover:bg-raised"
                  >
                    {prefs.rate}x
                  </button>
                  <div className="flex items-center gap-1.5 rounded-md border border-edge bg-panel px-1.5 py-1">
                    <button onClick={toggleMute} title={tp.muteTitle} className="text-fg-dim hover:text-fg">
                      <VolumeIcon size={14} />
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={prefs.muted ? 0 : prefs.volume}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setPrefs((p) => ({ ...p, volume: v, muted: false }));
                      }}
                      aria-label={ap.volume}
                      title={ap.volume}
                      className="h-1 w-20 cursor-pointer accent-accent"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <PlayerStatusBar
        status={playing ? { text: ap.statusPlaying, tone: "ok" } : { text: ap.statusPaused, tone: "warn" }}
        items={[
          {
            label: tp.statusCodec,
            value: meta ? [meta.acodec ?? "?", meta.bitrateKbps ? `${meta.bitrateKbps} kbps` : null].filter(Boolean).join(" · ") : "—",
          },
          { label: ap.statusTracks, value: ap.statusTrackCount(tracks.length) },
        ]}
        shortcuts={[
          { keys: "Space", label: tp.shortcuts.play },
          { keys: "← / →", label: ap.shortcuts.seek },
          { keys: "N / P", label: ap.shortcuts.nextPrev },
          { keys: "L", label: ap.shortcuts.repeat },
        ]}
      />

      {url && !playError && (
        <audio
          ref={bindMedia}
          src={url}
          preload="metadata"
          onError={onError}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            // Infinity 방어(스트리밍·Duration 없는 컨테이너) — VideoPlayer와 같은 이유.
            setDuration(Number.isFinite(el.duration) ? el.duration : 0);
            el.volume = prefs.volume;
            el.muted = prefs.muted;
            el.playbackRate = prefs.rate;
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          // load()는 pause 이벤트 없이 정지시킨다 — emptied로 상태를 정직하게 유지.
          onEmptied={() => setPlaying(false)}
          onEnded={onEnded}
          onCanPlay={(e) => {
            // 로드 성공 시 오류 복구 1회권 재장전 — 긴 세션의 다음 서버 교체도 복구되게.
            retriedRef.current = false;
            // 트리에서 곡을 고르면 바로 재생한다 — 파일당 한 번, 재시작 복원 탭은 제외.
            // 규칙과 이유는 VideoPlayer의 onCanPlay(재발급 복구로 canplay가 또 와도 세워 둔 곡을
            // 다시 틀지 않는다 · lib/engagement.ts 관문). 곡 전환 뒤 연속 재생도 이 규칙이 잇는다.
            if (!autoplayedRef.current) {
              autoplayedRef.current = true;
              const el = e.currentTarget;
              // 정책에 막히면 일시정지로 남는다(= 종전 동작) — 알릴 것이 없다.
              if (hasUserEngaged() && el.paused) playQuietly(el);
            }
          }}
        />
      )}
    </div>
  );
}
