import {
  Crop,
  FlipHorizontal,
  FlipVertical,
  Loader2,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  bytesToBase64,
  encodeCanvas,
  extOf,
  FORMATS,
  formatOfPath,
  loadImage,
  supportsQuality,
  type ImgFormat,
} from "../../lib/image-codec";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import { useSaveImage } from "../../queries";
import { useUi } from "../../stores/ui";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// 프리뷰 백킹 스토어 상한 — 거대 이미지를 전체 해상도로 그리면 메모리 폭증 + Chromium 캔버스
// 한계(빈 화면)에 걸린다. 프리뷰는 이 한도로 다운스케일하고, 크롭 좌표는 항상 oriented px 기준.
const MAX_PREVIEW = 1800;
// 출력 캔버스 한 변 상한(Chromium 캔버스 한계 가드) — 초과 시 인코딩 전에 명확히 실패시킨다.
const MAX_OUTPUT_DIM = 16384;

/** 회전(0/90/180/270) + 좌우/상하 반전을 적용한 원본 해상도 캔버스를 만든다(필터·크롭 전). */
function buildOriented(
  img: HTMLImageElement,
  rotation: number,
  flipH: boolean,
  flipV: boolean,
): HTMLCanvasElement {
  const swap = rotation % 180 !== 0;
  const w = swap ? img.naturalHeight : img.naturalWidth;
  const h = swap ? img.naturalWidth : img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  // 반전은 이미지 공간(rotate 이후 scale)으로 적용되므로, 1/4바퀴 회전 시 화면 기준 축이
  // 뒤바뀐다. 사용자가 본 대로(화면 기준) 반전하려면 회전이 90/270°일 때 H↔V를 교환한다.
  const fh = swap ? flipV : flipH;
  const fv = swap ? flipH : flipV;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();
  return c;
}

/** 이미지 편집기 모달 — 트리에서 "이미지 편집"으로 연다. 회전/반전/크롭/리사이즈/색보정 후 저장. */
export default function ImageEditor() {
  const path = useUi((s) => s.imageEditorPath);
  const projectId = useUi((s) => s.selectedProjectId);
  const close = useUi((s) => s.closeImageEditor);
  const askPrompt = useUi((s) => s.askPrompt);
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const saveImage = useSaveImage(projectId ?? "");

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturate, setSaturate] = useState(100);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [outW, setOutW] = useState(0);
  const [outH, setOutH] = useState(0);
  const [lockRatio, setLockRatio] = useState(true);
  const [format, setFormat] = useState<ImgFormat>("png");
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const liveRect = useRef<Rect | null>(null);

  // ── 원본 로드 ──
  useEffect(() => {
    if (!projectId || !path) return;
    let alive = true;
    setImg(null);
    setLoadErr(null);
    void (async () => {
      try {
        const { mime, base64 } = await ipc.readFileBase64(projectId, path);
        const image = await loadImage(`data:${mime};base64,${base64}`);
        if (!image.naturalWidth || !image.naturalHeight) {
          throw new Error("이미지 크기를 확인할 수 없습니다 (지원되지 않는 형식일 수 있음)");
        }
        if (alive) {
          setImg(image);
          setFormat(formatOfPath(path) ?? "png");
        }
      } catch (e) {
        if (alive) setLoadErr(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, path]);

  const filterStr = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;

  // 회전·반전이 적용된 캔버스(메모) — 방향이 바뀌면 새 정체성을 갖는다.
  const oriented = useMemo(
    () => (img ? buildOriented(img, rotation, flipH, flipV) : null),
    [img, rotation, flipH, flipV],
  );

  // 방향이 바뀌거나 새로 로드되면 크롭·출력 크기를 새 방향 크기로 초기화.
  useEffect(() => {
    if (!oriented) return;
    setCrop(null);
    liveRect.current = null;
    setOutW(oriented.width);
    setOutH(oriented.height);
  }, [oriented]);

  // 유효 소스(크롭이 있으면 크롭, 아니면 방향 캔버스) — 리사이즈 비율 기준.
  const effW = crop ? crop.w : oriented?.width ?? 0;
  const effH = crop ? crop.h : oriented?.height ?? 0;

  // ── 프리뷰 페인트(크롭 오버레이) — 색보정 필터는 CSS로 입혀 슬라이더마다 재래스터하지 않는다 ──
  const paint = useCallback(
    (override?: Rect | null) => {
      const c = previewRef.current;
      if (!c || !oriented) return;
      const s = Math.min(1, MAX_PREVIEW / Math.max(oriented.width, oriented.height));
      c.width = Math.max(1, Math.round(oriented.width * s));
      c.height = Math.max(1, Math.round(oriented.height * s));
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(oriented, 0, 0, c.width, c.height);
      const r = override !== undefined ? override : crop;
      if (r && r.w > 0 && r.h > 0) {
        // 크롭은 oriented px → 프리뷰 px 로 환산해 그린다.
        const x = r.x * s;
        const y = r.y * s;
        const w = r.w * s;
        const h = r.h * s;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(0, 0, c.width, y);
        ctx.fillRect(0, y + h, c.width, c.height - (y + h));
        ctx.fillRect(0, y, x, h);
        ctx.fillRect(x + w, y, c.width - (x + w), h);
        ctx.strokeStyle = "#4fa3ff";
        ctx.lineWidth = Math.max(1.5, c.width / 400);
        ctx.strokeRect(x, y, w, h);
      }
    },
    [oriented, crop],
  );

  useEffect(() => {
    paint();
  }, [paint]);

  // 포인터 → oriented px (백킹 스토어 배율과 무관하게 표시 영역 비율로 환산).
  const eventToOriented = (e: React.PointerEvent) => {
    const c = previewRef.current!;
    const rect = c.getBoundingClientRect();
    const ow = oriented?.width ?? c.width;
    const oh = oriented?.height ?? c.height;
    const x = clamp(((e.clientX - rect.left) / rect.width) * ow, 0, ow);
    const y = clamp(((e.clientY - rect.top) / rect.height) * oh, 0, oh);
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!cropMode || !oriented) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = eventToOriented(e);
    liveRect.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const p = eventToOriented(e);
    const s = dragRef.current;
    const r: Rect = {
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    };
    liveRect.current = r;
    paint(r);
  };
  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const r = liveRect.current;
    liveRect.current = null;
    // 너무 작은 선택은 무시(클릭 오조작)
    if (r && r.w >= 4 && r.h >= 4) {
      const rect: Rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.w),
        h: Math.round(r.h),
      };
      setCrop(rect);
      setOutW(rect.w);
      setOutH(rect.h);
      setCropMode(false);
    } else {
      paint();
    }
  };

  const clearCrop = () => {
    setCrop(null);
    if (oriented) {
      setOutW(oriented.width);
      setOutH(oriented.height);
    }
  };

  const changeW = (v: number) => {
    const w = Math.max(1, Math.round(v || 0));
    setOutW(w);
    if (lockRatio && effW > 0) setOutH(Math.max(1, Math.round((w * effH) / effW)));
  };
  const changeH = (v: number) => {
    const h = Math.max(1, Math.round(v || 0));
    setOutH(h);
    if (lockRatio && effH > 0) setOutW(Math.max(1, Math.round((h * effW) / effH)));
  };

  const resetAll = () => {
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
    setBrightness(100);
    setContrast(100);
    setSaturate(100);
    setCrop(null);
    setCropMode(false);
    // outW/outH 는 oriented 변경 효과로 재설정되지만, 방향이 이미 0이면 직접 맞춘다.
    if (img) {
      setOutW(img.naturalWidth);
      setOutH(img.naturalHeight);
    }
  };

  /** 모든 편집을 적용한 최종 출력 캔버스를 만든다(크롭 → 리사이즈 → 필터). */
  const renderOutput = (): HTMLCanvasElement => {
    const base = oriented!;
    const sx = crop ? crop.x : 0;
    const sy = crop ? crop.y : 0;
    const sw = crop ? crop.w : base.width;
    const sh = crop ? crop.h : base.height;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(outW || sw));
    out.height = Math.max(1, Math.round(outH || sh));
    if (out.width > MAX_OUTPUT_DIM || out.height > MAX_OUTPUT_DIM) {
      throw new Error(`출력 크기가 너무 큽니다 (한 변 ${MAX_OUTPUT_DIM}px 초과)`);
    }
    const ctx = out.getContext("2d")!;
    // jpeg/avif 등 비투명 포맷에서 투명 배경이 검게 나오지 않도록 흰색 채움.
    if (format === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.filter = filterStr;
    ctx.drawImage(base, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  };

  const dir = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const baseNoExt = (() => {
    if (!path) return "image";
    const b = path.split("/").pop() ?? path;
    const d = b.lastIndexOf(".");
    return d > 0 ? b.slice(0, d) : b;
  })();

  const writeTo = (relPath: string, overwrite: boolean) => {
    if (!oriented || !projectId) return;
    setBusy(true);
    // renderOutput()은 동기지만 encodeCanvas는 avif에서 wasm을 동적 로드하므로 프라미스로 처리.
    void Promise.resolve()
      .then(() => encodeCanvas(renderOutput(), format, quality))
      .then((bytes) => {
        const base64 = bytesToBase64(bytes);
        saveImage.mutate(
          { relPath, base64, overwrite },
          {
            onSuccess: () => {
              pushToast("success", `저장됨 — ${relPath.split("/").pop()}`);
              close();
            },
            onError: (e) => {
              // 기존 파일 충돌 → 덮어쓰기 확인 후 재시도(데이터 손실 방지).
              if (isIpcError(e) && e.code === "ALREADY_EXISTS") {
                askConfirm({
                  title: "덮어쓰기",
                  message: `'${relPath.split("/").pop()}' 파일이 이미 있습니다. 덮어쓸까요?`,
                  detail: relPath,
                  confirmLabel: "덮어쓰기",
                  danger: true,
                  onConfirm: () => writeTo(relPath, true),
                });
              } else {
                pushToast("error", errorMessage(e));
              }
            },
            onSettled: () => setBusy(false),
          },
        );
      })
      .catch((e) => {
        pushToast("error", errorMessage(e));
        setBusy(false);
      });
  };

  // "저장": 원본 포맷 그대로면 연 파일을 덮어쓴다(의도된 in-place). 포맷을 바꿨으면 새 형제
  // 파일이 되므로 덮어쓰기는 충돌 확인을 거친다.
  const saveInPlace = () => {
    const targetPath = `${dir}${baseNoExt}.${extOf(format)}`;
    writeTo(targetPath, targetPath === path);
  };
  const saveAs = () =>
    askPrompt({
      title: "다른 이름으로 저장",
      label: "같은 폴더에 저장됩니다.",
      defaultValue: `${baseNoExt}.${extOf(format)}`,
      confirmLabel: "저장",
      validate: (v) => {
        const t = v.trim();
        if (!t) return "이름을 입력하세요";
        if (/[\\/]/.test(t)) return "이름에 경로 구분자를 쓸 수 없습니다";
        if (t === "." || t === ".." || t.includes("..")) return "잘못된 이름입니다";
        return null;
      },
      onConfirm: (name) => writeTo(`${dir}${name}`, false),
    });

  // Esc 로 닫기 — 단, 위에 프롬프트/확인 모달이 떠 있으면(다른 이름·덮어쓰기) 그쪽이 먼저 처리.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (e.key === "Escape" && !busy && !ui.prompt && !ui.confirm) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, close]);

  if (!path) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[min(820px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl">
        {/* 헤더 */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-4">
          <span className="font-semibold">이미지 편집</span>
          <span className="truncate font-mono text-xs text-fg-dim">{path}</span>
          <div className="flex-1" />
          <button
            onClick={() => !busy && close()}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 프리뷰 */}
          <div className="checkerboard flex min-w-0 flex-1 items-center justify-center overflow-auto p-4">
            {loadErr ? (
              <div className="text-sm text-danger">{loadErr}</div>
            ) : !img ? (
              <div className="flex items-center gap-2 text-sm text-fg-dim">
                <Loader2 size={16} className="animate-spin" /> 이미지 불러오는 중…
              </div>
            ) : (
              <canvas
                ref={previewRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className={`max-h-full max-w-full shadow-lg ${
                  cropMode ? "cursor-crosshair" : ""
                }`}
                style={{ touchAction: "none", filter: filterStr }}
              />
            )}
          </div>

          {/* 컨트롤 */}
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-edge p-3 text-[13px]">
            <Section title="회전 · 반전">
              <div className="grid grid-cols-4 gap-1.5">
                <IconBtn
                  title="왼쪽 90°"
                  onClick={() => setRotation((r) => (r + 270) % 360)}
                >
                  <RotateCcw size={15} />
                </IconBtn>
                <IconBtn
                  title="오른쪽 90°"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                >
                  <RotateCw size={15} />
                </IconBtn>
                <IconBtn
                  title="좌우 반전"
                  active={flipH}
                  onClick={() => setFlipH((v) => !v)}
                >
                  <FlipHorizontal size={15} />
                </IconBtn>
                <IconBtn
                  title="상하 반전"
                  active={flipV}
                  onClick={() => setFlipV((v) => !v)}
                >
                  <FlipVertical size={15} />
                </IconBtn>
              </div>
            </Section>

            <Section title="크롭">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setCropMode((v) => !v)}
                  className={`flex items-center gap-1 rounded px-2 py-1 ${
                    cropMode
                      ? "bg-accent/20 text-accent"
                      : "bg-raised text-fg-muted hover:text-fg"
                  }`}
                >
                  <Crop size={14} />
                  {cropMode ? "영역을 드래그" : "크롭 선택"}
                </button>
                {crop && (
                  <button
                    onClick={clearCrop}
                    className="rounded px-2 py-1 text-fg-dim hover:bg-raised hover:text-fg"
                  >
                    해제
                  </button>
                )}
              </div>
              {crop && (
                <div className="mt-1.5 font-mono text-[11px] text-fg-dim">
                  {Math.round(crop.w)} × {Math.round(crop.h)} px
                </div>
              )}
            </Section>

            <Section title="크기">
              <div className="flex items-center gap-1.5">
                <NumInput value={outW} onChange={changeW} />
                <span className="text-fg-dim">×</span>
                <NumInput value={outH} onChange={changeH} />
                <button
                  onClick={() => setLockRatio((v) => !v)}
                  title="비율 고정"
                  className={`rounded px-2 py-1 text-[11px] ${
                    lockRatio
                      ? "bg-accent/20 text-accent"
                      : "bg-raised text-fg-dim hover:text-fg"
                  }`}
                >
                  {lockRatio ? "비율 ✓" : "비율"}
                </button>
              </div>
            </Section>

            <Section title="색 보정">
              <Slider
                label="밝기"
                value={brightness}
                onChange={setBrightness}
                min={0}
                max={200}
              />
              <Slider
                label="대비"
                value={contrast}
                onChange={setContrast}
                min={0}
                max={200}
              />
              <Slider
                label="채도"
                value={saturate}
                onChange={setSaturate}
                min={0}
                max={200}
              />
            </Section>

            <Section title="포맷">
              <div className="grid grid-cols-4 gap-1.5">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    className={`rounded px-2 py-1 text-[12px] ${
                      format === f.id
                        ? "bg-accent text-on-accent"
                        : "bg-raised text-fg-muted hover:text-fg"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {supportsQuality(format) && (
                <div className="mt-2">
                  <Slider
                    label="품질"
                    value={quality}
                    onChange={setQuality}
                    min={1}
                    max={100}
                  />
                </div>
              )}
            </Section>
          </aside>
        </div>

        {/* 푸터 */}
        <div className="flex h-13 shrink-0 items-center gap-2 border-t border-edge px-4">
          <button
            onClick={resetAll}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
          >
            초기화
          </button>
          <div className="flex-1" />
          <button
            onClick={() => !busy && close()}
            className="rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised"
          >
            취소
          </button>
          <button
            onClick={saveAs}
            disabled={busy || !img}
            className="rounded border border-edge px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
          >
            다른 이름으로
          </button>
          <button
            onClick={saveInPlace}
            disabled={busy || !img}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            저장 ({extOf(format)})
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 border-b border-edge/60 pb-3 last:border-0">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
        {title}
      </div>
      {children}
    </div>
  );
}

function IconBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex items-center justify-center rounded py-1.5 ${
        active
          ? "bg-accent/20 text-accent"
          : "bg-raised text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function NumInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={1}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-16 rounded border border-edge bg-raised px-1.5 py-1 text-center font-mono text-[12px] outline-none focus:border-accent"
    />
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-[11px] text-fg-dim">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  );
}
