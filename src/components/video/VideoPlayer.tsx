// 동영상 플레이어 (DOCS/video-editor-design.md L1) — 커스텀 컨트롤 + 타임라인 + 구간(A-B).
//
// - 스트리밍은 MediaView와 같은 루프백 Range 경로(previewLocalUrl). 유휴 사망 시 1회 재발급.
// - 하나의 In/Out 구간이 반복 재생(⑤)과 클립 추출(①)의 공용 입력이다(설계 결정 3).
// - 단축키는 window가 아니라 **포커스된 컨테이너**에 바인딩 — 전역 Ctrl+W(탭 닫기) 등과 충돌 없음.
// - 확대(F)는 OS 전체화면이 아니라 앱 내 오버레이(WKWebView requestFullscreen 신뢰 불가) —
//   네이티브 자식 webview 점유는 useOccludesWebview로 등록한다(ui.ts 차단 오버레이 계약).
import { listen } from "@tauri-apps/api/event";
import {
  ExternalLink,
  FileVideo2,
  FileWarning,
  Loader2,
  Maximize2,
  Minimize2,
  ChevronsLeft,
  ChevronsRight,
  Pause,
  Play,
  Repeat,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { markLocalVideoJob } from "../../lib/events";
import { openDocWindow } from "../../lib/floating";
import type { VideoExportFinished, VideoExportSpec, VideoFilmstrip } from "../../lib/ipc";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import {
  useDir,
  useVideoFilmstrip,
  useVideoProbe,
  useVideoToolStatus,
  useVideoWaveform,
} from "../../queries";
import { isVideo } from "../../lib/language-map";
import { useDb } from "../../stores/db";
import { planSegments, type SplitSegment } from "../../stores/videoSplit";
import { useOcclusion, useOccludesWebview } from "../../stores/occlusion";
import { selectBlockingOverlay, useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { CropOverlay, type CropRect } from "./CropOverlay";
import { LibraryRail, type RailClip, type RailMedia } from "./LibraryRail";
import { PlayerStatusBar } from "./PlayerStatusBar";
import { ExportPanel } from "./ExportPanel";

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

/** 123.456초 → "2:03.4" (시간 단위는 필요할 때만).
 *  0.1초 단위로 먼저 반올림한 뒤 분해한다 — 초를 나중에 반올림하면 "1:60.0"이 나온다. */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const tot = Math.round(sec * 10); // 0.1초 단위
  const h = Math.floor(tot / 36_000);
  const m = Math.floor((tot % 36_000) / 600);
  const s = (tot % 600) / 10;
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 파일 전환 리셋 전용 빈 값 — 매번 `[]`를 새로 만들면 히스토리 기준(baseRef)과 참조가
 *  달라져, 파일을 여는 것만으로 "편집됨" 항목이 하나 쌓인다. */
const NO_TICKS: number[] = [];
const NO_MASKS: CropRect[] = [];

const btnCls =
  "rounded px-1.5 py-1 text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-40";

/** 확정된 영역 배지 — **편집 모드가 아닐 때도** 어디를 지정했는지 화면에 남긴다.
 *  크롭 사각형이 CropOverlay 안에만 있어서, 가리기로 전환하면 오버레이가 언마운트되며
 *  사각형이 통째로 사라졌다. 툴바의 `332×536` 숫자만 남아 위치를 알 길이 없었다(2026-09-03). */
function RegionBox({
  rect,
  videoW,
  videoH,
  tone,
  label,
  onRemove,
}: {
  rect: CropRect;
  videoW: number;
  videoH: number;
  /** accent=추출(크롭) · warn=가림. 툴바 버튼 색과 같은 규칙이라 눈으로 연결된다. */
  tone: "accent" | "warn";
  label: string;
  /** 없으면 삭제 버튼을 그리지 않는다(그리기 중엔 드래그를 방해하므로). */
  onRemove?: () => void;
}) {
  const isCrop = tone === "accent";
  return (
    <div
      className={`absolute ${isCrop ? "border border-accent" : "border border-dashed border-warn bg-warn/15"}`}
      style={{
        left: `${(rect.x / videoW) * 100}%`,
        top: `${(rect.y / videoH) * 100}%`,
        width: `${(rect.w / videoW) * 100}%`,
        height: `${(rect.h / videoH) * 100}%`,
      }}
    >
      <div
        className={`pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-panel px-1 text-[10px] ${
          isCrop ? "text-accent" : "text-warn"
        }`}
      >
        {label}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          title={`${label} 제거`}
          className="pointer-events-auto absolute -right-2 -top-2 grid h-4 w-4 place-items-center rounded-full border border-edge bg-panel text-fg-dim hover:text-fg"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

export default function VideoPlayer({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const pushToast = useUi((s) => s.pushToast);
  const [url, setUrl] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [playError, setPlayError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const retriedRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [inPt, setInPt] = useState<number | null>(null);
  const [outPt, setOutPt] = useState<number | null>(null);
  // 분할 타임틱(초) — **미정렬**로 둔다: 드래그 중 배열 인덱스가 흔들리면 잡고 있던 마커가
  // 손에서 빠져나간다. 정렬·병합은 planSegments 안에서만 한다(태스크 22 §3.5).
  const [ticks, setTicks] = useState<number[]>([]);
  const [loopOn, setLoopOn] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railQuery, setRailQuery] = useState("");
  const [zoomPct, setZoomPct] = useState(100);
  // 클립 미리보기 — ▷를 누른 클립의 **끝에서 자동 정지**한다.
  // 경계 검사는 rAF 안에서 하므로 끝 시각은 ref로 든다: state로 잡으면 그 effect가 playing에만
  // 의존해서 클립을 바꿔도 루프가 옛 값을 계속 본다(닫힌 클로저).
  const clipEndRef = useRef<number | null>(null);
  const [clipPlaying, setClipPlaying] = useState<number | null>(null);
  // 구간 지정 모드 — 버튼은 켜기만 하고, 실제 지정은 타임라인에서 한다(영역·가리기와 같은 관례).
  const [rangeActive, setRangeActive] = useState(false);

  const [cropActive, setCropActive] = useState(false);
  const [crop, setCrop] = useState<CropRect | null>(null);
  // 가림 영역들(원본 video px) — crop과 같은 좌표계, 개수 제한 없음.
  const [masks, setMasks] = useState<CropRect[]>([]);
  const [maskKind, setMaskKind] = useState<"mosaic" | "blur">("mosaic");

  // ── 되돌리기 / 다시 실행 ────────────────────────────────────────────────────
  // 대상은 **편집 의도**뿐이다: 구간 · 분할 지점 · 크롭 · 가림. 재생 위치·줌·모드는 넣지 않는다
  // (스크럽 한 번에 히스토리가 수백 개가 되고, 되돌리기가 화면을 제멋대로 움직인다).
  // 내보내기·분할 저장은 파일을 쓰므로 애초에 되돌릴 수 없다 — 넣지 않는다.
  const editSnap = useMemo(
    () => ({ inPt, outPt, ticks, crop, masks, maskKind }),
    [inPt, outPt, ticks, crop, masks, maskKind],
  );
  type EditSnap = typeof editSnap;
  const pastRef = useRef<EditSnap[]>([]);
  const futureRef = useRef<EditSnap[]>([]);
  const baseRef = useRef<EditSnap>(editSnap);
  // 스택 길이를 state로 둔다 — 버튼 활성 상태의 근거인데, ref 변경만으로는 리렌더가 없다.
  const [hist, setHist] = useState({ past: 0, future: 0 });
  const syncHist = () =>
    setHist({ past: pastRef.current.length, future: futureRef.current.length });

  // 참조 비교로 충분하다 — 되돌릴 때 **같은 배열·객체를 그대로** 되돌려 놓기 때문이다.
  const sameSnap = (a: EditSnap, b: EditSnap) =>
    a.inPt === b.inPt &&
    a.outPt === b.outPt &&
    a.ticks === b.ticks &&
    a.crop === b.crop &&
    a.masks === b.masks &&
    a.maskKind === b.maskKind;

  // 350ms 멈춘 뒤에 한 항목으로 기록한다. 드래그 한 번은 포인터 이동 수십 번이라,
  // 그대로 쌓으면 원래대로 가는 데 Ctrl+Z를 수십 번 눌러야 한다.
  useEffect(() => {
    if (sameSnap(baseRef.current, editSnap)) return;
    const t = setTimeout(() => {
      pastRef.current.push(baseRef.current);
      if (pastRef.current.length > 200) pastRef.current.shift();
      futureRef.current = []; // 새 편집이 들어오면 앞선 redo 가지는 버린다(표준 동작)
      baseRef.current = editSnap;
      syncHist();
    }, 350);
    return () => clearTimeout(t);
  }, [editSnap]);

  // 파일이 바뀌면 히스토리를 버린다 — 다른 영상의 구간을 이 영상에 되돌려 놓을 수는 없다.
  useEffect(() => {
    pastRef.current = [];
    futureRef.current = [];
    baseRef.current = { inPt: null, outPt: null, ticks: NO_TICKS, crop: null, masks: NO_MASKS, maskKind };
    setHist({ past: 0, future: 0 });
    // maskKind는 파일 전환에 초기화하지 않으므로 현재 값을 그대로 기준에 넣는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const applySnap = (snap: EditSnap) => {
    baseRef.current = snap; // 기준을 **먼저** 옮긴다 — 아래 setter가 만든 변화를 새 편집으로 오해하지 않게
    setInPt(snap.inPt);
    setOutPt(snap.outPt);
    setTicks(snap.ticks);
    setCrop(snap.crop);
    setMasks(snap.masks);
    setMaskKind(snap.maskKind);
    syncHist();
  };
  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) return false;
    futureRef.current.push(baseRef.current);
    applySnap(prev);
    return true;
  }, []);
  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return false;
    pastRef.current.push(baseRef.current);
    applySnap(next);
    return true;
  }, []);
  const [maskActive, setMaskActive] = useState(false);

  // 확대 오버레이가 네이티브 자식 webview(내장 브라우저) 위에 보이도록 점유 등록.
  useOccludesWebview(expanded);

  const tool = useVideoToolStatus();
  const canEdit = !!tool.data?.found && !!tool.data?.probeFound;
  const probe = useVideoProbe(projectId, path, canEdit);
  // 타임라인 트랙 자산 — 파일당 한 번. ffmpeg 스폰이라 **편집 패널이 열렸을 때만** 뽑는다
  // (뷰어에서 영상 훑기만 하는 사용자에게 매번 ffmpeg를 띄우면 프로세스 위생에 어긋난다).
  const filmstrip = useVideoFilmstrip(projectId, path, 60, 64, editOpen && !!probe.data);
  const waveform = useVideoWaveform(projectId, path, 900, editOpen && !!probe.data?.hasAudio);
  const fps = probe.data && probe.data.fps > 0 ? probe.data.fps : 30;

  /** 루프백 URL 발급 — 서버가 살아 있으면 같은 URL이 돌아와 멱등(MediaView와 동일). */
  const mint = useCallback(async () => {
    try {
      const u = await ipc.previewLocalUrl(projectId, path);
      setUrl(u);
      setMintError(null);
      return u;
    } catch (e) {
      setMintError(errorMessage(e));
      return null;
    }
  }, [projectId, path]);

  // 파일이 바뀌면 전부 리셋.
  useEffect(() => {
    setUrl(null);
    setMintError(null);
    setPlayError(false);
    retriedRef.current = false;
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setInPt(null);
    setOutPt(null);
    setTicks(NO_TICKS);
    setLoopOn(false);
    setCrop(null);
    setCropActive(false);
    setMasks(NO_MASKS);
    setMaskActive(false);
    clipEndRef.current = null;
    setClipPlaying(null);
    setRangeActive(false);
    void mint();
  }, [mint]);

  // 파일을 열면 바로 단축키가 듣도록 컨테이너에 포커스 — 클릭 없이 Space/←→ 사용 가능.
  // url이 조건: url 전엔 EmptyState 분기라 컨테이너가 아직 없다(마운트 직후 no-op 방지).
  useEffect(() => {
    if (url) containerRef.current?.focus();
  }, [path, url]);

  // 프리뷰 서버 keep-alive — 영상 탭이 열려 있는 동안은 서버가 "사용 중"이다. 긴 영상은
  // 브라우저가 잔뜩 선버퍼한 뒤 10분 넘게 조용해질 수 있는데, 그때 유휴 종료로 서버가
  // 죽으면 다음 탐색이 연결 거부 → 미디어 오류가 된다(1시간짜리 실파일에서 실사례).
  // mint는 멱등이고 기존 서버의 유휴 시계를 리셋한다(preview.rs). CSP connect-src가
  // 루프백 fetch를 막으므로 HEAD 핑 대신 mint를 쓴다.
  useEffect(() => {
    const id = window.setInterval(
      () => void ipc.previewLocalUrl(projectId, path).catch(() => {}),
      4 * 60_000,
    );
    return () => window.clearInterval(id);
  }, [projectId, path]);

  // Space 재생/정지 **전역** — 포커스가 플레이어 밖(파일트리·로그 패널 등)으로 옮겨가도 듣는다.
  // 컨테이너 내부 포커스는 컨테이너 onKeyDown이 처리하므로 건너뛴다(이중 토글 방지).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.repeat) return; // 꾹 누름 자동 반복이 재생/정지를 파닥거리게 하면 안 된다
      // 플레이어가 실제로 보일 때만 — 다른 워크스페이스 탭이 활성이면 ViewerTab이
      // display:none으로 마운트 유지되는데(WorkspaceTabs), 그때 Space가 보이지도 않는
      // 영상을 토글하면 소리만 난다. 에러/로딩 분기(containerRef 없음)도 여기서 걸러진다.
      const box = containerRef.current;
      if (!box || box.offsetWidth === 0) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      // 입력 요소·버튼은 자기 의미(입력·활성화)가 우선. 터미널(xterm)·에디터(monaco)는 TEXTAREA.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      if (t?.isContentEditable) return;
      if (t && box.contains(t)) return; // 내부는 컨테이너 핸들러 담당
      // 모달 위에선 양보 — ui 모달들 + DB 다이얼로그 + 로컬 메뉴(occlusion 카운터)까지.
      // selectBlockingOverlay 하나만 보면 DB 다이얼로그가 새는 것이 확인된 갭이다.
      if (
        selectBlockingOverlay(useUi.getState()) ||
        !!useDb.getState().dialog ||
        useOcclusion.getState().count > 0
      )
        return;
      e.preventDefault();
      const el = videoRef.current;
      if (!el) return;
      if (el.paused) void el.play().catch(() => {});
      else el.pause();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 재생 중 부드러운 플레이헤드 — timeupdate(~4Hz)만으로는 눈금자 위 헤드가 뚝뚝 끊긴다.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = videoRef.current;
      if (el) {
        setTime(el.currentTime);
        // 클립 끝에서 정지. timeupdate(~4Hz)로 하면 최대 250ms를 넘겨 다음 클립이 먼저 보인다.
        // ref를 먼저 비워 다음 프레임에 또 들어오지 않게 한다.
        const end = clipEndRef.current;
        if (end != null && el.currentTime >= end) {
          clipEndRef.current = null;
          el.pause();
          el.currentTime = end;
          setTime(end);
          setClipPlaying(null);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  /** 죽은 프리뷰 서버·일시적 네트워크 오류 복구 — 재발급 후 위치·재생 상태까지 복원한다.
   *  서버가 살아 있으면 재발급 URL이 **동일**해 src 변경으로는 재로드가 안 일어난다 —
   *  load()를 명시 호출해야 재시도가 된다. load()는 pause 이벤트 **없이** 정지시키므로
   *  재생 중이었으면 play()로 재개해야 한다 — 안 하면 UI는 ⏸(재생 중)인데 영상은 멈춘
   *  어긋난 상태로 남는다(1시간짜리 실파일에서 실사례). 복구가 성공(onCanPlay)하면
   *  retriedRef를 재장전해 긴 세션의 다음 오류도 다시 한 번 복구할 수 있다. */
  const onError = () => {
    const el = videoRef.current;
    if (retriedRef.current || !el) {
      setPlayError(true);
      return;
    }
    retriedRef.current = true;
    const at = el.currentTime;
    // 치명 오류로 멈춰도 paused는 false로 남는다 — "재생 중이었나"의 판단 근거로 쓸 수 있다.
    const wasPlaying = !el.paused;
    void mint().then((u) => {
      if (!u) {
        setPlayError(true);
        return;
      }
      requestAnimationFrame(() => {
        const m = videoRef.current;
        if (!m) return;
        m.load();
        if (at > 0) m.currentTime = at;
        if (wasPlaying) void m.play().catch(() => {});
      });
    });
  };

  const openExternally = () => {
    void ipc
      .runExecutable(projectId, path)
      .catch((e) => pushToast("error", errorMessage(e)));
  };

  // ── mp4로 변환해 열기 (재생 실패 폴백 — 태스크 35 §2.3) ──
  // 웹뷰가 못 푸는 컨테이너(avi/wmv/flv …)를 ffmpeg로 mp4로 만들어 **새 doc 창**에서 연다.
  // 종결은 video://export-finished가 진실이고 invoke 완주는 보조다(ExportPanel과 같은 계약,
  // Windows 응답 유실 §10) — 어느 쪽이 먼저 와도 ref 가드로 한 번만 처리한다.
  const convertRef = useRef<{ id: string; outRel: string } | null>(null);
  const [converting, setConverting] = useState(false);

  const finishConvert = useCallback(
    (jobId: string, ok: boolean) => {
      const job = convertRef.current;
      if (!job || job.id !== jobId) return;
      convertRef.current = null;
      setConverting(false);
      // 실패 토스트는 events.ts 전역 핸들러가 이미 띄운다 — 여기는 버튼만 되돌린다.
      if (ok) openDocWindow(projectId, job.outRel, { size: [1180, 860] });
    },
    [projectId],
  );

  useEffect(() => {
    if (!converting) return;
    // listen()이 resolve되기 전에 정리가 먼저 돌 수 있다(ExportPanel과 같은 처리).
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<VideoExportFinished>("video://export-finished", (e) => {
      finishConvert(e.payload.jobId, e.payload.ok);
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [converting, finishConvert]);

  const convertToMp4 = async () => {
    if (convertRef.current) return;
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    // 재생이 안 되는 파일이라도 ffprobe는 대개 읽는다 — 실패하면 진행률 분모만 잃는다(0).
    const meta = await ipc.videoProbe(projectId, path).catch(() => null);
    const spec = (outRel: string): VideoExportSpec => ({
      srcRel: path,
      outRel,
      overwrite: false,
      range: null,
      mode: "encode",
      speed: null,
      crop: null,
      // 재생 불가 파일의 mp4 변환 — 편집이 아니라 컨테이너/코덱 정규화라 가림은 없다.
      masks: null,
      maskKind: "mosaic",
      crf: null,
      maxHeight: null,
      removeAudio: false,
      durationMs: meta?.durationMs ?? 0,
      hasAudio: meta?.hasAudio ?? true,
    });
    const start = (outRel: string) => {
      const id = crypto.randomUUID();
      convertRef.current = { id, outRel };
      setConverting(true);
      markLocalVideoJob(id); // 완료 토스트는 이 창에서만
      return ipc
        .videoExport(projectId, id, spec(outRel))
        .then(() => finishConvert(id, true))
        .catch((e) => {
          // AlreadyExists만 종결 이벤트가 없다(video.rs 계약) — 여기서 직접 되돌린다.
          finishConvert(id, false);
          throw e;
        });
    };
    try {
      await start(`${dir}${stem}.mp4`);
    } catch (e) {
      if (!(isIpcError(e) && e.code === "ALREADY_EXISTS")) return;
      // 같은 이름이 이미 있다 — 덮어쓰지 않고 옆에 만든다(원본을 지우지 않는 것이 우선).
      await start(`${dir}${stem} (변환).mp4`).catch((e2) => {
        if (isIpcError(e2) && e2.code === "ALREADY_EXISTS")
          pushToast("error", `${stem} (변환).mp4 파일이 이미 있습니다`);
      });
    }
  };

  // ── 트랜스포트 ──
  const seekTo = (t: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.min(Math.max(t, 0), duration || el.duration || 0);
    setTime(el.currentTime);
    // 사용자가 직접 탐색했는데 옛 클립 경계가 살아 있으면 엉뚱한 데서 갑자기 멈춘다.
    if (clipEndRef.current != null) {
      clipEndRef.current = null;
      setClipPlaying(null);
    }
  };

  /** 레일의 ▷ — 클립 시작으로 이동해 재생하고 끝에서 멈춘다. 재생 중 다시 누르면 정지. */
  const playClip = useCallback(
    (c: RailClip) => {
      const el = videoRef.current;
      if (!el) return;
      if (clipPlaying === c.index && !el.paused) {
        el.pause();
        clipEndRef.current = null;
        setClipPlaying(null);
        return;
      }
      // seekTo를 안 쓴다 — 그쪽은 방금 세운 경계를 도로 지운다.
      el.currentTime = Math.min(Math.max(c.startMs / 1000, 0), duration || el.duration || 0);
      setTime(el.currentTime);
      clipEndRef.current = c.endMs / 1000;
      setClipPlaying(c.index);
      void el.play().catch(() => {});
    },
    [clipPlaying, duration],
  );
  const seekBy = (d: number) => seekTo((videoRef.current?.currentTime ?? 0) + d);
  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };
  /** 프레임 스텝 — HTML5엔 프레임 정확 API가 없어 1/fps 근사(probe 없으면 30fps 가정). */
  const frameStep = (dir: 1 | -1) => {
    videoRef.current?.pause();
    seekBy(dir / fps);
  };
  const markIn = () => {
    const t = videoRef.current?.currentTime ?? time;
    setInPt(t);
    if (outPt != null && outPt <= t) setOutPt(null);
  };
  const markOut = () => {
    const t = videoRef.current?.currentTime ?? time;
    setOutPt(t);
    if (inPt != null && inPt >= t) setInPt(null);
  };
  /** 구간 지정 모드 토글. 켜면 타임라인이 크로스헤어가 되고, 거기서 정할 때까지 유지된다 —
   *  버튼으로 돌아와 두 번 누를 필요가 없다. 오버레이 모드들과는 배타(포인터가 하나뿐이다). */
  const toggleRange = () => {
    setCropActive(false);
    setMaskActive(false);
    setRangeActive((v) => !v);
  };

  // 시작·끝이 다 찍히면 모드를 끈다. 드래그든 클릭 두 번이든 I/O 키든 경로를 안 가린다 —
  // 종료 조건을 각 경로에 흩어 두면 하나가 빠져 모드가 남는다.
  useEffect(() => {
    if (rangeActive && inPt != null && outPt != null) setRangeActive(false);
  }, [rangeActive, inPt, outPt]);

  /** 현재 위치에 분할 틱 추가 — 100ms 안에 이미 있으면 무시(같은 자리 중복 방지). */
  const addTick = () => {
    const t = videoRef.current?.currentTime ?? time;
    setTicks((p) => (p.some((x) => Math.abs(x - t) < 0.1) ? p : [...p, t]));
  };
  const changeRate = (r: number) => {
    setRate(r);
    const el = videoRef.current;
    if (el) el.playbackRate = r;
  };
  const stepRate = (dir: 1 | -1) => {
    const i = RATES.indexOf(rate);
    const next = RATES[Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))];
    changeRate(next);
  };
  const toggleMute = () => {
    const el = videoRef.current;
    const next = !muted;
    setMuted(next);
    if (el) el.muted = next;
  };

  // ExportPanel(memo)에 주는 함수 props — 재생 중 rAF 60fps 리렌더가 패널까지 번지지 않게
  // 참조를 고정한다(전부 ref/함수형 setState만 사용해 deps 없음).
  const clearRange = useCallback(() => {
    setInPt(null);
    setOutPt(null);
    setLoopOn(false);
  }, []);
  const toggleCrop = useCallback(() => {
    videoRef.current?.pause();
    setMaskActive(false); // 오버레이는 하나뿐 — 두 모드는 배타다.
    setCropActive((v) => !v);
  }, []);
  const clearCrop = useCallback(() => {
    setCrop(null);
    setCropActive(false);
  }, []);
  const toggleMask = useCallback(() => {
    videoRef.current?.pause();
    setCropActive(false);
    setMaskActive((v) => !v);
  }, []);
  const clearMasks = useCallback(() => {
    setMasks([]);
    setMaskActive(false);
  }, []);
  const removeMask = useCallback((i: number) => setMasks((p) => p.filter((_, j) => j !== i)), []);
  const addMask = useCallback(
    (r: CropRect | null) => r && setMasks((p) => [...p, r]),
    [],
  );
  // In/Out 해제(clearRange)와는 무관한 별도 동작 — 구간과 틱은 서로 독립이다.
  const clearTicks = useCallback(() => setTicks([]), []);
  /** 분할 경계로 잘린 구간 — 틱이 없으면 전체 1개. 타임라인 V1 클립 표시와 같은 근거를 쓴다
   *  (패널의 "틱 N개 → M개 파일"과 어긋나지 않게 planSegments 하나만 본다). */
  const segments = useMemo(() => planSegments(ticks, duration), [ticks, duration]);

  // 라이브러리 레일 — 같은 폴더의 다른 영상. 별도 IPC 없이 파일트리가 이미 쓰는 dir 쿼리를
  // 재사용한다(워처가 신선도를 책임지므로 여기서 재조회 정책을 또 만들 필요가 없다).
  const dirRel = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const dir = useDir(projectId, dirRel);
  const railMedia: RailMedia[] = useMemo(() => {
    const prefix = dirRel ? `${dirRel}/` : "";
    const here = path.slice(prefix.length);
    const rows = (dir.data ?? [])
      .filter((e) => !e.isDir && isVideo(e.name))
      .map((e) => ({
        path: prefix + e.name,
        name: e.name,
        // 현재 파일만 probe 값을 안다 — 나머지는 파일당 ffprobe를 띄우지 않는다(프로세스 위생).
        sub:
          e.name === here && probe.data
            ? `${fmtTime(probe.data.durationMs / 1000)} · ${probe.data.width}×${probe.data.height}`
            : "",
        active: e.name === here,
      }));
    // 목록을 못 읽었어도(권한·워처 지연) 현재 파일은 항상 보인다.
    return rows.length > 0 ? rows : [{ path, name: here, sub: "", active: true }];
  }, [dir.data, dirRel, path, probe.data]);

  const railClips: RailClip[] = useMemo(
    () =>
      ticks.length === 0
        ? []
        : segments.map((sg, i) => ({
            index: i + 1,
            label: `${String(i + 1).padStart(2, "0")} · 클립`,
            startMs: sg.startMs,
            endMs: sg.endMs,
            // 클립 색은 타임라인 마커(앰버)와 달리 클립끼리 구분이 목적이라 색상환을 돈다.
            color: `hsl(${(i * 67) % 360} 62% 58%)`,
          })),
    [segments, ticks.length],
  );
  const getTime = useCallback(() => videoRef.current?.currentTime ?? 0, []);

  // ── 단축키(포커스된 컨테이너 한정) ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // 포커스된 버튼의 Space는 그 버튼 활성화가 기대 동작 — 가로채면 키보드 탐색이 깨진다.
    if (tag === "BUTTON" && e.key === " ") return;
    // 되돌리기/다시 실행은 수정자 양보보다 **앞**이다 — 뒤에 두면 아래 return에 먹힌다.
    // 앱 어디에도 전역 Ctrl+Z가 없어 가로채도 뺏는 것이 없다(확인함).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      // Ctrl+Y와 Ctrl+Shift+Z 둘 다 받는다 — 전자는 Windows, 후자는 macOS 관례다.
      const isRedo = k === "y" || (k === "z" && e.shiftKey);
      if (isRedo || k === "z") {
        if (isRedo ? redo() : undo()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 전역 단축키(Ctrl+W 등)에 양보
    let handled = true;
    switch (e.key) {
      case " ":
      case "k":
      case "K":
        if (!e.repeat) togglePlay(); // 꾹 누름 반복 무시(화살표 시킹은 반복이 의도라 여기만)
        break;
      case "ArrowLeft":
        seekBy(e.shiftKey ? -1 : -5);
        break;
      case "ArrowRight":
        seekBy(e.shiftKey ? 1 : 5);
        break;
      case ",":
        frameStep(-1);
        break;
      case ".":
        frameStep(1);
        break;
      case "i":
      case "I":
        markIn();
        break;
      case "o":
      case "O":
        markOut();
        break;
      case "t":
      case "T":
        addTick();
        break;
      case "r":
      case "R":
        setLoopOn((v) => !v);
        break;
      case "m":
      case "M":
        toggleMute();
        break;
      case "f":
      case "F":
        setExpanded((v) => !v);
        break;
      case "-":
        stepRate(-1);
        break;
      case "=":
      case "+":
        stepRate(1);
        break;
      case "Escape":
        if (rangeActive) setRangeActive(false);
        else if (cropActive) setCropActive(false);
        else if (maskActive) setMaskActive(false);
        else if (expanded) setExpanded(false);
        else handled = false;
        break;
      default:
        if (/^[0-9]$/.test(e.key) && duration > 0) {
          seekTo((duration * Number(e.key)) / 10);
        } else {
          handled = false;
        }
    }
    if (handled) e.preventDefault();
  };

  if (mintError)
    return (
      <EmptyState icon={FileWarning} title="미디어를 준비하지 못했습니다" desc={mintError} />
    );

  if (playError)
    return (
      <EmptyState
        icon={FileWarning}
        title="이 형식은 재생할 수 없습니다"
        desc="현재 플랫폼의 웹뷰가 이 코덱을 지원하지 않습니다. 파일 자체는 정상일 수 있습니다."
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={openExternally}
              className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
            >
              <ExternalLink size={13} /> 외부 앱으로 열기
            </button>
            {/* ffmpeg가 있을 때만 — 없으면 눌러 봐야 "ffmpeg를 찾을 수 없습니다"만 나온다. */}
            {canEdit && (
              <button
                onClick={() => void convertToMp4()}
                disabled={converting}
                title="같은 폴더에 mp4로 변환해 새 창에서 엽니다 (ffmpeg)"
                className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40"
              >
                {converting ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> 변환 중…
                  </>
                ) : (
                  <>
                    <FileVideo2 size={13} /> mp4로 변환해 열기
                  </>
                )}
              </button>
            )}
          </div>
        }
      />
    );

  if (!url) return <EmptyState title="미디어 준비 중…" />;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={
        expanded
          ? "fixed inset-0 z-50 flex flex-col bg-base outline-none"
          : "flex h-full flex-col bg-base outline-none"
      }
    >
      {/* 상단 바 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-xs text-fg-dim">
        {probe.data && (
          <span className="truncate">
            {probe.data.width}×{probe.data.height} · {probe.data.fps.toFixed(2)}fps
            {probe.data.vcodec ? ` · ${probe.data.vcodec}` : ""}
            {probe.data.acodec ? `+${probe.data.acodec}` : ""}
            {probe.data.bitrateKbps ? ` · ${Math.round(probe.data.bitrateKbps / 100) / 10}Mbps` : ""}
          </span>
        )}
        <div className="flex-1" />
        {/* 모드 스위치 — 두 상태(재생/편집)뿐이다. 디자인의 "내보내기" 모드는 편집 인스펙터가
            이미 가리키는 것과 같아서, 세 번째 칸을 두면 눌러도 아무것도 안 바뀐다. */}
        <div
          role="tablist"
          aria-label="플레이어 모드"
          className="flex items-stretch overflow-hidden rounded-md border border-edge bg-panel"
        >
          <button
            role="tab"
            aria-selected={!editOpen}
            onClick={() => setEditOpen(false)}
            title="재생만 — 편집 패널을 접습니다"
            className={`flex items-center gap-1 px-2 py-0.5 ${!editOpen ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"}`}
          >
            <Play size={11} /> 재생
          </button>
          <button
            role="tab"
            aria-selected={editOpen}
            onClick={() => setEditOpen(true)}
            title="편집·내보내기 (ffmpeg)"
            disabled={!canEdit}
            className={`flex items-center gap-1 border-l border-edge px-2 py-0.5 disabled:text-fg-dim/50 ${editOpen ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"}`}
          >
            <SlidersHorizontal size={11} /> 편집
          </button>
        </div>
        <button
          onClick={openExternally}
          title="시스템 기본 앱으로 열기"
          className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={12} /> 외부 앱
        </button>
      </div>

      {/* 본문 — 좌 라이브러리 레일 | 중앙(스테이지+타임라인) | 우 인스펙터.
          레일과 인스펙터는 shrink-0 고정폭, 중앙만 min-w-0으로 줄어든다(안 그러면 필름스트립
          스프라이트가 컨테이너를 밀어 가로 스크롤이 생긴다). */}
      <div className="flex min-h-0 flex-1">
        <LibraryRail
          media={railMedia}
          clips={railClips}
          query={railQuery}
          onQueryChange={setRailQuery}
          onOpen={(p) => openDocWindow(projectId, p)}
          onPlayClip={playClip}
          playingClip={clipPlaying}
          onSaveAllSplits={() => {
            // 분할 실행은 인스펙터가 폴더명·모드를 들고 있다 — 레일은 거기로 안내만 한다.
            setEditOpen(true);
            pushToast("info", "우측 자르기 탭에서 폴더와 방식을 확인하고 분할 저장을 누르세요.");
          }}
          saveDisabled={ticks.length === 0}
          collapsed={railCollapsed}
          onToggleCollapse={() => setRailCollapsed((v) => !v)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
      {/* 영상 영역 */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-3"
        onClick={(e) => {
          // 빈 영역 클릭 → 재생 토글(크롭 중엔 방해 금지). 컨테이너에 포커스도 준다.
          containerRef.current?.focus();
          if (!cropActive && !maskActive && e.target === e.currentTarget) togglePlay();
        }}
      >
        <div className="relative inline-flex max-h-full max-w-full">
          <video
            ref={videoRef}
            src={url}
            preload="metadata"
            onError={onError}
            onClick={() => {
              if (!cropActive && !maskActive) togglePlay();
            }}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              // Infinity 방어 — Duration 요소 없는 WebM(MediaRecorder 녹화물)에서 Chromium이
              // duration=Infinity를 준다. 통과시키면 눈금 생성 루프가 무한이 돼 앱이 얼어붙는다.
              setDuration(Number.isFinite(el.duration) ? el.duration : 0);
              el.playbackRate = rate;
              el.muted = muted;
            }}
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              setTime(el.currentTime);
              // 구간 반복 — timeupdate(~250ms) 정밀도.
              // 클립 미리보기 중이면 구간 반복이 이기면 안 된다 — 되감으면 영원히 안 멈춘다.
              if (
                clipEndRef.current == null &&
                loopOn &&
                inPt != null &&
                outPt != null &&
                el.currentTime >= outPt
              )
                el.currentTime = inPt;
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            // load()는 pause 이벤트 없이 정지시킨다 — emptied로 상태를 정직하게 유지.
            onEmptied={() => setPlaying(false)}
            // 로드가 성공할 때마다 오류 복구 1회권을 재장전 — 긴 재생 세션은 서버 교체가
            // 여러 번 있을 수 있다(파일당 1회 제한이면 두 번째부터 오류 화면행).
            onCanPlay={() => {
              retriedRef.current = false;
            }}
            // Out이 영상 끝과 같으면 timeupdate가 outPt에 못 미친 채 ended가 먼저 온다 —
            // 반복 중이면 여기서 되감아 재생을 이어간다.
            onEnded={(e) => {
              const el = e.currentTarget;
              if (loopOn && inPt != null && outPt != null) {
                el.currentTime = inPt;
                void el.play().catch(() => {});
              }
            }}
            className="max-h-full max-w-full"
          />
          {/* 타임코드 HUD — 프레임 번호까지. 편집 중엔 눈이 스테이지에 있어서, 아래 트랜스포트의
              숫자를 보려면 시선을 크게 옮겨야 한다(iMovie/Resolve가 오버레이를 두는 이유). */}
          {editOpen && probe.data && (
            <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-2 rounded bg-base/80 px-2 py-1 font-mono text-[11px] text-fg">
              <span className={`h-1.5 w-1.5 rounded-full ${playing ? "bg-danger" : "bg-fg-dim"}`} />
              {fmtTime(time)}
              <span className="text-fg-dim">F {Math.round(time * probe.data.fps)}</span>
            </div>
          )}
          {/* 확정된 영역들 — 결과물 미리보기가 아니라 "여기가 이렇게 처리된다"는 표시다.
              그리기 오버레이보다 **먼저** 두어 드래그를 방해하지 않는다. */}
          {probe.data && (crop || masks.length > 0) && (
            <div className="pointer-events-none absolute inset-0">
              {/* 크롭은 편집 중이면 CropOverlay가 직접(어둡게 처리까지) 그리므로 겹치지 않게 뺀다. */}
              {crop && !cropActive && (
                <RegionBox
                  rect={crop}
                  videoW={probe.data.width}
                  videoH={probe.data.height}
                  tone="accent"
                  label="추출"
                  onRemove={maskActive ? undefined : clearCrop}
                />
              )}
              {masks.map((m, i) => (
                <RegionBox
                  key={i}
                  rect={m}
                  videoW={probe.data!.width}
                  videoH={probe.data!.height}
                  tone="warn"
                  label={maskKind === "blur" ? "블러" : "모자이크"}
                  onRemove={maskActive ? undefined : () => removeMask(i)}
                />
              ))}
            </div>
          )}
          {cropActive && probe.data && (
            <CropOverlay
              videoW={probe.data.width}
              videoH={probe.data.height}
              crop={crop}
              onChange={setCrop}
            />
          )}
          {maskActive && probe.data && (
            // crop=null 고정 — 드래그를 놓을 때마다 새 영역이 커밋돼 배열에 쌓인다.
            <CropOverlay
              videoW={probe.data.width}
              videoH={probe.data.height}
              crop={null}
              onChange={addMask}
              hint="가릴 영역을 드래그하세요 · 여러 번 그리면 여러 곳 (Esc 종료)"
            />
          )}
        </div>
      </div>

      {/* 타임라인 + 컨트롤 */}
      <div className="shrink-0 border-t border-edge px-3 pb-1.5 pt-2">
        <Timeline
          onZoomChange={setZoomPct}
          rangeActive={rangeActive}
          onRangeDraft={(a, b) => {
            setInPt(a);
            setOutPt(b);
          }}
          onRangeCommit={() => setRangeActive(false)}
          filmstrip={filmstrip.data ?? null}
          waveform={waveform.data ?? []}
          segments={segments}
          vcodec={probe.data?.vcodec ?? null}
          acodec={probe.data?.acodec ?? null}
          duration={duration}
          time={time}
          playing={playing}
          inPt={inPt}
          outPt={outPt}
          onSeek={seekTo}
          // 최소 구간 0.1초 — 드래그로 In==Out을 만들면 반복 재생이 그 지점에 영원히 고정된다.
          onDragIn={(t) => setInPt(Math.max(0, Math.min(t, (outPt ?? duration) - 0.1)))}
          onDragOut={(t) => setOutPt(Math.min(duration, Math.max(t, (inPt ?? 0) + 0.1)))}
          ticks={ticks}
          // 인덱스 자리에 값만 갈아끼운다 — 정렬하면 드래그 중 손에서 마커가 바뀐다.
          // 다른 마커 위로 끌어다 놓으면 중복 틱이 생기고 planSegments가 조용히 병합해
          // 파일 수가 줄어든다(마커 3개인데 3개 파일). addTick과 같은 100ms 가드를 건다.
          onDragTick={(i, t) =>
            setTicks((p) =>
              p.some((x, j) => j !== i && Math.abs(x - t) < 0.1)
                ? p
                : p.map((x, j) => (j === i ? t : x)),
            )
          }
          onRemoveTick={(i) => setTicks((p) => p.filter((_, j) => j !== i))}
          // 스크럽 후에도 화살표·프레임 스텝이 바로 듣도록 — 드래그 preventDefault가
          // 브라우저의 클릭-포커스 기본동작을 막아서 명시적으로 포커스를 준다.
          onInteract={() => containerRef.current?.focus()}
        />
        {/* flex-wrap: 좁은 패널에서 우측 도구가 화면 밖으로 잘리는 대신 다음 줄로 내려간다.
            중앙 클러스터는 mx-auto로 남는 공간의 가운데에 선다. */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-dim">
          <span className="font-mono tabular-nums">
            {fmtTime(time)} / {fmtTime(duration)}
          </span>
          {/* 중앙 트랜스포트 — 큰 원형 재생 버튼 + 5s/1m/10m 원형 스킵(길이에 맞춰 노출) */}
          <div className="mx-auto flex items-center gap-0.5">
            <button onClick={() => frameStep(-1)} title="이전 프레임 (,)" className={btnCls}>
              <SkipBack size={13} />
            </button>
            {duration >= 900 && <SkipBtn secs={-600} label="10m" onSkip={seekBy} />}
            {duration >= 90 && <SkipBtn secs={-60} label="1m" onSkip={seekBy} />}
            <SkipBtn secs={-5} label="5s" onSkip={seekBy} />
            <button
              onClick={togglePlay}
              title="재생/일시정지 (Space)"
              className="mx-1.5 grid h-10 w-10 place-items-center rounded-full bg-accent text-on-accent shadow hover:bg-accent-hover"
            >
              {playing ? (
                <Pause size={17} fill="currentColor" />
              ) : (
                <Play size={17} fill="currentColor" className="translate-x-px" />
              )}
            </button>
            <SkipBtn secs={5} label="5s" onSkip={seekBy} />
            {duration >= 90 && <SkipBtn secs={60} label="1m" onSkip={seekBy} />}
            {duration >= 900 && <SkipBtn secs={600} label="10m" onSkip={seekBy} />}
            <button onClick={() => frameStep(1)} title="다음 프레임 (.)" className={btnCls}>
              <SkipForward size={13} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            {/* 구간 지정 — 버튼 하나로 시작→끝→새 구간을 돈다. 두 칸(I·O)이던 시절엔 어느 쪽이
                다음 차례인지 화면에 없어서, 이미 찍은 I를 또 누르는 일이 잦았다. 라벨이 곧
                "다음에 찍히는 것"이라 상태가 버튼 자체에 드러난다. */}
            <button
              onClick={toggleRange}
              onContextMenu={(e) => {
                e.preventDefault();
                clearRange();
              }}
              title={
                rangeActive
                  ? "구간 지정 중 — 타임라인을 드래그하거나 두 번 클릭하세요 (Esc 취소)"
                  : inPt != null && outPt != null
                    ? `구간 ${fmtTime(inPt)} ~ ${fmtTime(outPt)} · 눌러서 다시 지정 · 우클릭 해제`
                    : "구간 지정 — 누른 뒤 타임라인에서 정합니다 (I·O 키로 직접 지정도 가능)"
              }
              aria-label={rangeActive ? "구간 지정 취소" : "구간 지정"}
              className={`${btnCls} font-semibold ${
                rangeActive
                  ? "bg-raised text-accent ring-1 ring-inset ring-accent"
                  : inPt != null && outPt != null
                    ? "text-add"
                    : ""
              }`}
            >
              구간
            </button>
            {/* 구간 해제 — 우클릭만으로는 발견이 안 된다. 지정된 상태에서만 나타난다
                (크롭·가림 해제 X와 같은 규칙). */}
            {(inPt != null || outPt != null) && (
              <button
                onClick={clearRange}
                title="구간 해제"
                aria-label="구간 해제"
                className="-m-1 p-1 text-fg-dim hover:text-fg"
              >
                <X size={11} />
              </button>
            )}
            <button
              onClick={undo}
              disabled={hist.past === 0}
              title={`되돌리기 (Ctrl+Z)${hist.past ? ` · ${hist.past}단계` : ""}`}
              aria-label="되돌리기"
              className={`${btnCls} disabled:text-fg-dim/40`}
            >
              <Undo2 size={13} />
            </button>
            <button
              onClick={redo}
              disabled={hist.future === 0}
              title="다시 실행 (Ctrl+Y)"
              aria-label="다시 실행"
              className={`${btnCls} disabled:text-fg-dim/40`}
            >
              <Redo2 size={13} />
            </button>
            <button
              onClick={() => setLoopOn((v) => !v)}
              title="구간 반복 (R)"
              disabled={inPt == null || outPt == null}
              className={`${btnCls} ${loopOn ? "text-accent" : ""}`}
            >
              <Repeat size={13} />
            </button>
            {/* 분할 틱 — 단축키 T만으로는 발견이 안 된다는 피드백(2026-09-03)으로 추가.
                틱이 있으면 앰버(타임라인 마커와 같은 색)로 켜지고 개수를 단다. */}
            <button
              onClick={addTick}
              onContextMenu={(e) => {
                e.preventDefault();
                clearTicks();
              }}
              title="여기에 분할 지점 추가 (T) · 우클릭으로 전체 삭제"
              className={`${btnCls} flex items-center gap-0.5 ${ticks.length ? "text-warn" : ""}`}
            >
              <Scissors size={13} />
              {ticks.length > 0 && (
                <span className="font-mono text-[10px] tabular-nums leading-none">
                  {ticks.length}
                </span>
              )}
            </button>
            {/* 배속 — 세그먼트 컨트롤: « 느리게 · 현재 배속(클릭=1x 복원) · 빠르게 » */}
            <div className="flex items-stretch overflow-hidden rounded-md border border-edge bg-panel">
              <button
                onClick={() => stepRate(-1)}
                disabled={rate <= RATES[0]}
                title="느리게 (-)"
                className="px-1.5 py-1 text-fg-dim hover:bg-raised hover:text-accent disabled:opacity-40"
              >
                <ChevronsLeft size={13} />
              </button>
              <button
                onClick={() => changeRate(1)}
                title="재생 배속 — 클릭하면 1x로 복원 (-/=)"
                className="flex min-w-11 items-center justify-center border-x border-edge px-1.5 font-mono text-xs font-semibold text-fg hover:bg-raised"
              >
                {rate}x
              </button>
              <button
                onClick={() => stepRate(1)}
                disabled={rate >= RATES[RATES.length - 1]}
                title="빠르게 (=)"
                className="px-1.5 py-1 text-fg-dim hover:bg-raised hover:text-accent disabled:opacity-40"
              >
                <ChevronsRight size={13} />
              </button>
            </div>
            <button onClick={toggleMute} title="음소거 (M)" className={btnCls}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <button
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "축소 (F/Esc)" : "확대 (F)"}
              className={btnCls}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
      </div>

        </div>

        {/* 편집·내보내기 인스펙터 — key=path: 파일이 바뀌면 상태(파일명·형식·수정 플래그) 전부
            리셋. 안 하면 이전 파일용으로 고친 파일명이 남아 새 영상을 엉뚱한 이름으로 내보낸다. */}
        {editOpen && (
          <div className="flex w-80 shrink-0 flex-col border-l border-edge bg-panel">
            <ExportPanel
          key={path}
          projectId={projectId}
          path={path}
          tool={tool.data}
          probe={probe.data}
          probeError={probe.error ? errorMessage(probe.error) : null}
          inPt={inPt}
          outPt={outPt}
          onClearRange={clearRange}
          ticks={ticks}
          onClearTicks={clearTicks}
          crop={crop}
          cropActive={cropActive}
          onToggleCrop={toggleCrop}
          onClearCrop={clearCrop}
          masks={masks}
          maskKind={maskKind}
          maskActive={maskActive}
          onToggleMask={toggleMask}
          onClearMasks={clearMasks}
              onSetMaskKind={setMaskKind}
              getTime={getTime}
            />
          </div>
        )}
      </div>

      <PlayerStatusBar
        status={
          probe.error
            ? { text: "메타 읽기 실패", tone: "danger" }
            : !canEdit
              ? { text: "ffmpeg 없음", tone: "warn" }
              : { text: "준비됨", tone: "ok" }
        }
        items={[
          { label: "코덱", value: probe.data ? `${probe.data.vcodec ?? "?"} · ${probe.data.acodec ?? "무음"}` : "—" },
          { label: "해상도", value: probe.data ? `${probe.data.width}×${probe.data.height}` : "—" },
          { label: "클립", value: `${segments.length}개` },
          ...(masks.length > 0
            ? [{ label: "가림", value: `${masks.length}곳 · ${maskKind === "blur" ? "블러" : "모자이크"}`, tone: "warn" as const }]
            : []),
        ]}
        shortcuts={[
          { keys: "Space", label: "재생" },
          { keys: "I / O", label: "구간 지정" },
          { keys: "T", label: "분할" },
          { keys: "Ctrl+Z", label: "되돌리기" },
          { keys: "Ctrl+Y", label: "다시 실행" },
        ]}
        zoomPct={zoomPct}
      />
    </div>
  );
}

// ── 타임라인 (DVR식 눈금자 + 플레이헤드·In/Out 배지 + 줌/팬) ──

/** 주 눈금 후보 간격(초) — 라벨 간격이 ~72px 이상이 되는 가장 촘촘한 것을 고른다. */
const TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** 줌 최소 창 — 이보다 좁게는 확대하지 않는다(프레임 단위 이하로는 의미가 없다). */
const MIN_VIEW_SECS = 0.5;

/**
 * 보이는 구간 [viewStart, viewEnd]의 눈금 — **절대 격자에 정렬**해서 줌/팬 중에도
 * 눈금이 시간축에 고정돼 보인다(창 기준으로 만들면 팬할 때 눈금이 함께 미끄러진다).
 */
function buildTicks(
  viewStart: number,
  viewEnd: number,
  width: number,
): { major: number[]; minor: number[]; step: number } {
  const span = viewEnd - viewStart;
  // Infinity/NaN 이중 방어(설정 지점에서도 걸러지지만 여기가 무한 루프의 본진이다).
  if (!Number.isFinite(span) || span <= 0 || width <= 60) return { major: [], minor: [], step: 1 };
  const step = TICK_STEPS.find((s) => (width * s) / span >= 72) ?? TICK_STEPS[TICK_STEPS.length - 1];
  // 소 눈금은 주 눈금의 1/5 — 개수는 폭에 비례해 유계(≈ width/14).
  const minorStep = step / 5;
  const major: number[] = [];
  const minor: number[] = [];
  const first = Math.ceil((viewStart - 1e-6) / minorStep);
  const last = Math.floor((viewEnd + 1e-6) / minorStep);
  for (let i = first; i <= last; i++) {
    (i % 5 === 0 ? major : minor).push(minorStep * i);
  }
  return { major, minor, step };
}

/** 눈금 라벨용 시계 표기 — "0:05" / "1:23:45". decimals는 스텝 크기에 맞춘 소수 자릿수
 *  (0.1초 미만 스텝에서 한 자리면 이웃 라벨이 같은 값으로 찍힌다). */
function fmtClock(sec: number, decimals: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function Timeline({
  duration,
  time,
  playing,
  inPt,
  outPt,
  onSeek,
  onDragIn,
  onDragOut,
  ticks: splitTicks,
  onDragTick,
  onRemoveTick,
  onInteract,
  filmstrip,
  waveform,
  segments,
  vcodec,
  acodec,
  onZoomChange,
  rangeActive,
  onRangeDraft,
  onRangeCommit,
}: {
  duration: number;
  time: number;
  playing: boolean;
  inPt: number | null;
  outPt: number | null;
  /** V1 트랙 배경 — 프레임 N장을 가로로 이어 붙인 스프라이트 1장(video_filmstrip). */
  filmstrip: VideoFilmstrip | null;
  /** A1 트랙 — 전체 길이를 buckets개로 압축한 피크(0..1). 오디오가 없으면 빈 배열. */
  waveform: number[];
  /** 분할 경계로 잘린 구간들 — 틱이 없으면 전체 1개. planSegments 결과 그대로. */
  segments: SplitSegment[];
  vcodec: string | null;
  acodec: string | null;
  /** 상태바 확대율 표시용 — 줌은 타임라인 내부 상태라 밖에서 읽을 수 없다. */
  onZoomChange: (pct: number) => void;
  /** 구간 지정 모드 — 켜져 있으면 눈금자/V1 드래그가 탐색이 아니라 구간 지정이 된다. */
  rangeActive: boolean;
  /** 지정 중인 구간(끝이 아직이면 b=null). 확정 전에도 마커가 보이게 즉시 반영한다. */
  onRangeDraft: (a: number, b: number | null) => void;
  /** 구간이 완성됐다 — 부모가 모드를 끈다. */
  onRangeCommit: () => void;
  onSeek: (t: number) => void;
  onDragIn: (t: number) => void;
  onDragOut: (t: number) => void;
  /** 분할 틱(초, 미정렬) — 인덱스가 곧 정체성이다(드래그 안정). */
  ticks: number[];
  onDragTick: (i: number, t: number) => void;
  onRemoveTick: (i: number) => void;
  onInteract: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);
  const [barW, setBarW] = useState(0);
  const [hoverT, setHoverT] = useState<number | null>(null);
  // 줌 창 [s, e] — null이면 전체 보기. 렌더 밖(휠 리스너·드래그)에서는 ref로 읽는다(스테일 방지).
  const [view, setView] = useState<{ s: number; e: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // 재생 팔로우 억제 — 드래그 중이거나 사용자가 방금 휠로 창을 만졌으면 따라가지 않는다.
  // 없으면 재생 중 팬/줌이 16ms 만에 플레이헤드 창으로 되돌아가 사용자와 싸운다(검증된 결함).
  const draggingRef = useRef(false);
  const holdUntilRef = useRef(0);

  const vs = view?.s ?? 0;
  const ve = view?.e ?? duration;
  const vlen = Math.max(ve - vs, 1e-6);

  // 파일 전환·메타 로드로 duration이 바뀌면 줌 리셋.
  useEffect(() => setView(null), [duration]);

  // 폭 실측 — 눈금 밀도가 패널 리사이즈에 따라 적응한다.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarW(el.clientWidth));
    ro.observe(el);
    setBarW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const ticks = useMemo(() => buildTicks(vs, ve, barW), [vs, ve, barW]);
  /** 보이는 창 기준 % (0~100 클램프 — 창 밖 값은 visible()로 걸러 그리지 않는다). */
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - vs) / vlen) * 100));
  const visible = (t: number) => t >= vs - 1e-6 && t <= ve + 1e-6;
  /** 미니맵(전체 축) 기준 %. */
  const fullPct = (t: number) =>
    duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0;

  // 필름스트립·파형은 **영상 전체**를 담은 정적 자산이다. 보이는 창만 잘라 다시 만들지 않고,
  // 전체 길이만큼 늘린 컨테이너를 창 밖으로 밀어 낸다 — 줌/팬이 순수 CSS 변환이 되어 공짜다.
  // 스냅 — NLE 관례대로 **마커·플레이헤드·클립 경계**에 붙는다. 픽셀 임계라 줌 배율과 무관하게
  // 손끝 느낌이 일정하다(시간 임계로 하면 확대할수록 못 맞춘다).
  const [snap, setSnap] = useState(true);
  const snapTo = (t: number): number => {
    if (!snap || barW <= 0) return t;
    const cands = [
      0,
      duration,
      time,
      ...(inPt != null ? [inPt] : []),
      ...(outPt != null ? [outPt] : []),
      ...segments.map((sg) => sg.startMs / 1000),
    ];
    const pxPerSec = barW / vlen;
    let best = t;
    let bestPx = 8; // 8px 안쪽이면 붙는다
    for (const c of cands) {
      const d = Math.abs(c - t) * pxPerSec;
      if (d < bestPx) {
        bestPx = d;
        best = c;
      }
    }
    return best;
  };

  // 확대율을 밖(상태바)으로 보고 — 렌더 중 setState를 피해 effect로 흘린다.
  const zoomPct = Math.round((duration / vlen) * 100);
  useEffect(() => onZoomChange(zoomPct), [zoomPct, onZoomChange]);

  const stripW = barW * (duration / vlen);
  const stripX = -(vs / Math.max(duration, 1e-6)) * stripW;

  /** 파형 path — 위아래 대칭 실루엣. 버킷 수는 고정이라 파일당 한 번만 만든다. */
  const wavePath = useMemo(() => {
    if (waveform.length === 0) return "";
    const top = waveform.map((v, i) => `${i},${50 - Math.min(1, Math.max(0, v)) * 48}`);
    const bottom = waveform
      .map((v, i) => `${waveform.length - 1 - i},${50 + Math.min(1, Math.max(0, v)) * 48}`)
      .reverse();
    return `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
  }, [waveform]);

  const posToTime = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || duration <= 0) return 0;
    // 휠/드래그 리스너가 렌더 밖에서 부르므로 창은 ref에서 읽는다.
    const v = viewRef.current;
    const s = v?.s ?? 0;
    const len = Math.max((v ? v.e - v.s : duration) || 0, 1e-6);
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return s + (x / rect.width) * len;
  };

  /** 창 이동(팬) — 전체 범위로 클램프. 커서는 안 움직였는데 내용이 움직였으므로
   *  호버 표시는 무효(스테일 위치에 남아 커서에서 미끄러진다) — 지운다. */
  const panTo = (s: number) => {
    const v = viewRef.current;
    if (!v) return;
    const len = v.e - v.s;
    const ns = Math.min(Math.max(s, 0), Math.max(0, duration - len));
    setView({ s: ns, e: ns + len });
    setHoverT(null);
  };

  // 휠 = 커서 시각 고정 줌(DVR 관례 — Ctrl 유무 무관, 트랙패드 핀치도 ctrl+wheel로 와서 동일),
  // Shift+휠 = 팬(줌 상태에서만). 처음엔 Ctrl+휠만 줌이었는데 실사용에서 "줌이 안 된다"로
  // 체감됐다 — 참조 DVR UI들이 맨 휠 줌이라 기대가 그쪽이다.
  // React onWheel은 루트에 passive로 붙어 preventDefault가 안 먹는다 — 네이티브로 단다.
  // (현재 wry는 웹뷰 줌 단축키를 꺼 두지만 그건 우리가 정한 계약이 아니다 — 방어적으로 막는다.)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (duration <= 0) return;
      const v = viewRef.current;
      // Shift+휠 = 팬 (브라우저가 shift+세로휠을 deltaX로 주기도 해 둘 다 본다)
      if (e.shiftKey) {
        if (!v) return; // 전체 보기에선 팬할 것이 없다
        e.preventDefault();
        holdUntilRef.current = Date.now() + 1500;
        const len = v.e - v.s;
        const dir = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
        panTo(v.s + dir * len * 0.12);
        return;
      }
      // 휠 = 줌
      e.preventDefault();
      holdUntilRef.current = Date.now() + 1500; // 사용자가 창을 조작 중 — 팔로우 잠시 양보
      const anchor = posToTime(e.clientX);
      const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
      const s0 = v?.s ?? 0;
      const len0 = Math.max((v ? v.e - v.s : duration) || 0, 1e-6);
      const len = Math.min(duration, Math.max(MIN_VIEW_SECS, len0 / factor));
      if (len >= duration - 1e-9) {
        setView(null); // 전체까지 축소되면 줌 해제
        return;
      }
      // 커서 아래 시각이 그대로 있도록: s' = anchor - (anchor - s) * (len'/len)
      let s = anchor - (anchor - s0) * (len / len0);
      s = Math.min(Math.max(s, 0), duration - len);
      setView({ s, e: s + len });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  // 재생 중 플레이헤드가 창을 벗어나면 페이지 넘기듯 따라간다(NLE 관례).
  // 단, 일시정지 상태 / 드래그 중 / 휠 조작 직후(1.5초)는 따라가지 않는다 —
  // 사용자가 다른 구간을 보고 있거나 마커를 잡고 있는데 창이 튀면 안 된다.
  useEffect(() => {
    if (!playing || draggingRef.current || Date.now() < holdUntilRef.current) return;
    const v = viewRef.current;
    if (!v) return;
    if (time > v.e || time < v.s) {
      const len = v.e - v.s;
      panTo(time - len * 0.1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, playing]);

  /** 포인터 드래그 공통 — window 리스너 추적, pointerup 유실·취소 자가 복구. */
  const trackPointer = (
    e: React.PointerEvent,
    apply: (clientX: number) => void,
    onUp?: () => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    onInteract(); // preventDefault가 클릭-포커스 기본동작을 막으므로 명시 포커스
    draggingRef.current = true;
    const up = () => {
      draggingRef.current = false;
      holdUntilRef.current = Date.now() + 1500; // 놓은 직후 팔로우가 바로 낚아채지 않게
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onUp?.();
    };
    const move = (ev: PointerEvent) => {
      // 버튼이 놓였는데 pointerup을 놓친 경우(창 전환·캡처 상실) 자가 복구 —
      // 안 하면 버튼도 안 눌린 채 마우스만 따라다니는 유령 스크럽이 된다.
      if (ev.buttons === 0) {
        up();
        return;
      }
      apply(ev.clientX);
    };
    apply(e.clientX);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const startDrag = (mode: "seek" | "in" | "out") => (e: React.PointerEvent) =>
    trackPointer(e, (clientX) => {
      const t = posToTime(clientX);
      if (mode === "seek") onSeek(t);
      else if (mode === "in") onDragIn(t);
      else onDragOut(t);
    });

  /** 구간 지정 모드의 첫 클릭 지점. 드래그면 안 쓰이고, 클릭 두 번 경로에서만 산다. */
  const [pendingIn, setPendingIn] = useState<number | null>(null);
  /**
   * 구간 지정 — 한 제스처로 끝내는 **드래그**와, 두 번 눌러 정하는 **클릭** 둘 다 받는다.
   * 어느 쪽이든 버튼으로 돌아갈 필요가 없다는 게 요점이다(모드가 유지된다).
   * 3px 미만 이동은 클릭으로 본다 — 손떨림으로 폭 0짜리 구간이 만들어지면 안 된다.
   */
  const startRangeDrag = (e: React.PointerEvent) => {
    const a = snapTo(Math.min(Math.max(posToTime(e.clientX), 0), duration));
    let moved = false;
    let last = a;
    trackPointer(
      e,
      (clientX) => {
        const b = snapTo(Math.min(Math.max(posToTime(clientX), 0), duration));
        last = b;
        if (Math.abs(b - a) * (barW / vlen) > 3) {
          moved = true;
          onRangeDraft(Math.min(a, b), Math.max(a, b));
        }
      },
      () => {
        if (moved) {
          setPendingIn(null);
          onRangeCommit();
        } else if (pendingIn == null) {
          setPendingIn(last);
          onRangeDraft(last, null); // 시작만 먼저 — 초록 마커가 바로 선다
        } else {
          onRangeDraft(Math.min(pendingIn, last), Math.max(pendingIn, last));
          setPendingIn(null);
          onRangeCommit();
        }
      },
    );
  };

  /** 분할 틱 드래그 — startDrag의 모드 유니언을 늘리지 않는다(인덱스가 필요해 별도 킷). */
  const startTickDrag = (i: number) => (e: React.PointerEvent) =>
    trackPointer(e, (clientX) =>
      onDragTick(i, snapTo(Math.min(Math.max(posToTime(clientX), 0), duration))),
    );

  /** 미니맵 드래그 — 썸 위를 잡았으면 잡은 지점을 유지하는 **상대** 드래그(스크롤바 관례),
   *  썸 밖 클릭은 그 지점으로 창 중심 점프. 즉시-센터만 있으면 깊은 줌의 긴 영상에서
   *  (썸 최소폭 1% 부풀림 때문에) 썸을 누르는 순간 수십 초씩 튄다. */
  const startOverviewDrag = (e: React.PointerEvent) => {
    const rect = ovRef.current?.getBoundingClientRect();
    const v0 = viewRef.current;
    if (!rect || rect.width === 0 || !v0 || duration <= 0) return;
    const len = v0.e - v0.s;
    const fracAt = (x: number) => Math.min(Math.max((x - rect.left) / rect.width, 0), 1);
    const center0 = (v0.s + len / 2) / duration;
    const f0 = fracAt(e.clientX);
    const halfThumb = Math.max(len / duration, 0.01) / 2; // 렌더 최소폭(1%)과 일치
    const offset = Math.abs(f0 - center0) <= halfThumb ? f0 - center0 : 0;
    trackPointer(e, (clientX) => {
      panTo((fracAt(clientX) - offset) * duration - len / 2);
    });
  };

  /** 배지 공통 스타일 — 눈금자 위 캡슐(가로 이동은 shift()가 결정). */
  const badgeCls = "absolute top-0 rounded px-1.5 font-mono text-[10px] font-bold leading-5";

  /**
   * 배지 가로 앵커 — 기본은 중앙 정렬이되, 패널 가장자리(0%/100%)에선 안쪽으로 펼쳐
   * 잘리지 않게 하고, In/Out이 근접하면 서로 반대쪽으로 벌려 겹침을 푼다.
   */
  const shift = (p: number, bias?: "left" | "right"): string => {
    if (p < 4) return "";
    if (p > 96) return "-translate-x-full";
    if (bias === "left") return "-translate-x-full";
    if (bias === "right") return "";
    return "-translate-x-1/2";
  };
  // In/Out 배지가 겹칠 만큼 가까운가 — 배지 폭(~56px)을 실측 막대 폭으로 환산해 판정.
  const tight =
    inPt != null &&
    outPt != null &&
    visible(inPt) &&
    visible(outPt) &&
    barW > 0 &&
    ((pct(outPt) - pct(inPt)) / 100) * barW < 56;
  // 틱 배지 겹침(N개 일반화) — 자기보다 **왼쪽**(시간이 작은) 마커가 배지 폭 안에 있으면
  // 배지만 생략한다(선·드래그·우클릭은 유지). 줌하면 간격이 벌어져 다시 나타난다.
  const crowded = (t: number) => {
    if (barW <= 0) return false;
    const left = [...splitTicks, inPt, outPt].filter(
      (o): o is number => o != null && o < t,
    );
    return left.some((o) => ((pct(t) - pct(o)) / 100) * barW < 56);
  };

  return (
    // pt-6: 배지 층, pb-4: 시간 라벨 층
    <div ref={rootRef} className="relative select-none pb-4 pt-6">
      {/* 도구 행 — 스냅·확대. 줌은 여기(뷰 상태 소유자)에 있어야 미니맵/눈금과 한 소스를 쓴다. */}
      <div className="mb-1 flex items-center gap-2 text-[11px] text-fg-dim">
        {rangeActive && (
          <span className="rounded bg-accent/20 px-1.5 py-0.5 font-semibold text-accent">
            구간 지정 중 — 타임라인을 드래그하거나 두 번 클릭하세요{" "}
            {pendingIn != null && `(시작 ${fmtClock(pendingIn, 1)} · 끝을 클릭)`} · Esc 취소
          </span>
        )}
        <label className="flex items-center gap-1" title="마커·플레이헤드·클립 경계에 붙입니다">
          <input
            type="checkbox"
            checked={snap}
            onChange={(e) => setSnap(e.target.checked)}
            className="accent-accent"
          />
          스냅
        </label>
        <div className="flex-1" />
        <span>타임라인 확대</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round((Math.log(duration / vlen) / Math.log(Math.max(duration / MIN_VIEW_SECS, 2))) * 100)}
          onChange={(e) => {
            // 로그 스케일 — 1×~수백× 구간을 선형으로 두면 슬라이더 앞쪽 5%가 전부를 차지한다.
            const f = Number(e.target.value) / 100;
            const maxZoom = Math.max(duration / MIN_VIEW_SECS, 2);
            const len = Math.min(duration, duration / Math.pow(maxZoom, f));
            if (len >= duration - 1e-6) {
              setView(null);
              return;
            }
            // 현재 위치를 중앙에 두고 창을 만든다 — 확대할수록 보고 있던 프레임에서 멀어지면 안 된다.
            const ns = Math.min(Math.max(time - len / 2, 0), Math.max(0, duration - len));
            setView({ s: ns, e: ns + len });
          }}
          aria-label="타임라인 확대"
          className="h-1 w-32 accent-accent"
        />
        <button
          onClick={() => setView(null)}
          className="rounded border border-edge px-1.5 py-0.5 hover:bg-raised hover:text-fg"
        >
          전체 맞춤
        </button>
      </div>

      {/* 눈금자 막대 */}
      <div
        ref={barRef}
        title={
          rangeActive
            ? "드래그해 구간 지정 · 클릭 두 번으로도 지정됩니다"
            : "탐색 · 휠: 줌 · Shift+휠: 좌우 이동"
        }
        className={`relative h-7 overflow-hidden rounded-sm bg-accent/75 ${
          rangeActive ? "cursor-crosshair ring-1 ring-inset ring-fg/60" : "cursor-pointer"
        }`}
        onPointerDown={rangeActive ? startRangeDrag : startDrag("seek")}
        onPointerMove={(e) => setHoverT(posToTime(e.clientX))}
        onPointerLeave={() => setHoverT(null)}
      >
        {/* 구간(In~Out) 음영 */}
        {inPt != null && outPt != null && (
          <div
            className="absolute inset-y-0 bg-base/25"
            style={{ left: `${pct(inPt)}%`, width: `${Math.max(0, pct(outPt) - pct(inPt))}%` }}
          />
        )}
        {/* 소 눈금(하단 짧게) · 주 눈금(전체 높이) — 막대색 위 어두운 에칭 */}
        {ticks.minor.map((t) => (
          <div key={t} className="absolute bottom-0 h-2 w-px bg-base/30" style={{ left: `${pct(t)}%` }} />
        ))}
        {ticks.major.map((t) => (
          <div key={t} className="absolute inset-y-0 w-px bg-base/45" style={{ left: `${pct(t)}%` }} />
        ))}
      </div>

      {/* ── 트랙 (V1 필름스트립 · A1 파형 · 마커) ────────────────────────────────
          전부 눈금자와 **같은 pct() 좌표계**를 쓴다 — 줌/팬이 바뀌어도 별도 동기화 없이 붙어 있다.
          필름스트립·파형은 영상 **전체 길이**를 담은 정적 자산이라, 매 프레임 다시 그리는 대신
          컨테이너 폭(stripW)과 오프셋(stripX)만 바꿔 밀어 준다(리렌더 비용 0). */}
      <div className="mt-1.5 space-y-1">
        {/* V1 — 필름스트립 + 분할 클립 경계 */}
        <div className="flex items-stretch gap-1.5">
          <div className="w-16 shrink-0 pt-0.5">
            <div className="flex items-center gap-1 text-[10px] font-semibold text-fg">
              <span className="h-2.5 w-0.5 rounded-full bg-accent" />
              V1
            </div>
            <div className="truncate text-[9px] text-fg-dim">{vcodec ?? "비디오"}</div>
          </div>
          <div
            onPointerDown={rangeActive ? startRangeDrag : undefined}
            className={`relative h-12 flex-1 overflow-hidden rounded-sm border bg-raised ${
              rangeActive ? "cursor-crosshair border-fg/60" : "border-edge"
            }`}
          >
            {filmstrip && barW > 0 && (
              <div
                className="absolute inset-y-0 opacity-90"
                style={{
                  left: stripX,
                  width: stripW,
                  backgroundImage: `url(${filmstrip.dataUri})`,
                  backgroundSize: "100% 100%",
                  backgroundRepeat: "no-repeat",
                }}
              />
            )}
            {/* 클립 경계 — 분할 지점으로 잘린 구간. 현재 위치가 든 클립을 강조한다. */}
            {segments.map((sg, i) => {
              const a = sg.startMs / 1000;
              const b = sg.endMs / 1000;
              if (!visible(a) && !visible(b) && !(a < vs && b > ve)) return null;
              const active = time >= a && time < b;
              return (
                <div
                  key={i}
                  className={`absolute inset-y-0 border-l ${
                    active ? "border-fg bg-fg/5 ring-1 ring-inset ring-fg/60" : "border-edge/80"
                  }`}
                  style={{ left: `${pct(a)}%`, width: `${Math.max(0, pct(b) - pct(a))}%` }}
                >
                  {segments.length > 1 && (
                    <span className="absolute left-1 top-0.5 rounded bg-base/70 px-1 font-mono text-[9px] leading-4 text-fg">
                      {String(i + 1).padStart(2, "0")}
                      <span className="ml-1 text-fg-dim">{(b - a).toFixed(1)}s</span>
                    </span>
                  )}
                </div>
              );
            })}
            <div className="absolute inset-y-0 w-px bg-fg" style={{ left: `${pct(time)}%` }} />
          </div>
        </div>

        {/* A1 — 파형. 오디오가 없으면 트랙 자체를 그리지 않는다(빈 줄은 정보가 아니다). */}
        {waveform.length > 0 && (
          <div className="flex items-stretch gap-1.5">
            <div className="w-16 shrink-0 pt-0.5">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-fg">
                <span className="h-2.5 w-0.5 rounded-full bg-ok" />
                A1
              </div>
              <div className="truncate text-[9px] text-fg-dim">{acodec ?? "오디오"}</div>
            </div>
            <div className="relative h-8 flex-1 overflow-hidden rounded-sm border border-edge bg-raised">
              {barW > 0 && (
                <div className="absolute inset-y-0" style={{ left: stripX, width: stripW }}>
                  <svg
                    viewBox={`0 0 ${waveform.length} 100`}
                    preserveAspectRatio="none"
                    className="h-full w-full text-mod"
                  >
                    <path d={wavePath} fill="currentColor" />
                  </svg>
                </div>
              )}
              <div className="absolute inset-y-0 w-px bg-fg" style={{ left: `${pct(time)}%` }} />
            </div>
          </div>
        )}

        {/* 마커 — 분할 지점과 선택 구간. **가림 영역은 여기 두지 않는다**: 마스크는 시간 범위가
            아니라 영상 전체에 걸리므로, 레인에 스팬으로 그리면 없는 시간 구간을 지어내는 거짓말이 된다. */}
        <div className="flex items-stretch gap-1.5">
          <div className="w-16 shrink-0 pt-0.5">
            <div className="flex items-center gap-1 text-[10px] font-semibold text-fg">
              <span className="h-2.5 w-0.5 rounded-full bg-warn" />
              마커
            </div>
            <div className="truncate text-[9px] text-fg-dim">분할 · 구간</div>
          </div>
          <div className="relative h-6 flex-1 overflow-hidden rounded-sm border border-edge bg-raised">
            {inPt != null && outPt != null && (
              <div
                className="absolute inset-y-0.5 rounded-sm border border-accent bg-accent/20"
                style={{ left: `${pct(inPt)}%`, width: `${Math.max(0, pct(outPt) - pct(inPt))}%` }}
              >
                <span className="absolute left-1 top-0 font-mono text-[9px] leading-5 text-accent">
                  선택 구간 {(outPt - inPt).toFixed(1)}s
                </span>
              </div>
            )}
            {splitTicks.map((t, i) =>
              visible(t) ? (
                <div key={i} className="absolute inset-y-0" style={{ left: `${pct(t)}%` }}>
                  <div className="h-full w-px bg-warn" />
                  <span className="absolute left-1 top-0 whitespace-nowrap font-mono text-[9px] leading-6 text-warn">
                    {fmtClock(t, 1)}
                  </span>
                </div>
              ) : null,
            )}
            <div className="absolute inset-y-0 w-px bg-fg" style={{ left: `${pct(time)}%` }} />
          </div>
        </div>
      </div>

      {/* 미니맵(전체 축) + 줌 칩 — 줌 상태에서만. 칩을 배지 층에 두면 우측 끝의 드래그 배지를
          가로막고 오클릭이 줌을 날린다(검증된 결함) — 여기 인라인이 안전하다. */}
      {view && (
        <div className="mt-1 flex items-center gap-1.5">
          <div
            ref={ovRef}
            onPointerDown={startOverviewDrag}
            title="전체 구간 — 썸 드래그로 보이는 창 이동"
            className="relative h-2 flex-1 cursor-grab overflow-hidden rounded-sm bg-raised"
          >
            {inPt != null && (
              <div className="absolute inset-y-0 w-px bg-add" style={{ left: `${fullPct(inPt)}%` }} />
            )}
            {outPt != null && (
              <div
                className="absolute inset-y-0 w-px bg-danger"
                style={{ left: `${fullPct(outPt)}%` }}
              />
            )}
            {splitTicks.map((t, i) => (
              <div
                key={i}
                className="absolute inset-y-0 w-px bg-warn"
                style={{ left: `${fullPct(t)}%` }}
              />
            ))}
            <div className="absolute inset-y-0 w-px bg-fg" style={{ left: `${fullPct(time)}%` }} />
            {(() => {
              // 썸 최소폭 1% — left를 함께 클램프해 우측 끝에서 스트립 밖으로 삐져나가지 않게.
              const w = Math.max((vlen / Math.max(duration, 1e-6)) * 100, 1);
              const l = Math.min(fullPct(vs), 100 - w);
              return (
                <div
                  className="absolute inset-y-0 rounded-sm border border-accent bg-accent/40"
                  style={{ left: `${l}%`, width: `${w}%` }}
                />
              );
            })()}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-fg-dim">
            ×{(duration / vlen).toFixed(duration / vlen >= 10 ? 0 : 1)}
          </span>
          <button
            onClick={() => setView(null)}
            title="전체 보기 (줌 해제)"
            className="shrink-0 rounded border border-edge bg-panel px-1 text-[10px] leading-4 text-fg-dim hover:bg-raised hover:text-fg"
          >
            전체
          </button>
        </div>
      )}

      {/* 주 눈금 시간 라벨 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 font-mono text-[10px] leading-4 text-fg-dim">
        {ticks.major.map((t) => {
          const p = pct(t);
          return (
            <span
              key={t}
              className={`absolute ${p < 3 ? "" : p > 97 ? "-translate-x-full" : "-translate-x-1/2"}`}
              style={{ left: `${p}%` }}
            >
              {fmtClock(t, ticks.step < 0.1 ? 2 : ticks.step < 1 ? 1 : 0)}
            </span>
          );
        })}
      </div>

      {/* 호버 미리보기 — 얇은 선 + 외곽선 배지 (줌 직후 창 밖에 남은 스테일 값은 숨김) */}
      {hoverT != null && visible(hoverT) && (
        <>
          <div
            className="pointer-events-none absolute top-6 h-7 w-px bg-fg/60"
            style={{ left: `${pct(hoverT)}%` }}
          />
          <div
            className={`${badgeCls} ${shift(pct(hoverT))} pointer-events-none border border-edge bg-panel font-medium text-fg-muted`}
            style={{ left: `${pct(hoverT)}%` }}
          >
            {fmtTime(hoverT)}
          </div>
        </>
      )}

      {/* In 마커(초록) — 절대시간 배지, 선·배지 모두 드래그 이동. 창 밖이면 숨김(미니맵이 표시) */}
      {inPt != null && visible(inPt) && (
        <>
          <div
            onPointerDown={startDrag("in")}
            title="구간 시작 (드래그로 이동)"
            className="absolute top-6 z-10 h-7 w-2 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${pct(inPt)}%` }}
          >
            <div className="mx-auto h-full w-0.5 bg-add" />
          </div>
          <div
            onPointerDown={startDrag("in")}
            title="구간 시작 (드래그로 이동)"
            // 외곽선 스타일 — bg-add 위 텍스트는 테마별 대비 보장이 없다(nord 실측 3:1 미달).
            // add/danger는 애초에 "패널 위 텍스트색"으로 설계된 토큰이라 이 방향이 안전하다.
            className={`${badgeCls} ${shift(pct(inPt), tight ? "left" : undefined)} z-10 cursor-ew-resize border border-add bg-panel text-add`}
            style={{ left: `${pct(inPt)}%` }}
          >
            {fmtTime(inPt)}
          </div>
        </>
      )}
      {/* Out 마커(빨강) — In 기준 +구간길이 배지 */}
      {outPt != null && visible(outPt) && (
        <>
          <div
            onPointerDown={startDrag("out")}
            title="구간 끝 (드래그로 이동)"
            className="absolute top-6 z-10 h-7 w-2 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${pct(outPt)}%` }}
          >
            <div className="mx-auto h-full w-0.5 bg-danger" />
          </div>
          <div
            onPointerDown={startDrag("out")}
            title="구간 끝 (드래그로 이동)"
            className={`${badgeCls} ${shift(pct(outPt), tight ? "right" : undefined)} z-10 cursor-ew-resize border border-danger bg-panel text-danger`}
            style={{ left: `${pct(outPt)}%` }}
          >
            {inPt != null ? `+${fmtTime(outPt - inPt)}` : fmtTime(outPt)}
          </div>
        </>
      )}

      {/* 분할 틱(앰버) — 선은 드래그로 이동, 우클릭이 삭제. 창 밖이면 숨김(미니맵이 표시).
          배지는 왼쪽 이웃과 겹칠 때만 생략한다(crowded) — 선은 언제나 남아 조작이 가능하다. */}
      {splitTicks.map((t, i) =>
        visible(t) ? (
          <Fragment key={i}>
            <div
              onPointerDown={startTickDrag(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                onRemoveTick(i);
              }}
              title={`분할 지점 ${fmtTime(t)} (드래그로 이동 · 우클릭 삭제)`}
              className="absolute top-6 z-10 h-7 w-2 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${pct(t)}%` }}
            >
              <div className="mx-auto h-full w-0.5 bg-warn" />
            </div>
            {!crowded(t) && (
              <div
                onPointerDown={startTickDrag(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onRemoveTick(i);
                }}
                title={`분할 지점 ${fmtTime(t)} (드래그로 이동 · 우클릭 삭제)`}
                className={`${badgeCls} ${shift(pct(t))} z-10 cursor-ew-resize border border-warn bg-panel text-warn`}
                style={{ left: `${pct(t)}%` }}
              >
                {fmtTime(t)}
              </div>
            )}
          </Fragment>
        ) : null,
      )}

      {/* 플레이헤드(전경색) — 선 + 다이아 포인터 + 현재시간 배지, 최상위. 창 밖이면 숨김 */}
      {visible(time) && (
        <>
          <div
            className="pointer-events-none absolute top-6 z-20 h-7 w-0.5 -translate-x-1/2 bg-fg"
            style={{ left: `${pct(time)}%` }}
          />
          <div
            className="pointer-events-none absolute top-5 z-20 h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-fg"
            style={{ left: `${pct(time)}%` }}
          />
          <div
            className={`${badgeCls} ${shift(pct(time))} pointer-events-none z-20 bg-fg text-[11px] text-base shadow`}
            style={{ left: `${pct(time)}%` }}
          >
            {fmtTime(time)}
          </div>
        </>
      )}
    </div>
  );
}

/** 원형 스킵 버튼 — 회전 화살표 링 안에 이동량 라벨(5s/1m/10m). */
function SkipBtn({
  secs,
  label,
  onSkip,
}: {
  secs: number;
  label: string;
  onSkip: (d: number) => void;
}) {
  const Icon = secs < 0 ? RotateCcw : RotateCw;
  return (
    <button
      onClick={() => onSkip(secs)}
      title={`${secs < 0 ? "뒤로" : "앞으로"} ${label}`}
      className="relative grid h-9 w-9 place-items-center rounded-full text-fg-dim hover:bg-raised hover:text-fg"
    >
      <Icon size={27} strokeWidth={1.25} className="absolute" />
      <span className="relative text-[9px] font-bold">{label}</span>
    </button>
  );
}
