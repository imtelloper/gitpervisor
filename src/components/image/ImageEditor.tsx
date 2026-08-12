import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import {
  AlertTriangle,
  Copy,
  Crop,
  FlipHorizontal,
  FlipVertical,
  Loader2,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  normalizeRect,
  transformObjects,
  type OrientDelta,
} from "../../lib/annotate/geometry";
import { DocHistory } from "../../lib/annotate/history";
import { renderScene } from "../../lib/annotate/render";
import {
  DEFAULT_OPACITY,
  DEFAULT_STYLE,
  type AnnoObject,
  type EditorDoc,
  type ObjId,
  type Rect,
  type Tool,
  type ToolStyle,
} from "../../lib/annotate/types";
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
import AnnotationLayer, {
  type AnnotationLayerHandle,
} from "./AnnotationLayer";
import AnnotationToolbar from "./AnnotationToolbar";

// 프리뷰 백킹 스토어 상한 — 거대 이미지를 전체 해상도로 그리면 메모리 폭증 + Chromium 캔버스
// 한계(빈 화면)에 걸린다. 프리뷰는 이 한도로 다운스케일하고, 크롭 좌표는 항상 oriented px 기준.
const MAX_PREVIEW = 1800;
// 출력 캔버스 한 변 상한(Chromium 캔버스 한계 가드) — 초과 시 인코딩 전에 명확히 실패시킨다.
const MAX_OUTPUT_DIM = 16384;
/** 최근 사용 색 기억 개수(세션 한정). */
const RECENT_COLORS = 6;

const EMPTY_DOC: EditorDoc = {
  objects: [],
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: null,
  outW: 0,
  outH: 0,
  brightness: 100,
  contrast: 100,
  saturate: 100,
};

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

/** 확장자 → 비-라운드트립 경고 문구(설계 D3, §6.3). 라운드트립 가능한 포맷이면 null. */
function roundTripWarning(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext === "svg") return "SVG → PNG 래스터화되어 저장됩니다";
  if (ext === "gif") return "첫 프레임만 편집·저장됩니다";
  return formatOfPath(path) === null ? "PNG로 저장됩니다" : null;
}

/** 툴바 속성 변경을 선택된 객체에 반영한다(종류별로 의미 있는 필드만). */
function restyle(o: AnnoObject, s: Partial<ToolStyle>): AnnoObject {
  const n: AnnoObject = { ...o };
  if (s.stroke !== undefined) {
    // 뱃지의 "색"은 원 채움이다 — 숫자 글자색은 렌더러가 대비로 정한다.
    if (n.kind === "badge") n.fill = s.stroke;
    else n.stroke = s.stroke;
  }
  if (s.strokeWidth !== undefined) n.strokeWidth = s.strokeWidth;
  if (s.fill !== undefined && (n.kind === "rect" || n.kind === "ellipse")) {
    n.fill = s.fill;
  }
  if (s.radius !== undefined && n.kind === "rect") n.radius = s.radius;
  if (s.fontSize !== undefined && (n.kind === "text" || n.kind === "badge")) {
    n.fontSize = s.fontSize;
  }
  if (s.mosaicMode !== undefined && n.kind === "mosaic") n.mode = s.mosaicMode;
  if (s.mosaicStrength !== undefined && n.kind === "mosaic") {
    n.strength = s.mosaicStrength;
  }
  return n;
}

/**
 * 이미지 편집기 모달 — 트리·뷰어에서 "이미지 편집"으로 연다.
 * 회전/반전/크롭/리사이즈/색보정 + 주석(마크업) 후 평탄화 저장(DOCS/image-annotation-design.md).
 */
export default function ImageEditor() {
  const path = useUi((s) => s.imageEditorPath);
  const editorRepoId = useUi((s) => s.imageEditorRepoId);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  // 임베디드 저장소 파일이면 그 저장소 id로 읽고 써야 한다 — 경로만 믿으면 바깥 레포에
  // 엉뚱한 파일을 만든다(설계 D1).
  const projectId = editorRepoId ?? selectedProjectId;
  const close = useUi((s) => s.closeImageEditor);
  const askPrompt = useUi((s) => s.askPrompt);
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const saveImage = useSaveImage(projectId ?? "");

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // ── 편집 문서(히스토리 스냅샷 단위, §5.1) ──
  const [doc, setDoc] = useState<EditorDoc>(EMPTY_DOC);
  const docRef = useRef(doc);
  docRef.current = doc;
  const histRef = useRef<DocHistory>(new DocHistory(EMPTY_DOC));
  // canUndo/canRedo 는 클래스 내부 상태라 리렌더 트리거가 따로 필요하다.
  const [histVer, setHistVer] = useState(0);

  // ── 문서 밖 UI 상태 ──
  const [cropMode, setCropMode] = useState(false);
  const [lockRatio, setLockRatio] = useState(true);
  const [format, setFormat] = useState<ImgFormat>("png");
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const [tool, setTool] = useState<Tool>("select");
  const [style, setStyle] = useState<ToolStyle>(DEFAULT_STYLE);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<ObjId[]>([]);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<AnnotationLayerHandle | null>(null);

  // ── 문서 갱신 ──────────────────────────────────────────────────────────────

  /**
   * 문서를 갱신한다. `mode:"commit"` 은 히스토리 스냅샷을 남기고, `"replace"` 는 남기지 않는다
   * (드래그 중 라이브 갱신). React 18+ StrictMode 가 업데이터를 두 번 부를 수 있으므로
   * 히스토리 조작은 setState 업데이터 **밖**에서 한다.
   */
  const applyDoc = useCallback(
    (next: EditorDoc, mode: "commit" | "replace" = "commit") => {
      docRef.current = next;
      if (mode === "commit") histRef.current.commit(next);
      else histRef.current.replace(next);
      setDoc(next);
      setHistVer((v) => v + 1);
    },
    [],
  );

  const patchDoc = useCallback(
    (patch: Partial<EditorDoc>, mode: "commit" | "replace" = "commit") =>
      applyDoc({ ...docRef.current, ...patch }, mode),
    [applyDoc],
  );

  // 슬라이더처럼 드래그 중 연속으로 바뀌는 값 — 첫 틱만 스냅샷을 남기고 나머지는 덮어쓴다.
  // 결과적으로 드래그 한 번이 히스토리 한 칸이 된다(§5.3).
  const liveRef = useRef(false);
  const patchLive = useCallback(
    (patch: Partial<EditorDoc>) => {
      patchDoc(patch, liveRef.current ? "replace" : "commit");
      liveRef.current = true;
    },
    [patchDoc],
  );
  const endLive = useCallback(() => {
    liveRef.current = false;
  }, []);

  const undo = useCallback(() => {
    const d = histRef.current.undo();
    if (!d) return;
    docRef.current = d;
    setDoc(d);
    setHistVer((v) => v + 1);
    setSelectedIds([]);
  }, []);
  const redo = useCallback(() => {
    const d = histRef.current.redo();
    if (!d) return;
    docRef.current = d;
    setDoc(d);
    setHistVer((v) => v + 1);
    setSelectedIds([]);
  }, []);

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

  // 새 이미지가 들어오면 문서와 히스토리를 통째로 초기화한다.
  useEffect(() => {
    if (!img) return;
    const d: EditorDoc = {
      ...EMPTY_DOC,
      outW: img.naturalWidth,
      outH: img.naturalHeight,
    };
    docRef.current = d;
    histRef.current.reset(d);
    setDoc(d);
    setHistVer((v) => v + 1);
    setSelectedIds([]);
    setCropMode(false);
    setTool("select");
  }, [img]);

  const { rotation, flipH, flipV, crop, outW, outH, brightness, contrast, saturate } =
    doc;
  const filterStr = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;

  // 회전·반전이 적용된 캔버스(메모) — 방향이 바뀌면 새 정체성을 갖는다.
  const oriented = useMemo(
    () => (img ? buildOriented(img, rotation, flipH, flipV) : null),
    [img, rotation, flipH, flipV],
  );

  // ── 캔버스 크기 계산(두 캔버스가 항상 같은 값을 쓴다, §4.3) ────────────────
  const previewScale = oriented
    ? Math.min(1, MAX_PREVIEW / Math.max(oriented.width, oriented.height))
    : 1;
  const backW = oriented ? Math.max(1, Math.round(oriented.width * previewScale)) : 1;
  const backH = oriented ? Math.max(1, Math.round(oriented.height * previewScale)) : 1;

  // 표시 크기는 JS로 계산한다 — 두 캔버스를 겹치려면 절대배치가 필요한데, 절대배치된
  // 캔버스에는 max-width/height 백분율이 먹지 않기 때문(둘의 크기가 어긋나면 좌표가 깨진다).
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit =
    oriented && stage.w > 0 && stage.h > 0
      ? Math.min(1, stage.w / oriented.width, stage.h / oriented.height)
      : 0;
  const dispW = oriented ? Math.max(1, Math.round(oriented.width * fit)) : 0;
  const dispH = oriented ? Math.max(1, Math.round(oriented.height * fit)) : 0;
  const displayScale = oriented && fit > 0 ? dispW / oriented.width : 1;
  const showStage = !!oriented && fit > 0;

  // 베이스 캔버스는 방향·크기가 바뀔 때만 다시 그린다(색보정은 CSS 필터, 주석은 위 캔버스).
  useLayoutEffect(() => {
    const c = previewRef.current;
    if (!c || !oriented || !showStage) return;
    c.width = backW;
    c.height = backH;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, backW, backH);
    ctx.drawImage(oriented, 0, 0, backW, backH);
  }, [oriented, backW, backH, showStage]);

  // 유효 소스(크롭이 있으면 크롭, 아니면 방향 캔버스) — 리사이즈 비율 기준.
  const effW = crop ? crop.w : oriented?.width ?? 0;
  const effH = crop ? crop.h : oriented?.height ?? 0;

  // ── 방향 변경(§3.2) — 주석 기하를 새 oriented 공간으로 함께 옮긴다 ─────────
  //
  // 여기서만 델타를 적용한다. 예전처럼 `oriented` 변경 효과에 얹으면 undo/redo 로 rotation 이
  // 복원될 때도 효과가 돌아 **델타가 두 번 걸린다** — 스냅샷의 objects 는 이미 그 공간이다.

  /**
   * 반전이 홀수 개 걸려 있으면 화면 기준 회전 방향이 뒤집힌다(buildOriented 가 회전 후
   * 이미지 공간에서 반전하기 때문). 실측으로 확인한 관계다.
   */
  const rotateBy = (plus90: boolean) => {
    if (!oriented) return;
    const d = docRef.current;
    const mirrored = d.flipH !== d.flipV;
    const delta: OrientDelta = plus90 !== mirrored ? "rotCW" : "rotCCW";
    patchDoc({
      rotation: (d.rotation + (plus90 ? 90 : 270)) % 360,
      objects: transformObjects(d.objects, delta, oriented.width, oriented.height),
      crop: null,
      outW: oriented.height,
      outH: oriented.width,
    });
  };

  const flipBy = (axis: "h" | "v") => {
    if (!oriented) return;
    const d = docRef.current;
    const objects = transformObjects(
      d.objects,
      axis === "h" ? "flipH" : "flipV",
      oriented.width,
      oriented.height,
    );
    patchDoc({
      ...(axis === "h" ? { flipH: !d.flipH } : { flipV: !d.flipV }),
      objects,
      crop: null,
      outW: oriented.width,
      outH: oriented.height,
    });
  };

  // ── 크롭(포인터는 주석 캔버스가 받아 여기로 위임한다) ──────────────────────
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);
  const cropLiveRef = useRef<Rect | null>(null);

  const onCropDown = useCallback((p: { x: number; y: number }) => {
    cropStartRef.current = p;
    cropLiveRef.current = null;
    layerRef.current?.setCropPreview(null);
  }, []);
  const onCropMove = useCallback((p: { x: number; y: number }) => {
    const st = cropStartRef.current;
    if (!st) return;
    const r = normalizeRect(st.x, st.y, p.x, p.y);
    cropLiveRef.current = r;
    layerRef.current?.setCropPreview(r);
  }, []);
  /** Esc 로 드래그가 취소되면 시작점·라이브 사각형을 버린다 — 남아 있으면 버튼을 떼는 순간 확정된다. */
  const onCropCancel = useCallback(() => {
    cropStartRef.current = null;
    cropLiveRef.current = null;
    layerRef.current?.setCropPreview(null);
  }, []);
  const onCropUp = useCallback(() => {
    const st = cropStartRef.current;
    cropStartRef.current = null;
    const r = cropLiveRef.current;
    cropLiveRef.current = null;
    layerRef.current?.setCropPreview(null);
    // 시작점이 없다 = Esc 로 취소된 드래그다. 커밋하지 않는다(§5.4 계층 3).
    if (!st) return;
    // 너무 작은 선택은 무시(클릭 오조작)
    if (r && r.w >= 4 && r.h >= 4) {
      const rect: Rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.w),
        h: Math.round(r.h),
      };
      patchDoc({ crop: rect, outW: rect.w, outH: rect.h });
      setCropMode(false);
    }
  }, [patchDoc]);

  const clearCrop = () => {
    if (!oriented) return;
    patchDoc({ crop: null, outW: oriented.width, outH: oriented.height });
  };

  // 타이핑 한 글자마다 히스토리를 쌓지 않도록 슬라이더와 같은 라이브 규칙을 쓴다(blur 에서 끝).
  const changeW = (v: number) => {
    const w = Math.max(1, Math.round(v || 0));
    patchLive({
      outW: w,
      outH: lockRatio && effW > 0 ? Math.max(1, Math.round((w * effH) / effW)) : outH,
    });
  };
  const changeH = (v: number) => {
    const h = Math.max(1, Math.round(v || 0));
    patchLive({
      outH: h,
      outW: lockRatio && effH > 0 ? Math.max(1, Math.round((h * effW) / effH)) : outW,
    });
  };

  /** 모든 편집을 되돌린다 — 주석은 지우지 않고 원래 방향의 좌표로 되돌린다. */
  const resetAll = () => {
    if (!img || !oriented) return;
    const d = docRef.current;
    let objs: readonly AnnoObject[] = d.objects;
    let w = oriented.width;
    let h = oriented.height;
    if (d.flipH) objs = transformObjects(objs, "flipH", w, h);
    if (d.flipV) objs = transformObjects(objs, "flipV", w, h);
    // 반전을 걷어낸 뒤에는 화면 회전 방향이 뒤집히지 않는다 — 남은 회전만큼 CCW로 되돌린다.
    for (let r = d.rotation; r > 0; r -= 90) {
      objs = transformObjects(objs, "rotCCW", w, h);
      const t = w;
      w = h;
      h = t;
    }
    patchDoc({
      objects: objs.slice(),
      rotation: 0,
      flipH: false,
      flipV: false,
      crop: null,
      outW: img.naturalWidth,
      outH: img.naturalHeight,
      brightness: 100,
      contrast: 100,
      saturate: 100,
    });
    setCropMode(false);
  };

  // ── 툴바 콜백 ─────────────────────────────────────────────────────────────

  // 객체 하나를 고르면 그 객체의 속성을 툴바에 끌어온다 — 패널이 보여주는 값과 실제 값이
  // 어긋나면 슬라이더를 건드리는 순간 엉뚱한 값으로 덮어쓴다.
  useEffect(() => {
    if (selectedIds.length !== 1) return;
    const o = docRef.current.objects.find((x) => x.id === selectedIds[0]);
    if (!o) return;
    setStyle((s) => ({
      ...s,
      stroke: o.kind === "badge" ? o.fill : o.stroke,
      strokeWidth: o.strokeWidth || s.strokeWidth,
      fill: o.kind === "rect" || o.kind === "ellipse" ? o.fill : s.fill,
      radius: o.kind === "rect" ? o.radius : s.radius,
      fontSize: o.kind === "text" || o.kind === "badge" ? o.fontSize : s.fontSize,
      mosaicMode: o.kind === "mosaic" ? o.mode : s.mosaicMode,
      mosaicStrength: o.kind === "mosaic" ? o.strength : s.mosaicStrength,
    }));
    setOpacity(o.opacity);
  }, [selectedIds]);

  /** 속성 패널이 따를 도구 — 선택 중이면 선택된 객체의 종류(AnnoKind ⊂ Tool). */
  const propTool: Tool =
    tool === "select" && selectedIds.length === 1
      ? doc.objects.find((o) => o.id === selectedIds[0])?.kind ?? tool
      : tool;

  const onStyleChange = (patch: Partial<ToolStyle>, live = false) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (patch.stroke) {
      setRecent((r) =>
        [patch.stroke!, ...r.filter((c) => c !== patch.stroke)].slice(
          0,
          RECENT_COLORS,
        ),
      );
    }
    if (!selectedIds.length) return;
    const next = docRef.current.objects.map((o) =>
      selectedIds.includes(o.id) ? restyle(o, patch) : o,
    );
    if (live) patchLive({ objects: next });
    else patchDoc({ objects: next });
  };

  const onOpacityChange = (v: number, live = false) => {
    setOpacity(v);
    if (!selectedIds.length) return;
    const next = docRef.current.objects.map((o) =>
      selectedIds.includes(o.id) ? { ...o, opacity: v } : o,
    );
    if (live) patchLive({ objects: next });
    else patchDoc({ objects: next });
  };

  // ── 출력 ──────────────────────────────────────────────────────────────────

  /**
   * 모든 편집을 적용한 최종 출력 캔버스(크롭 → 리사이즈 → 색보정 → 주석, §4.2).
   * @param opaqueBg 투명을 흰색으로 채운다(비투명 포맷 저장용). 클립보드 복사는 항상 false.
   */
  const renderOutput = (opaqueBg = format === "jpeg"): HTMLCanvasElement => {
    const base = oriented!;
    const d = docRef.current;
    const sx = d.crop ? d.crop.x : 0;
    const sy = d.crop ? d.crop.y : 0;
    const sw = d.crop ? d.crop.w : base.width;
    const sh = d.crop ? d.crop.h : base.height;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(d.outW || sw));
    out.height = Math.max(1, Math.round(d.outH || sh));
    if (out.width > MAX_OUTPUT_DIM || out.height > MAX_OUTPUT_DIM) {
      throw new Error(`출력 크기가 너무 큽니다 (한 변 ${MAX_OUTPUT_DIM}px 초과)`);
    }
    const ctx = out.getContext("2d")!;
    // jpeg/avif 등 비투명 포맷에서 투명 배경이 검게 나오지 않도록 흰색 채움.
    if (opaqueBg) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.filter = filterStr;
    ctx.drawImage(base, sx, sy, sw, sh, 0, 0, out.width, out.height);
    // D2: 필터를 반드시 복구한다 — 안 그러면 밝기·대비·채도가 주석까지 물들인다.
    ctx.filter = "none";
    // 크롭 원점 이동 + 리사이즈 배율만 주면 크롭 밖 주석은 캔버스 경계에서 자동으로 잘린다(§3.1).
    renderScene(ctx, d.objects, {
      tx: -sx,
      ty: -sy,
      sx: out.width / sw,
      sy: out.height / sh,
    });
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
  // 주석이 있으면 평탄화가 **비가역**이므로(원본 픽셀도 벡터 문서도 사라진다) 확인을 받는다(§6.1).
  const saveInPlace = () => {
    const targetPath = `${dir}${baseNoExt}.${extOf(format)}`;
    const go = () => writeTo(targetPath, targetPath === path);
    if (doc.objects.length) {
      askConfirm({
        title: "주석을 합쳐 저장",
        message:
          "주석이 이미지에 합쳐져 원본을 덮어씁니다. 벡터 편집 정보는 남지 않습니다.",
        detail: targetPath,
        confirmLabel: "합쳐서 저장",
        danger: true,
        onConfirm: go,
      });
    } else {
      go();
    }
  };

  const saveAs = () =>
    askPrompt({
      title: "다른 이름으로 저장",
      label: "같은 폴더에 저장됩니다.",
      // 주석이 있으면 원본을 건드리지 않는 이름을 기본값으로 — 안전한 쪽이 기본 경로다(§6.1).
      defaultValue: `${baseNoExt}${doc.objects.length ? "-annotated" : ""}.${extOf(format)}`,
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

  /** 편집 결과를 PNG로 클립보드에 넣는다(§6.2). 파일 저장 포맷과 무관하게 항상 PNG. */
  const copyToClipboard = () => {
    if (!oriented) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => encodeCanvas(renderOutput(false), "png"))
      .then((bytes) => writeImage(bytes))
      .then(() => pushToast("success", "클립보드에 복사됨 (PNG)"))
      .catch((e) => pushToast("error", errorMessage(e)))
      .finally(() => setBusy(false));
  };

  // ── 닫기 · Esc 계층(§5.4) ─────────────────────────────────────────────────

  /** 주석이 남아 있으면 확인을 받고 닫는다 — 세션을 닫으면 벡터가 사라진다(평탄화 모델). */
  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    if (docRef.current.objects.length) {
      askConfirm({
        title: "편집기 닫기",
        message: "닫으면 주석이 사라집니다. 저장하지 않은 편집은 되돌릴 수 없습니다.",
        confirmLabel: "닫기",
        danger: true,
        onConfirm: close,
      });
    } else {
      close();
    }
  }, [askConfirm, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      // 1) 위에 프롬프트/확인 모달이 있으면 그쪽이 처리한다.
      if (ui.prompt || ui.confirm) return;
      if (e.key === "Escape") {
        if (busyRef.current) return;
        // 2~5) 텍스트 확정 → 드래프트 취소 → select 복귀 → 선택 해제
        if (layerRef.current?.handleEscape()) return;
        // 6) 크롭 모드 해제
        if (cropMode) {
          setCropMode(false);
          layerRef.current?.setCropPreview(null);
          return;
        }
        // 7~8) 주석이 있으면 확인 후 닫기, 없으면 즉시 닫기
        requestClose();
        return;
      }
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return; // 텍스트 입력 중에는 편집기 단축키를 잡지 않는다(§5.5)
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cropMode, requestClose, undo, redo]);

  // ── E2E 훅(§9.4) — DEV 빌드에서만 노출 ────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const g = window as unknown as { __gpv?: Record<string, unknown> };
    g.__gpv = g.__gpv ?? {};
    g.__gpv.imageEditor = {
      getDoc: () => docRef.current,
      setDoc: (patch: Partial<EditorDoc>) => patchDoc(patch),
      setTool: (t: Tool) => setTool(t),
      renderOnce: () => layerRef.current?.renderOnce(),
    };
    return () => {
      delete g.__gpv?.imageEditor;
    };
  }, [patchDoc]);

  if (!path) return null;

  const warn = roundTripWarning(path);
  const canUndo = histRef.current.canUndo;
  const canRedo = histRef.current.canRedo;
  void histVer; // 히스토리 깊이 변화로 리렌더되게 하는 의존(값 자체는 쓰지 않는다)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[min(820px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl">
        {/* 헤더 */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-4">
          <span className="font-semibold">이미지 편집</span>
          <span className="truncate font-mono text-xs text-fg-dim">{path}</span>
          {warn && (
            <span
              title="원본 포맷으로 되돌려 저장할 수 없습니다"
              className="flex shrink-0 items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn"
            >
              <AlertTriangle size={11} /> {warn}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={requestClose}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 프리뷰 — 이미지(색보정 CSS 필터) 위에 주석 캔버스를 겹친다(§4.3) */}
          <div
            ref={stageRef}
            className="checkerboard flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
          >
            {loadErr ? (
              <div className="text-sm text-danger">{loadErr}</div>
            ) : !img ? (
              <div className="flex items-center gap-2 text-sm text-fg-dim">
                <Loader2 size={16} className="animate-spin" /> 이미지 불러오는 중…
              </div>
            ) : showStage && oriented ? (
              <div
                className="relative shadow-lg"
                style={{ width: dispW, height: dispH }}
              >
                <canvas
                  ref={previewRef}
                  className="absolute inset-0 h-full w-full"
                  style={{ filter: filterStr }}
                />
                <AnnotationLayer
                  ref={layerRef}
                  oriented={oriented}
                  backW={backW}
                  backH={backH}
                  scale={previewScale}
                  displayScale={displayScale}
                  filterStr={filterStr}
                  objects={doc.objects}
                  selectedIds={selectedIds}
                  tool={tool}
                  style={style}
                  opacity={opacity}
                  cropMode={cropMode}
                  cropRect={crop}
                  onCropDown={onCropDown}
                  onCropMove={onCropMove}
                  onCropUp={onCropUp}
                  onCropCancel={onCropCancel}
                  onCommit={(objects) => patchDoc({ objects })}
                  onToolChange={setTool}
                  onSelectionChange={setSelectedIds}
                />
              </div>
            ) : null}
          </div>

          {/* 컨트롤 */}
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-edge p-3 text-[13px]">
            <Section title="주석">
              <AnnotationToolbar
                tool={tool}
                onToolChange={setTool}
                propTool={propTool}
                style={style}
                onStyleChange={onStyleChange}
                opacity={opacity}
                onOpacityChange={onOpacityChange}
                onEditEnd={endLive}
                recentColors={recent}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={undo}
                onRedo={redo}
              />
              <div className="mt-1.5 text-[11px] text-fg-dim">
                {selectedIds.length > 0
                  ? `${selectedIds.length}개 선택 — Delete 삭제 · Ctrl+D 복제 · [ ] 순서`
                  : "드래그로 그리고, V로 선택합니다"}
              </div>
            </Section>

            <Section title="회전 · 반전">
              <div className="grid grid-cols-4 gap-1.5">
                <IconBtn title="왼쪽 90°" onClick={() => rotateBy(false)}>
                  <RotateCcw size={15} />
                </IconBtn>
                <IconBtn title="오른쪽 90°" onClick={() => rotateBy(true)}>
                  <RotateCw size={15} />
                </IconBtn>
                <IconBtn
                  title="좌우 반전"
                  active={flipH}
                  onClick={() => flipBy("h")}
                >
                  <FlipHorizontal size={15} />
                </IconBtn>
                <IconBtn
                  title="상하 반전"
                  active={flipV}
                  onClick={() => flipBy("v")}
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
                <NumInput value={outW} onChange={changeW} onEnd={endLive} />
                <span className="text-fg-dim">×</span>
                <NumInput value={outH} onChange={changeH} onEnd={endLive} />
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
                onChange={(v) => patchLive({ brightness: v })}
                onEnd={endLive}
                min={0}
                max={200}
              />
              <Slider
                label="대비"
                value={contrast}
                onChange={(v) => patchLive({ contrast: v })}
                onEnd={endLive}
                min={0}
                max={200}
              />
              <Slider
                label="채도"
                value={saturate}
                onChange={(v) => patchLive({ saturate: v })}
                onEnd={endLive}
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
            onClick={copyToClipboard}
            disabled={busy || !img}
            title="편집 결과를 PNG로 클립보드에 복사"
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
          >
            <Copy size={14} /> 복사
          </button>
          <button
            onClick={requestClose}
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
  onEnd,
}: {
  value: number;
  onChange: (v: number) => void;
  /** 입력이 끝났음을 알린다 — 다음 변경이 새 히스토리 칸이 된다. */
  onEnd?: () => void;
}) {
  return (
    <input
      type="number"
      min={1}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onBlur={onEnd}
      className="w-16 rounded border border-edge bg-raised px-1.5 py-1 text-center font-mono text-[12px] outline-none focus:border-accent"
    />
  );
}

function Slider({
  label,
  value,
  onChange,
  onEnd,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** 드래그가 끝났음을 알린다 — 히스토리가 드래그 한 번을 한 칸으로 묶는다(§5.3). */
  onEnd?: () => void;
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
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        className="w-full accent-accent"
      />
    </div>
  );
}
