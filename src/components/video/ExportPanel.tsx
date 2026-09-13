// 내보내기 인스펙터 (설계 §4.6) — 구간·배속·화질·크롭·형식을 단일 ExportSpec으로 수렴시킨다.
//
// - 무손실 복사(copy)는 배속·크롭·해상도·GIF와 양립 불가 → 그 옵션이 켜지면 자동으로
//   재인코딩이 되고 안내 문구를 띄운다(침묵 전환 금지 — 설계 결정 4).
// - 파일명은 원본 옆 접미사(clip/crop/xN/…): 이미지 편집기와 같은 저장 규약. 같은 폴더 한정.
// - 진행·완료는 video:// 이벤트가 진실(invoke 응답 유실 대비). 완료 토스트는 events.ts
//   전역 리스너 한 곳에서만 — 여기는 자기 jobId의 진행률·busy 해제만 담당한다.
// - 레이아웃: 부모가 고정폭 오른쪽 칼럼(w-80, 전체 높이)에 물린다. 탭 → 스크롤 본문 →
//   **고정 푸터**(예상치·실행 버튼) 순. 실행 버튼은 어느 탭에서도 스크롤 밖으로 나가지 않는다.
import { listen } from "@tauri-apps/api/event";
import { Camera, Crop as CropIcon, Grid3x3, Loader2, Scissors, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { markLocalVideoJob } from "../../lib/events";
import type {
  VideoExportFinished,
  VideoExportProgress,
  VideoExportSpec,
  VideoMeta,
  VideoToolStatus,
} from "../../lib/ipc";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import { useUi } from "../../stores/ui";
import { planSegments, useVideoSplit } from "../../stores/videoSplit";
import type { CropRect } from "./CropOverlay";
import { captureFrame as captureFrameTo, cleanStem, splitPath } from "./frameCapture";
import { fmtTime } from "./VideoPlayer";

type Format = "mp4" | "gif" | "audio";
type Quality = "copy" | "18" | "23" | "28";
type Tab = "export" | "trim" | "audio" | "mask";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "export", label: "내보내기" },
  { id: "trim", label: "자르기" },
  { id: "audio", label: "오디오" },
  { id: "mask", label: "가리기" },
];

// 세로 인스펙터라 모든 컨트롤이 칼럼 폭을 꽉 채운다(가로 바 시절의 px-1 축소는 폐기).
const selCls = "w-full rounded border border-edge bg-panel px-2 py-1.5 text-xs text-fg";
const inputCls = "w-full rounded border border-edge bg-panel px-2 py-1.5 font-mono text-xs text-fg";
const primaryCls =
  "w-full rounded bg-accent/20 px-3 py-2 font-semibold text-accent hover:bg-accent/30 disabled:bg-transparent disabled:font-normal disabled:text-fg-muted";
const secondaryCls =
  "flex items-center justify-center gap-1 rounded border border-edge px-2 py-1.5 hover:bg-raised hover:text-fg disabled:bg-transparent disabled:text-fg-muted";
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** 오디오 추출 규칙 — aac/mp3는 무손실 복사(컨테이너만 교체), 그 외는 aac 재인코딩. */
function audioPlan(acodec: string | null, forceEncode: boolean): { ext: string; mode: "copy" | "encode" } {
  if (!forceEncode && acodec === "aac") return { ext: "m4a", mode: "copy" };
  if (!forceEncode && acodec === "mp3") return { ext: "mp3", mode: "copy" };
  return { ext: "m4a", mode: "encode" };
}

/** 추정 용량 표기 — 추정치라 유효숫자를 늘리지 않는다. */
function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

/** 초 → m:ss. 예상 소요용 — fmtTime의 0.1초 자리는 추정치에 과하다. */
function fmtDur(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(t % 60).padStart(2, "0")}`;
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold text-fg-dim">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] text-fg-dim">{label}</span>
      {children}
    </label>
  );
}

// memo: 부모 VideoPlayer가 재생 중 rAF로 60fps 리렌더된다 — 함수 props가 useCallback으로
// 안정화돼 있어(플레이어 쪽 계약) 패널은 마킹·크롭 변경 때만 다시 그린다.
export const ExportPanel = memo(function ExportPanel({
  projectId,
  path,
  tool,
  probe,
  probeError,
  inPt,
  outPt,
  onClearRange,
  ticks,
  onClearTicks,
  crop,
  cropActive,
  onToggleCrop,
  onClearCrop,
  masks,
  maskKind,
  maskActive,
  onToggleMask,
  onClearMasks,
  onSetMaskKind,
  getTime,
}: {
  projectId: string;
  path: string;
  tool: VideoToolStatus | undefined;
  probe: VideoMeta | undefined;
  probeError: string | null;
  inPt: number | null;
  outPt: number | null;
  onClearRange: () => void;
  /** 분할 타임틱(초, 미정렬) — 경계 계산은 planSegments가 한다. */
  ticks: number[];
  onClearTicks: () => void;
  crop: CropRect | null;
  cropActive: boolean;
  onToggleCrop: () => void;
  onClearCrop: () => void;
  /** 가릴 영역들(원본 video px). 비면 마스킹 없음. */
  masks: CropRect[];
  maskKind: "mosaic" | "blur";
  maskActive: boolean;
  onToggleMask: () => void;
  onClearMasks: () => void;
  onSetMaskKind: (k: "mosaic" | "blur") => void;
  getTime: () => number;
}) {
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const qc = useQueryClient();

  const [tab, setTab] = useState<Tab>("export");
  const [format, setFormat] = useState<Format>("mp4");
  const [quality, setQuality] = useState<Quality>("copy");
  const [maxHeight, setMaxHeight] = useState<"" | "1080" | "720" | "480">("");
  const [speed, setSpeed] = useState(1);
  const [removeAudio, setRemoveAudio] = useState(false);
  const [name, setName] = useState("");
  const nameEditedRef = useRef(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ pct: number; speed: string | null } | null>(null);
  // 분할 폴더명 — key={path} 리마운트로 파일마다 기본값으로 돌아온다(파일명 필드와 같은 수명).
  const [folder, setFolder] = useState(() => `${cleanStem(path)}.split`);
  const [splitEncode, setSplitEncode] = useState(false);
  const batch = useVideoSplit((s) => s.batch);
  const startSplit = useVideoSplit((s) => s.start);
  const cancelSplit = useVideoSplit((s) => s.cancel);

  const range = useMemo(
    () =>
      inPt != null && outPt != null
        ? { startMs: Math.round(inPt * 1000), endMs: Math.round(outPt * 1000) }
        : null,
    [inPt, outPt],
  );

  // 재인코딩이 강제되는 조건 — copy 선택과 겹치면 안내 후 자동 encode.
  const forcesEncode =
    format === "gif" ||
    speed !== 1 ||
    !!crop ||
    masks.length > 0 ||
    (format === "mp4" && maxHeight !== "");
  const aud = audioPlan(probe?.acodec ?? null, speed !== 1);
  const mode: "copy" | "encode" =
    format === "audio" ? aud.mode : quality === "copy" && !forcesEncode ? "copy" : "encode";

  // 접미사 자동 이름 — 사용자가 손대기 전까지만 갱신.
  const suggested = useMemo(() => {
    const stem = cleanStem(path);
    if (format === "gif") return `${stem}${range ? ".clip" : ""}.gif`;
    if (format === "audio") return `${stem}.${aud.ext}`;
    const parts: string[] = [];
    if (range) parts.push("clip");
    if (crop) parts.push("crop");
    if (masks.length > 0) parts.push(maskKind === "blur" ? "blur" : "mosaic");
    if (speed !== 1) parts.push(`x${speed}`);
    if (maxHeight) parts.push(`${maxHeight}p`);
    if (removeAudio) parts.push("mute");
    if (parts.length === 0 && mode === "encode") parts.push("edit");
    return `${stem}.${parts.join(".") || "copy"}.mp4`;
  }, [path, format, range, crop, masks.length, maskKind, speed, maxHeight, removeAudio, mode, aud.ext]);

  useEffect(() => {
    if (!nameEditedRef.current) setName(suggested);
  }, [suggested]);

  // 자기 jobId의 진행률·종결 구독 — 종결 토스트는 events.ts 전역 리스너 몫(중복 방지).
  // 종결은 invoke 완주(doExport의 done)가 1차, 이 리스너는 응답 유실(Windows §10) 백업이다.
  useEffect(() => {
    if (!jobId) return;
    // listen()이 resolve되기 전에 정리(cleanup)가 먼저 돌 수 있다 — 늦게 도착한 unlisten을
    // 그 자리에서 호출해 리스너가 영구히 남는 것을 막는다.
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const track = (p: Promise<() => void>) =>
      void p.then((f) => {
        if (disposed) f();
        else unsubs.push(f);
      });
    track(
      listen<VideoExportProgress>("video://export-progress", (e) => {
        if (e.payload.jobId === jobId)
          setProgress({ pct: e.payload.percent, speed: e.payload.speed });
      }),
    );
    track(
      listen<VideoExportFinished>("video://export-finished", (e) => {
        if (e.payload.jobId === jobId) {
          setJobId(null);
          setProgress(null);
        }
      }),
    );
    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, [jobId]);

  // ── ffmpeg 미발견 안내 ──
  if (!tool?.found || !tool.probeFound) {
    return (
      <div className="h-full overflow-y-auto px-3 py-3 text-xs text-fg-muted">
        <div className="mb-1 font-semibold text-fg">
          {tool?.found ? "ffprobe를 찾을 수 없습니다" : "편집·내보내기에는 ffmpeg가 필요합니다"}
        </div>
        <div className="mb-2 text-fg-dim">
          {tool?.found
            ? "ffmpeg와 같은 폴더에 ffprobe가 함께 있어야 합니다."
            : tool?.managedSupported
              ? "설정 › 코드 도구에서 다운로드하거나(약 40~110MB), PATH에 설치된 ffmpeg를 자동 발견합니다."
              : "이 플랫폼은 앱 내 다운로드가 없습니다 — 패키지 관리자(brew/apt 등)로 ffmpeg를 설치하세요."}
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="rounded border border-edge px-2 py-1 hover:bg-raised hover:text-fg"
        >
          설정 열기
        </button>
      </div>
    );
  }
  if (probeError)
    return (
      <div className="h-full px-3 py-3 text-xs text-warn">
        미디어 정보를 읽지 못했습니다 — {probeError}
      </div>
    );
  if (!probe)
    return <div className="h-full px-3 py-3 text-xs text-fg-dim">미디어 정보 읽는 중…</div>;

  const { dir } = splitPath(path);
  const nothingToDo = format === "mp4" && mode === "copy" && !range && !removeAudio;
  const nameInvalid = !name.trim() || /[\\/]|\.\./.test(name);

  const buildSpec = (overwrite: boolean): VideoExportSpec => ({
    srcRel: path,
    outRel: dir + name.trim(),
    overwrite,
    range,
    mode,
    speed: mode === "encode" && speed !== 1 ? speed : null,
    // 크롭은 영상 프레임이 있는 출력(mp4·gif)에만 — 오디오 추출엔 무의미.
    crop: mode === "encode" && format !== "audio" ? crop : null,
    // 가림은 원본 좌표계라 백엔드가 crop보다 먼저 건다(video.rs build_mask_graph).
    masks: mode === "encode" && format !== "audio" && masks.length > 0 ? masks : null,
    maskKind,
    crf: mode === "encode" && format === "mp4" ? Number(quality === "copy" ? 23 : quality) : null,
    maxHeight: mode === "encode" && format === "mp4" && maxHeight ? Number(maxHeight) : null,
    removeAudio: format === "mp4" && removeAudio,
    durationMs: probe.durationMs,
    hasAudio: probe.hasAudio,
  });

  const doExport = (overwrite: boolean) => {
    const id = crypto.randomUUID();
    setJobId(id);
    setProgress({ pct: 0, speed: null });
    const done = () => {
      // invoke 완주가 1차 종결 신호 — 이벤트 리스너 등록 전에 끝나는 초고속 내보내기도 여기서 정리된다.
      setJobId(null);
      setProgress(null);
    };
    // 종결 토스트는 잡을 시작한 창만 띄운다 — 표시가 없으면 events.ts가 무효화만 하고 끝낸다.
    markLocalVideoJob(id);
    void ipc.videoExport(projectId, id, buildSpec(overwrite)).then(done, (e) => {
      done();
      // 백엔드가 AlreadyExists를 **제외한** 모든 결과에 video://export-finished를 emit하고
      // 토스트는 전역 리스너 한 곳이 담당한다(video.rs 계약) — 여기서는 대화형 경로만 처리.
      if (isIpcError(e) && e.code === "ALREADY_EXISTS" && !overwrite) {
        askConfirm({
          title: "덮어쓰기",
          message: `${name.trim()} 파일이 이미 있습니다. 덮어쓸까요?`,
          confirmLabel: "덮어쓰기",
          danger: true,
          onConfirm: () => doExport(true),
        });
      }
    });
  };

  /** 현재 위치 프레임 저장 — 구현은 플레이어 툴바와 공유한다(frameCapture.ts).
   *  이 패널의 파일명·구간·영역·해상도 설정은 적용되지 않는다(원본 프레임 그대로다). */
  const captureFrame = () =>
    captureFrameTo({ projectId, path, atMs: getTime() * 1000, pushToast, askConfirm, qc });

  const busy = jobId != null;
  // 분할 배치는 앱 전역에 하나뿐(스토어) — 이 파일 것인지 남의 것인지 나눠 본다.
  const mine =
    batch != null && batch.projectId === projectId && batch.srcRel === path;
  const segs = planSegments(ticks, probe.durationMs / 1000);
  const folderInvalid = !folder.trim() || /[\\/]|\.\./.test(folder);
  const partLabel = (i: number) =>
    String(i).padStart(Math.max(2, String(batch?.total ?? 0).length), "0");

  // ── 예상치 ────────────────────────────────────────────────────────────
  // 출력 길이만 정확하다(구간 ÷ 배속 — 백엔드 expected_out_us와 같은 식, video.rs:667).
  // 용량은 근사, 소요는 실행 전에는 알 수 없다. 근거가 없으면 숫자 대신 "—"를 쓴다.
  const rangeMs = range ? range.endMs - range.startMs : probe.durationMs;
  const outMs = rangeMs / (speed > 0 ? speed : 1);

  // 크롭·해상도 축소로 줄어드는 픽셀 수 비(확대는 하지 않으므로 1로 클램프).
  const srcPx = probe.width * probe.height;
  let outW = crop ? crop.w : probe.width;
  let outH = crop ? crop.h : probe.height;
  if (maxHeight && outH > Number(maxHeight)) {
    const k = Number(maxHeight) / outH;
    outW *= k;
    outH *= k;
  }
  const pxRatio = srcPx > 0 ? Math.min(1, (outW * outH) / srcPx) : 1;

  /** 예상 용량(바이트). 근거가 없는 경우는 null → "—". */
  const estBytes = (() => {
    // GIF는 팔레트·프레임 중복률이 지배해서 비트레이트로 환산할 근거가 없다.
    // 오디오 추출은 probe가 오디오 스트림 비트레이트를 주지 않아(전체 값뿐) 마찬가지다.
    if (format !== "mp4" || !probe.bitrateKbps) return null;
    let kbps = probe.bitrateKbps;
    if (mode === "encode") {
      // x264 경험칙: CRF가 6 오를 때마다 비트레이트가 대략 절반. 소스를 CRF 23급으로 보고
      // **상대 배율**만 적용한다 — 소스의 실제 CRF는 알 수 없으므로 이보다 정직해질 수 없다.
      const crf = quality === "copy" ? 23 : Number(quality);
      kbps *= Math.pow(2, (23 - crf) / 6);
      // 비트레이트는 픽셀 수에 대략 비례한다(저해상도일수록 실제로는 덜 줄어 과소추정 쪽).
      kbps *= pxRatio;
    }
    // 오디오 제거분은 빼지 않는다 — 오디오 비트레이트를 모른다(그만큼 과대추정).
    return (kbps * 1000 * (outMs / 1000)) / 8;
  })();

  // 예상 소요: ffmpeg가 보내주는 실측 speed(출력초/실시간초)로만 계산한다. 실행 전 인코딩
  // 속도는 기기·코덱·해상도에 따라 자릿수가 달라져 어떤 상수도 거짓말이 된다 → "—".
  const liveSpeed = progress?.speed ? Number(progress.speed.replace(/x$/i, "")) : NaN;
  const etaSec =
    progress && Number.isFinite(liveSpeed) && liveSpeed > 0
      ? ((100 - Math.min(100, progress.pct)) / 100) * (outMs / 1000) / liveSpeed
      : null;

  const splitScopeWarn =
    "분할 저장은 구간·배속·해상도·영역·가림·오디오 제거를 적용하지 않습니다. 영상 전체를 분할 지점 경계로만 자릅니다.";
  const rangeBtnCls = (on: boolean) =>
    `flex-1 rounded border px-1 py-1 text-[11px] ${
      on ? "border-accent bg-accent/20 text-accent" : "border-edge hover:bg-raised"
    } disabled:border-edge disabled:bg-transparent disabled:text-fg-dim`;

  return (
    <div /* e2e가 문서 전역 input/button 셀렉터로 레일·탭을 잘못 집지 않게 스코프를 준다. */
     className="gpv-export-panel flex h-full min-h-0 flex-col text-xs text-fg-muted">
      {/* ── 탭 ── */}
      <div role="tablist" className="flex shrink-0 border-b border-edge px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            data-tab={t.id}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 border-b-2 px-1 py-2 ${
              tab === t.id
                ? "border-accent font-semibold text-accent"
                : "border-transparent hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 본문(유일한 스크롤 영역) ── */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {tab === "export" && (
          <>
            <Section title="출력 형식">
              <Field label="형식">
                <select
                  value={format}
                  onChange={(e) => {
                    // 백엔드 muxer는 outRel의 **확장자**로 결정된다(video.rs:510) — buildSpec에 format이
                    // 없다. 이름을 손댄 뒤 형식만 바꾸면 드롭다운과 결과물이 어긋나므로 확장자를 다시 쓴다.
                    const f = e.target.value as Format;
                    setFormat(f);
                    const ext = f === "gif" ? "gif" : f === "audio" ? aud.ext : "mp4";
                    setName((prev) => prev.replace(/\.[^.]+$/, "") + "." + ext);
                  }}
                  disabled={busy}
                  className={selCls}
                >
                  <option value="mp4">mp4 동영상</option>
                  <option value="gif">GIF</option>
                  <option value="audio" disabled={!probe.hasAudio}>
                    오디오만 ({aud.ext}){!probe.hasAudio ? " · 오디오 트랙 없음" : ""}
                  </option>
                </select>
              </Field>
              <Field label="배속">
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  disabled={busy}
                  className={selCls}
                >
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}x
                    </option>
                  ))}
                </select>
              </Field>
              {format === "mp4" && (
                <>
                  <Field label="화질">
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value as Quality)}
                      disabled={busy}
                      className={`${selCls} ${forcesEncode && quality === "copy" ? "text-warn" : ""}`}
                    >
                      <option value="copy">무손실 복사</option>
                      <option value="18">원본급 (CRF 18)</option>
                      <option value="23">표준 (CRF 23)</option>
                      <option value="28">압축 (CRF 28)</option>
                    </select>
                  </Field>
                  <Field label="해상도">
                    <select
                      value={maxHeight}
                      onChange={(e) => setMaxHeight(e.target.value as typeof maxHeight)}
                      disabled={busy}
                      className={selCls}
                    >
                      <option value="">
                        원본 {probe.width}×{probe.height}
                      </option>
                      <option value="1080">1080p</option>
                      <option value="720">720p</option>
                      <option value="480">480p</option>
                    </select>
                  </Field>
                </>
              )}
              {quality === "copy" && forcesEncode && format !== "audio" && (
                <div className="text-[11px] text-warn">
                  배속·영역·가림·해상도·GIF는 무손실 복사와 함께 쓸 수 없어 재인코딩(표준 화질)됩니다.
                </div>
              )}
              {format === "gif" && !range && (
                <div className="text-[11px] text-warn">
                  구간 없이 전체를 GIF로 만들면 파일이 매우 커질 수 있습니다 — I/O로 구간을 지정하세요.
                </div>
              )}
            </Section>

            <Section
              title="구간"
              right={
                <span className="font-mono tabular-nums text-[11px] text-fg-dim">
                  {fmtTime(rangeMs / 1000)} / {fmtTime(probe.durationMs / 1000)}
                </span>
              }
            >
              <div className="flex gap-1">
                <button
                  onClick={onClearRange}
                  disabled={busy}
                  className={rangeBtnCls(!range)}
                  title="영상 전체를 내보냅니다"
                >
                  전체
                </button>
                <button
                  disabled={!range || busy}
                  className={rangeBtnCls(!!range)}
                  title={range ? "지정한 I~O 구간만 내보냅니다" : "I·O 키로 구간을 먼저 지정하세요"}
                >
                  선택 구간
                </button>
                <button
                  onClick={() => setTab("trim")}
                  disabled={ticks.length === 0 || busy}
                  className={rangeBtnCls(false)}
                  title={
                    ticks.length === 0
                      ? "타임라인에 분할 지점(✂ 또는 T)이 있어야 합니다"
                      : "분할 지점으로 나눠 저장합니다 — 자르기 탭"
                  }
                >
                  분할 클립
                </button>
              </div>
              {/* I/O는 타임라인·키로만 지정한다 — 여기서는 현재 값을 읽기 전용으로 보여준다. */}
              <div className="grid grid-cols-2 gap-2">
                <Field label="시작 (I)">
                  <div className={`${inputCls} tabular-nums`}>{inPt != null ? fmtTime(inPt) : "—"}</div>
                </Field>
                <Field label="끝 (O)">
                  <div className={`${inputCls} tabular-nums`}>{outPt != null ? fmtTime(outPt) : "—"}</div>
                </Field>
              </div>
              {!range && <div className="text-[11px] text-fg-dim">I·O 키로 구간을 지정합니다.</div>}
              {/* 자를 지점이 실제로 있을 때만 — 기본 상태에서 상시 떠 있으면 정작 필요할 때 안 읽힌다.
                  "수 초"는 과장이었다: 설계 문서 실측이 0.02초였다(22-video-timetick-split.md:335). */}
              {quality === "copy" && format === "mp4" && mode === "copy" && !!range && (
                <div className="text-[11px] text-fg-dim">
                  무손실 복사는 자를 지점이 가장 가까운 키프레임으로 당겨집니다(보통 0.1초 이내, GOP가
                  긴 영상은 더 커질 수 있음). 지정한 지점 그대로 자르려면 화질을 표준(CRF 23) 이상으로
                  바꾸세요.
                </div>
              )}
            </Section>

            <Section title="저장 위치">
              {/* 저장 폴더는 반드시 눈에 보여야 한다 — 툴팁에만 두면 어디 저장되는지 아무도 모른다. */}
              <Field label="폴더">
                <div className={`${inputCls} truncate text-fg-dim`} title={dir || "./"}>
                  {dir || "./"}
                </div>
              </Field>
              <Field label="파일 이름">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    nameEditedRef.current = true;
                    setName(e.target.value);
                  }}
                  disabled={busy}
                  spellCheck={false}
                  className={inputCls}
                />
              </Field>
            </Section>
          </>
        )}

        {tab === "trim" && (
          <>
            <Section title="영역">
              <div className="flex gap-2">
                <button
                  onClick={onToggleCrop}
                  disabled={busy || format !== "mp4"}
                  className={`${secondaryCls} flex-1 ${cropActive ? "text-accent" : ""}`}
                  title={
                    format !== "mp4"
                      ? "영역 추출은 mp4 출력에서 지정합니다"
                      : "영상 위를 드래그해 추출 영역 지정"
                  }
                >
                  <CropIcon size={12} />
                  {crop ? `${crop.w}×${crop.h}` : "영역 지정"}
                </button>
                {crop && (
                  <button onClick={onClearCrop} title="영역 해제" className={secondaryCls}>
                    <X size={12} /> 해제
                  </button>
                )}
              </div>
              {!crop && <div className="text-[11px] text-fg-dim">지정하지 않으면 전체 프레임을 씁니다.</div>}
            </Section>

            {/* 분할은 틱이 없어도 **항상** 보인다. 숨겨 두면 이 기능의 이름이 화면 어디에도
                없어서 사용자가 구간(I/O)을 분할 도구로 착각한다. 하위 컨트롤은 segs.length===0 /
                ticks.length===0 으로 이미 올바르게 비활성된다. */}
            <Section title="분할">
              {ticks.length === 0 && !mine ? (
                <div className="text-[11px] text-fg-dim">
                  타임라인에 분할 지점(✂ 또는 T)을 찍으면 그 경계로 잘라 폴더에 저장합니다.
                </div>
              ) : (
                <div className="space-y-0.5">
                  <div className="font-mono tabular-nums text-fg">
                    틱 {ticks.length}개 → {segs.length}개 파일
                  </div>
                  {/* planSegments가 100ms 안쪽 틱을 병합하거나 꼬리를 버리면 N+1이 깨진다.
                      라벨은 정직하지만 이유가 없으면 버그로 읽힌다. */}
                  {segs.length !== ticks.length + 1 && (
                    <div className="text-warn">
                      겹친 지점 {ticks.length + 1 - segs.length}개 병합됨
                    </div>
                  )}
                  <div className="text-[11px] text-fg-dim">
                    영상 전체 · {splitEncode ? "CRF 23 재인코딩" : "무손실 복사"}
                  </div>
                </div>
              )}
              <Field label="폴더">
                <input
                  type="text"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  disabled={batch != null}
                  spellCheck={false}
                  className={inputCls}
                  title="원본 옆에 이 이름의 하위 폴더를 만들어 저장합니다"
                />
              </Field>
              <div className="truncate font-mono text-[11px] text-fg-dim">
                → {dir || "./"}
                {folder.trim() || "…"}/
              </div>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={splitEncode}
                  onChange={(e) => setSplitEncode(e.target.checked)}
                  disabled={batch != null}
                  className="accent-accent"
                />
                정확한 지점에서 분할(재인코딩)
              </label>
              {ticks.length > 0 && !splitEncode && (
                <div className="text-[11px] text-fg-dim">
                  무손실 복사는 자를 지점이 가장 가까운 키프레임으로 당겨집니다(보통 0.1초 이내, GOP가
                  긴 영상은 더 커질 수 있음). 지정한 지점 그대로 자르려면 위 “정확한 지점에서
                  분할(재인코딩)”을 켜세요.
                </div>
              )}
              {/* 분할은 위 설정을 하나도 쓰지 않는다(videoSplit.ts:227-240이 전부 하드코딩).
                  컨트롤이 활성인 채로 무시하면 사용자는 적용된 줄 안다 — 그래서 명시한다. */}
              {ticks.length > 0 &&
                (range || speed !== 1 || maxHeight !== "" || crop || removeAudio || masks.length > 0) && (
                  <div className="text-[11px] text-warn">{splitScopeWarn}</div>
                )}
              <button
                onClick={onClearTicks}
                disabled={batch != null || ticks.length === 0}
                title={`분할 지점 ${ticks.length}개를 모두 지웁니다`}
                className={`${secondaryCls} w-full`}
              >
                틱 지우기
              </button>
            </Section>
          </>
        )}

        {tab === "audio" && (
          <Section title="오디오">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={removeAudio}
                onChange={(e) => setRemoveAudio(e.target.checked)}
                disabled={busy || format !== "mp4" || !probe.hasAudio}
                className="accent-accent"
              />
              오디오 제거
            </label>
            {!probe.hasAudio ? (
              <div className="text-[11px] text-fg-dim">
                이 영상에는 오디오 트랙이 없습니다 — 제거할 것도, 추출할 것도 없습니다.
              </div>
            ) : (
              <div className="text-[11px] text-fg-dim">
                트랙 {probe.acodec ?? "알 수 없음"} · 출력에서 오디오를 뺍니다.
                {format !== "mp4" && " (오디오 제거는 mp4 출력에만 적용됩니다)"}
              </div>
            )}
            {/* 오디오 추출은 재인코딩 경고에서 제외돼 있어, 배속이 스트림 복사를 깨는 것을 아무도 안 알렸다. */}
            {format === "audio" && speed !== 1 && (
              <div className="text-[11px] text-warn">
                배속을 바꾸면 오디오를 스트림 복사할 수 없어 재인코딩됩니다(확장자 {aud.ext}).
              </div>
            )}
          </Section>
        )}

        {tab === "mask" && (
          <Section title="가리기">
            <button
              onClick={onToggleMask}
              disabled={busy || format !== "mp4"}
              className={`${secondaryCls} w-full ${
                maskActive ? "text-accent" : masks.length > 0 ? "text-warn" : ""
              }`}
              title={
                format !== "mp4"
                  ? "가릴 영역은 mp4 출력에서 지정합니다"
                  : "영상 위를 드래그해 모자이크·블러로 가릴 영역을 지정합니다 (여러 곳 가능)"
              }
            >
              <Grid3x3 size={12} />
              {maskActive ? "가리기 지정 중 — 끄기" : "가리기"}
            </button>
            <Field label="가림 방식">
              <select
                value={maskKind}
                onChange={(e) => onSetMaskKind(e.target.value as "mosaic" | "blur")}
                disabled={busy}
                className={selCls}
              >
                <option value="mosaic">모자이크</option>
                <option value="blur">블러</option>
              </select>
            </Field>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono tabular-nums text-fg">
                {masks.length > 0 ? `${maskKind === "blur" ? "블러" : "모자이크"} ${masks.length}곳` : "영역 0곳"}
              </span>
              <button
                onClick={onClearMasks}
                disabled={masks.length === 0}
                title={`가림 영역 ${masks.length}곳을 모두 해제합니다`}
                className={secondaryCls}
              >
                <X size={12} /> 전체 해제
              </button>
            </div>
            {masks.length > 0 && (
              <div className="text-[11px] text-fg-dim">가림이 켜지면 무손실 복사 대신 재인코딩됩니다.</div>
            )}
          </Section>
        )}
      </div>

      {/* ── 고정 푸터 — 예상치·진행·실행. 어느 탭에서도 스크롤되지 않는다. ── */}
      <div className="shrink-0 space-y-2 border-t border-edge bg-panel px-3 py-2.5">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="text-[10px] text-fg-dim">예상 용량</div>
            <div
              className="font-mono tabular-nums text-fg"
              title="소스 비트레이트에 화질(CRF)·픽셀 수 비를 곱한 근사치입니다. GIF·오디오 추출은 근거가 없어 표시하지 않습니다."
            >
              {estBytes != null ? fmtBytes(estBytes) : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-fg-dim">예상 소요</div>
            <div
              className="font-mono tabular-nums text-fg"
              title="실행 중 ffmpeg가 보고하는 실측 속도로 남은 시간을 계산합니다. 실행 전에는 기기·코덱에 따라 편차가 커서 추정하지 않습니다."
            >
              {etaSec != null ? fmtDur(etaSec) : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-fg-dim">출력 길이</div>
            <div className="font-mono tabular-nums text-fg">{fmtTime(outMs / 1000)}</div>
          </div>
        </div>

        {busy && progress && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-raised">
              <div
                className="h-full rounded bg-accent transition-[width]"
                style={{ width: `${Math.min(100, progress.pct)}%` }}
              />
            </div>
            <span className="font-mono tabular-nums text-fg-dim">
              {progress.pct.toFixed(0)}%{progress.speed ? ` · ${progress.speed}` : ""}
            </span>
          </div>
        )}
        {mine && batch && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-raised">
              <div
                className="h-full rounded bg-accent transition-[width]"
                style={{
                  // 완료분 + 현재 잡 진행률 — 세그먼트 경계에서 되감기지 않게 누적으로 그린다.
                  width: `${Math.min(100, ((batch.done + Math.min(100, batch.currentPct) / 100) / batch.total) * 100)}%`,
                }}
              />
            </div>
            <span className="font-mono tabular-nums text-fg-dim">
              {batch.done}/{batch.total} · part-{partLabel(batch.currentIndex)} ·{" "}
              {batch.currentPct.toFixed(0)}%
            </span>
          </div>
        )}

        {/* 비활성 이유는 title에 두면 안 된다 — disabled 버튼은 포인터 이벤트도 포커스도 못 받는다. */}
        {!busy && batch == null && (nothingToDo || nameInvalid) && (
          <div className="text-[11px] text-fg-dim">
            {nameInvalid
              ? "파일명이 비었거나 \\ / .. 를 포함합니다"
              : "바꿀 항목이 없습니다. I·O 키로 구간을 지정하거나 해상도·배속을 바꾸세요"}
          </div>
        )}

        {!busy ? (
          <button
            onClick={() => doExport(false)}
            // 분할 배치와 상호 배타 — 동시 ffmpeg를 띄우지 않는다(프로세스 위생).
            disabled={nothingToDo || nameInvalid || batch != null}
            title={
              batch != null
                ? "분할 저장이 진행 중입니다"
                : nothingToDo
                  ? "구간·배속·화질 등 변경할 항목을 선택하세요"
                  : nameInvalid
                    ? "파일명이 비었거나 경로 문자를 포함합니다"
                    : undefined
            }
            className={primaryCls}
          >
            내보내기
          </button>
        ) : (
          <button
            onClick={() => void ipc.videoExportCancel(jobId!).catch((e) => pushToast("error", errorMessage(e)))}
            className={`${primaryCls} flex items-center justify-center gap-1 bg-transparent border border-edge text-warn hover:bg-raised`}
          >
            <Loader2 size={12} className="animate-spin" /> 취소
          </button>
        )}

        <div className="grid grid-cols-2 gap-2">
          {!mine ? (
            <button
              onClick={() =>
                void startSplit(projectId, path, dir, segs, {
                  folder: folder.trim(),
                  mode: splitEncode ? "encode" : "copy",
                  stem: cleanStem(path),
                  durationMs: probe.durationMs,
                  hasAudio: probe.hasAudio,
                })
              }
              disabled={busy || batch != null || folderInvalid || segs.length === 0}
              title={
                busy
                  ? "내보내기가 끝난 뒤에 실행하세요"
                  : batch != null
                    ? "다른 분할이 진행 중입니다"
                    : folderInvalid
                      ? "폴더명이 비었거나 경로 문자를 포함합니다"
                      : segs.length === 0
                        ? "타임라인에 분할 지점(✂ 또는 T)을 먼저 찍으세요"
                        : splitScopeWarn
              }
              className={secondaryCls}
            >
              <Scissors size={12} /> 분할 전체 저장
            </button>
          ) : (
            <button
              onClick={cancelSplit}
              className={`${secondaryCls} text-warn`}
            >
              <Loader2 size={12} className="animate-spin" /> 분할 취소
            </button>
          )}
          <button
            onClick={captureFrame}
            disabled={busy}
            title="현재 재생 위치의 프레임을 PNG로 저장합니다. 파일명·구간·영역·해상도 설정은 적용되지 않습니다"
            className={secondaryCls}
          >
            <Camera size={12} /> 프레임 저장
          </button>
        </div>
      </div>
    </div>
  );
});
