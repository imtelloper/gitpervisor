// 내보내기 패널 (설계 §4.6) — 구간·배속·화질·크롭·형식을 단일 ExportSpec으로 수렴시킨다.
//
// - 무손실 복사(copy)는 배속·크롭·해상도·GIF와 양립 불가 → 그 옵션이 켜지면 자동으로
//   재인코딩이 되고 안내 문구를 띄운다(침묵 전환 금지 — 설계 결정 4).
// - 파일명은 원본 옆 접미사(clip/crop/xN/…): 이미지 편집기와 같은 저장 규약. 같은 폴더 한정.
// - 진행·완료는 video:// 이벤트가 진실(invoke 응답 유실 대비). 완료 토스트는 events.ts
//   전역 리스너 한 곳에서만 — 여기는 자기 jobId의 진행률·busy 해제만 담당한다.
import { listen } from "@tauri-apps/api/event";
import { Camera, Crop as CropIcon, Loader2, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

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
import { fmtTime } from "./VideoPlayer";

type Format = "mp4" | "gif" | "audio";
type Quality = "copy" | "18" | "23" | "28";

const selCls = "rounded border border-edge bg-panel px-1 py-0.5 text-xs text-fg-muted";
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function splitPath(path: string): { dir: string; stem: string } {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const dot = base.lastIndexOf(".");
  return { dir, stem: dot > 0 ? base.slice(0, dot) : base };
}

/** 오디오 추출 규칙 — aac/mp3는 무손실 복사(컨테이너만 교체), 그 외는 aac 재인코딩. */
function audioPlan(acodec: string | null, forceEncode: boolean): { ext: string; mode: "copy" | "encode" } {
  if (!forceEncode && acodec === "aac") return { ext: "m4a", mode: "copy" };
  if (!forceEncode && acodec === "mp3") return { ext: "mp3", mode: "copy" };
  return { ext: "m4a", mode: "encode" };
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
  getTime: () => number;
}) {
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const qc = useQueryClient();

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
  const [folder, setFolder] = useState(() => `${splitPath(path).stem}.split`);
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
    format === "gif" || speed !== 1 || !!crop || (format === "mp4" && maxHeight !== "");
  const aud = audioPlan(probe?.acodec ?? null, speed !== 1);
  const mode: "copy" | "encode" =
    format === "audio" ? aud.mode : quality === "copy" && !forcesEncode ? "copy" : "encode";

  // 접미사 자동 이름 — 사용자가 손대기 전까지만 갱신.
  const suggested = useMemo(() => {
    const { stem } = splitPath(path);
    if (format === "gif") return `${stem}${range ? ".clip" : ""}.gif`;
    if (format === "audio") return `${stem}.${aud.ext}`;
    const parts: string[] = [];
    if (range) parts.push("clip");
    if (crop) parts.push("crop");
    if (speed !== 1) parts.push(`x${speed}`);
    if (maxHeight) parts.push(`${maxHeight}p`);
    if (removeAudio) parts.push("mute");
    if (parts.length === 0 && mode === "encode") parts.push("edit");
    return `${stem}.${parts.join(".") || "copy"}.mp4`;
  }, [path, format, range, crop, speed, maxHeight, removeAudio, mode, aud.ext]);

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
      <div className="shrink-0 border-t border-edge px-3 py-3 text-xs text-fg-muted">
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
      <div className="shrink-0 border-t border-edge px-3 py-3 text-xs text-warn">
        미디어 정보를 읽지 못했습니다 — {probeError}
      </div>
    );
  if (!probe)
    return (
      <div className="shrink-0 border-t border-edge px-3 py-3 text-xs text-fg-dim">
        미디어 정보 읽는 중…
      </div>
    );

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

  const captureFrame = (overwrite: boolean) => {
    const t = getTime();
    const ms = Math.round(t * 1000);
    const { stem } = splitPath(path);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const frac = ms % 1000;
    const out = `${dir}${stem}.frame-${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s${String(frac).padStart(3, "0")}.png`;
    void ipc
      .videoCaptureFrame(projectId, path, ms, out, overwrite)
      .then(() => {
        pushToast("success", `프레임 저장됨 — ${out.split("/").pop()}`);
        void qc.invalidateQueries({ queryKey: ["dir"] });
        void qc.invalidateQueries({ queryKey: ["statuses"] });
      })
      .catch((e) => {
        if (isIpcError(e) && e.code === "ALREADY_EXISTS" && !overwrite) {
          askConfirm({
            title: "덮어쓰기",
            message: "같은 이름의 프레임 파일이 있습니다. 덮어쓸까요?",
            confirmLabel: "덮어쓰기",
            danger: true,
            onConfirm: () => captureFrame(true),
          });
        } else pushToast("error", errorMessage(e));
      });
  };

  const busy = jobId != null;
  // 분할 배치는 앱 전역에 하나뿐(스토어) — 이 파일 것인지 남의 것인지 나눠 본다.
  const mine =
    batch != null && batch.projectId === projectId && batch.srcRel === path;
  const segs = planSegments(ticks, probe.durationMs / 1000);
  const folderInvalid = !folder.trim() || /[\\/]|\.\./.test(folder);
  // 진행 중이면 틱이 없어도(패널을 닫았다 열거나 파일을 오갔다) 진행 표시는 살려 둔다.
  const showSplit = ticks.length > 0 || mine;
  const partLabel = (i: number) =>
    String(i).padStart(Math.max(2, String(batch?.total ?? 0).length), "0");

  return (
    <div className="shrink-0 space-y-2 border-t border-edge px-3 py-2 text-xs text-fg-muted">
      {/* 1행: 구간·배속·화질·해상도·영역·오디오 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1">
          구간
          <span className="font-mono tabular-nums text-fg">
            {range ? `${fmtTime(inPt!)} ~ ${fmtTime(outPt!)}` : "전체"}
          </span>
          {range && (
            <button onClick={onClearRange} title="구간 해제" className="text-fg-dim hover:text-fg">
              <X size={11} />
            </button>
          )}
          {!range && <span className="text-fg-dim">(I/O 키로 지정)</span>}
        </span>

        <label className="flex items-center gap-1">
          배속
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
        </label>

        {format === "mp4" && (
          <>
            <label className="flex items-center gap-1">
              화질
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as Quality)}
                disabled={busy}
                className={selCls}
                title="무손실 복사는 재인코딩 없이 빠르지만 시작점이 키프레임 단위로 스냅됩니다"
              >
                <option value="copy">무손실 복사</option>
                <option value="18">원본급 (CRF 18)</option>
                <option value="23">표준 (CRF 23)</option>
                <option value="28">압축 (CRF 28)</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              해상도
              <select
                value={maxHeight}
                onChange={(e) => setMaxHeight(e.target.value as typeof maxHeight)}
                disabled={busy}
                className={selCls}
              >
                <option value="">원본</option>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
              </select>
            </label>
            <button
              onClick={onToggleCrop}
              disabled={busy}
              className={`flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 hover:bg-raised ${cropActive ? "text-accent" : ""}`}
              title="영상 위를 드래그해 추출 영역 지정"
            >
              <CropIcon size={11} />
              {crop ? `${crop.w}×${crop.h}` : "영역"}
            </button>
            {crop && (
              <button onClick={onClearCrop} title="영역 해제" className="text-fg-dim hover:text-fg">
                <X size={11} />
              </button>
            )}
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={removeAudio}
                onChange={(e) => setRemoveAudio(e.target.checked)}
                disabled={busy}
                className="accent-accent"
              />
              오디오 제거
            </label>
          </>
        )}
      </div>

      {/* 2행: 형식·파일명·실행 */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          형식
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
            disabled={busy}
            className={selCls}
          >
            <option value="mp4">mp4 동영상</option>
            <option value="gif">GIF</option>
            <option value="audio" disabled={!probe.hasAudio}>
              오디오만 ({aud.ext})
            </option>
          </select>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            nameEditedRef.current = true;
            setName(e.target.value);
          }}
          disabled={busy}
          spellCheck={false}
          className="min-w-40 flex-1 rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-fg"
          title="원본과 같은 폴더에 저장됩니다"
        />
        <button
          onClick={() => captureFrame(false)}
          disabled={busy}
          title="현재 프레임을 PNG로 저장"
          className="flex items-center gap-1 rounded border border-edge px-2 py-1 hover:bg-raised hover:text-fg"
        >
          <Camera size={12} /> 프레임
        </button>
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
            className="rounded bg-accent/20 px-3 py-1 font-semibold text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            내보내기
          </button>
        ) : (
          <button
            onClick={() => void ipc.videoExportCancel(jobId!).catch(() => {})}
            className="flex items-center gap-1 rounded border border-edge px-3 py-1 text-warn hover:bg-raised"
          >
            <Loader2 size={12} className="animate-spin" /> 취소
          </button>
        )}
      </div>

      {/* 3행: 분할 — 틱이 있거나(설정 중) 이 파일의 배치가 도는 중일 때만 */}
      {showSplit && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-edge pt-2">
            <span className="flex items-center gap-1">
              분할
              <span className="font-mono tabular-nums text-fg">
                틱 {ticks.length}개 → {segs.length}개 파일
              </span>
              <span className="text-fg-dim">(T 키로 지정)</span>
            </span>
            <label className="flex items-center gap-1">
              폴더
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                disabled={batch != null}
                spellCheck={false}
                className="min-w-32 rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-fg"
                title="원본 옆에 이 이름의 하위 폴더를 만들어 저장합니다"
              />
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={splitEncode}
                onChange={(e) => setSplitEncode(e.target.checked)}
                disabled={batch != null}
                className="accent-accent"
              />
              정확한 지점에서 분할(재인코딩)
            </label>
            <button
              onClick={onClearTicks}
              disabled={batch != null || ticks.length === 0}
              className="rounded border border-edge px-2 py-1 hover:bg-raised hover:text-fg disabled:opacity-40"
            >
              틱 지우기
            </button>
            {!mine ? (
              <button
                onClick={() =>
                  void startSplit(projectId, path, dir, segs, {
                    folder: folder.trim(),
                    mode: splitEncode ? "encode" : "copy",
                    stem: splitPath(path).stem,
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
                        : undefined
                }
                className="rounded bg-accent/20 px-3 py-1 font-semibold text-accent hover:bg-accent/30 disabled:opacity-40"
              >
                분할 저장
              </button>
            ) : (
              <button
                onClick={cancelSplit}
                className="flex items-center gap-1 rounded border border-edge px-3 py-1 text-warn hover:bg-raised"
              >
                <Loader2 size={12} className="animate-spin" /> 취소
              </button>
            )}
          </div>
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
        </>
      )}

      {/* 안내·진행 */}
      {((quality === "copy" && format === "mp4" && mode === "copy") ||
        (showSplit && !splitEncode)) && (
        <div className="text-[11px] text-fg-dim">
          무손실 복사는 시작점이 키프레임 단위로 스냅됩니다(수 초 어긋날 수 있음) — 정밀 컷은
          화질을 재인코딩으로.
        </div>
      )}
      {quality === "copy" && forcesEncode && format !== "audio" && (
        <div className="text-[11px] text-warn">
          배속·영역·해상도·GIF는 무손실 복사와 함께 쓸 수 없어 재인코딩(표준 화질)됩니다.
        </div>
      )}
      {format === "gif" && !range && (
        <div className="text-[11px] text-warn">
          구간 없이 전체를 GIF로 만들면 파일이 매우 커질 수 있습니다 — I/O로 구간을 지정하세요.
        </div>
      )}
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
    </div>
  );
});
