import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import {
  AlertTriangle,
  Copy,
  Crop,
  FlipHorizontal,
  FlipVertical,
  FileWarning,
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
  applyPaintPatch,
  DOC_VERSION,
  documentColors,
  normalizeDoc,
  paintOf,
  parseImageDoc,
  serializeImageDoc,
  type ImageDocEnvelope,
} from "../../lib/annotate/schema";
import {
  DEFAULT_OPACITY,
  DEFAULT_PAINT,
  TOOL_KINDS,
  type Node,
  type EditorDoc,
  type ObjId,
  type Rect,
  type Tool,
  type DefaultPaint,
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
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import { IDENTITY_VIEW, WHEEL_STEP, zoomAt, type View } from "../../lib/zoom";
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
// 입력 화소수 상한. 8K(33MP)는 통과시키고 초대형 스캔본을 막는 선 — 편집기 하나가 이미지
// 한 장을 두고 디코드·oriented·프리뷰 3장·저장 캔버스를 동시에 들기 때문이다(설계 §6.3).
const MAX_INPUT_PIXELS = 100_000_000;
/** 최근 사용 색 기억 개수(세션 한정). */
const RECENT_COLORS = 6;

/**
 * 닫힌 편집 세션의 문서 — **창 수명 동안만** 산다.
 *
 * ponytail: 프로세스 메모리라 앱을 껐다 켜면 사라진다. 그게 곧 무효화라 직렬화·스키마 버전·
 *           마이그레이션·해시 키가 전부 필요 없다. 세션 **간** 복구가 필요해지면 그때
 *           localStorage 로 올리되, 그 origin 은 `gp:file-draft:*`(복구 불가능한 미저장
 *           파일 내용)와 5MB 를 나눠 쓰므로 총 바이트 상한을 함께 걸어야 한다(설계 §8).
 */
/**
 * `stamp` 는 닫을 때 그 파일의 정체(`read_file_base64` 가 준 값)다. **반드시 함께 들고
 * 있어야 한다** — crop·outW/outH 는 그때의 이미지 크기를 전제한 값이라, 그 사이 파일이
 * 바뀐 뒤 복구하면 크롭이 새 이미지 밖으로 나가 **빈 이미지를 원본 자리에 저장**한다.
 */
const stash = new Map<string, { doc: EditorDoc; stamp: string | null }>();
/** 상한 — 넘으면 가장 오래 안 쓴 키부터 버린다(Map 은 삽입 순서를 유지한다). */
const STASH_MAX = 8;
const stashKey = (pid: string, path: string) => `${pid}\u0000${path}`;

function stashPut(key: string, doc: EditorDoc, stamp: string | null): void {
  stash.delete(key); // 재삽입으로 최근 사용 순서를 갱신한다
  stash.set(key, { doc, stamp });
  while (stash.size > STASH_MAX) {
    const oldest = stash.keys().next().value;
    if (oldest === undefined) break;
    stash.delete(oldest);
  }
}

/** 빈 문서 — 경계(normalizeDoc)가 만든다. 필드를 두 곳에서 셀 이유가 없다(37 §4). */
const EMPTY_DOC: EditorDoc = normalizeDoc({});

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

/**
 * 툴바의 "색" 컨트롤은 kind 마다 다른 슬롯에 앉는다 — v1 `restyle` 의 규칙을 그대로 잇는다:
 * 뱃지는 원 채움, 텍스트는 글자색(둘 다 `fills`), 나머지는 선(`strokes`).
 * 나머지 필드는 schema.applyPaintPatch 가 kind 를 보고 거른다.
 */
function remapPaintForKind(o: Node, patch: Partial<DefaultPaint>): Partial<DefaultPaint> {
  if (!patch.strokes || (o.kind !== "badge" && o.kind !== "text")) return patch;
  const { strokes, ...rest } = patch;
  return { ...rest, fills: strokes };
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
  /** 읽은 시점의 원본 파일 정체 — 제자리 저장에서만 되돌려 준다(§ 무성 덮어쓰기 방지). */
  const stampRef = useRef<string | null>(null);
  /** 직전 편집이 stash 에 남아 있는가. **문서는 건드리지 않는다** — 배너만 띄운다. */
  const [recoverable, setRecoverable] = useState(false);

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
  const [style, setStyle] = useState<DefaultPaint>(DEFAULT_PAINT);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<ObjId[]>([]);

  /**
   * 화면 확대·이동. **CSS transform 으로만** 건다 — 프리뷰 백킹(previewScale/backW/backH)은
   * 절대 따라 키우지 않는다. 백킹을 건드리면 주석 캐시 키가 배율을 물고 있어(AnnotationLayer)
   * 휠 노치마다 전량 재렌더가 돌고, "oriented px == 백킹 px" 를 전제로 한 좌표가 전부 어긋난다.
   */
  const [view, setView] = useState<View>(IDENTITY_VIEW);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 변환이 걸리지 않은 레이아웃 앵커 — 줌 수식의 기준 프레임(rect 가 view 에 흔들리지 않는다). */
  const boxRef = useRef<HTMLDivElement | null>(null);
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
        const { mime, base64, stamp } = await ipc.readFileBase64(projectId, path);
        const image = await loadImage(`data:${mime};base64,${base64}`);
        if (!image.naturalWidth || !image.naturalHeight) {
          throw new Error("이미지 크기를 확인할 수 없습니다 (지원되지 않는 형식일 수 있음)");
        }
        // 입력 상한 — 없으면 캔버스 한계를 넘겨 **빈 화면**이 되거나 조용히 죽는다.
        // 저장 방향에는 이미 상한이 둘 있는데(MAX_OUTPUT_DIM, Rust 의 64MB) 로드 방향만
        // 비어 있었다. 8K(33MP)는 통과하고 초대형 스캔본을 막는 선이다.
        const mp = image.naturalWidth * image.naturalHeight;
        if (
          image.naturalWidth > MAX_OUTPUT_DIM ||
          image.naturalHeight > MAX_OUTPUT_DIM ||
          mp > MAX_INPUT_PIXELS
        ) {
          throw new Error(
            `이미지가 너무 큽니다 (${image.naturalWidth}×${image.naturalHeight}) — ` +
              `한 변 ${MAX_OUTPUT_DIM}px · 총 ${Math.round(MAX_INPUT_PIXELS / 1e6)}백만 화소까지 편집할 수 있습니다`,
          );
        }
        if (alive) {
          // 이 스탬프가 "내가 편집을 시작한 그 파일"의 정체다. 저장할 때 되돌려 주면
          // 그 사이 남이 바꿨는지 Rust 가 판정한다(무성 덮어쓰기 방지).
          stampRef.current = stamp ?? null;
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
    // **자동 복원하지 않는다.** 안 그린 주석이 떠 있는 것이 사라지는 것만큼 헷갈리고,
    // e2e 30 의 openEditor 가 "objects.length === 0" 을 기다리는 계약도 깨진다(설계 K7).
    // 닫을 때와 **같은 파일**일 때만 제안한다. 다르면 항목을 버린다 — 낡은 crop 으로
    // 복구하면 빈 이미지를 저장하게 되고, 그건 조용한 데이터 손실이다.
    if (projectId && path) {
      const key = stashKey(projectId, path);
      const held = stash.get(key);
      if (held && held.stamp !== stampRef.current) stash.delete(key);
      setRecoverable(!!held && held.stamp === stampRef.current);
    } else {
      setRecoverable(false);
    }
  }, [img, projectId, path]);

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
  /** 화면에 실제로 보이는 배율(맞춤 × 줌) — 주석 레이어가 화면 상수를 계산하는 근거값이다. */
  const screenScale = displayScale * view.scale;

  // 방향(회전·반전)이 바뀌거나 새 이미지가 들어오면 맞춤으로 되돌린다. 옛 방향에서 쌓은 팬
  // 오프셋은 그 순간 의미가 없어져 이미지가 화면 밖으로 튀어나간다.
  useEffect(() => setView(IDENTITY_VIEW), [oriented]);

  // 휠 = 줌. **non-passive 로 직접 등록해야 한다** — React 의 onWheel 은 passive 라
  // preventDefault 가 무시되고 WebView2 가 페이지째 확대해 버린다(ImageView 와 같은 이유).
  // ctrlKey 도 함께 받으므로 트랙패드 핀치가 배선 없이 붙는다.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const box = boxRef.current;
      if (!box) return;
      e.preventDefault();
      const r = box.getBoundingClientRect(); // 앵커는 변환 밖이라 view 와 무관하게 안정적이다
      const factor = Math.pow(WHEEL_STEP, -e.deltaY / 100);
      setView((v) => zoomAt(v, e.clientX - r.left, e.clientY - r.top, factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 팬은 **가운데 버튼 드래그**다. 좌버튼은 주석 레이어가 그리기·선택·이동·리사이즈·크롭에
  // 전부 쓰고 있어(포인터 이벤트가 버블링된다) 좌드래그 팬을 얹으면 그리기가 오염된다.
  const panFrom = useRef<{ x: number; y: number } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault(); // 가운데 버튼 오토스크롤 차단
    panFrom.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const from = panFrom.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    panFrom.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const endPan = (e: React.PointerEvent) => {
    if (!panFrom.current) return;
    panFrom.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };

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
    let objs: readonly Node[] = d.objects;
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
    // 선택 객체의 페인트를 툴바로 끌어온다. 뱃지·텍스트는 "색"이 채우기 슬롯에 있으므로
    // 툴바가 읽는 strokes 자리로 옮겨 보여 준다(remapPaintForKind 의 역).
    const p = paintOf(o);
    setStyle((s) => ({
      ...s,
      ...p,
      strokes:
        o.kind === "badge" || o.kind === "text"
          ? p.fills.length
            ? p.fills
            : s.strokes
          : p.strokes.length
            ? p.strokes
            : s.strokes,
      fills: o.kind === "rect" || o.kind === "ellipse" ? p.fills : s.fills,
      strokeWidth: o.strokeWidth || s.strokeWidth,
    }));
    setOpacity(o.opacity);
  }, [selectedIds]);

  /** 속성 패널이 따를 도구 — 선택 중이면 선택된 객체의 종류(NodeKind ⊂ Tool). */
  const propTool: Tool = (() => {
    if (tool !== "select" || selectedIds.length !== 1) return tool;
    const kind = doc.objects.find((o) => o.id === selectedIds[0])?.kind;
    // path·frame·group·instance 는 도구가 없다(만드는 UI 는 태스크 45·46) — 속성 패널은
    // 현재 도구를 따른다.
    return kind && (TOOL_KINDS as readonly string[]).includes(kind) ? (kind as Tool) : tool;
  })();

  const onStyleChange = (patch: Partial<DefaultPaint>, live = false) => {
    setStyle((s) => ({ ...s, ...patch }));
    const picked = patch.strokes?.find((f) => f.visible && f.type === "solid");
    if (picked && picked.type === "solid") {
      const c = picked.color;
      setRecent((r) => [c, ...r.filter((x) => x !== c)].slice(0, RECENT_COLORS));
    }
    if (!selectedIds.length) return;
    const next = docRef.current.objects.map((o) =>
      selectedIds.includes(o.id) ? applyPaintPatch(o, remapPaintForKind(o, patch)) : o,
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

  /**
   * 복원은 **applyDoc 통째 교체**여야 한다. stash 의 objects 는 "그 rotation/flip 이 이미
   * 적용된 공간"의 값이라, patchDoc({rotation}) 으로 넣으면 transformObjects 델타가 두 번
   * 걸린다 — 바로 아래 rotateBy 주석에 한 번 당한 기록이 남아 있는 그 함정이다.
   * applyDoc 은 transformObjects 를 아예 부르지 않으므로 구조적으로 안전하다.
   */
  const restoreStashed = () => {
    if (!projectId || !path) return;
    const key = stashKey(projectId, path);
    const held = stash.get(key);
    if (held) applyDoc(held.doc, "commit");
    stash.delete(key);
    setRecoverable(false);
  };
  const discardStashed = () => {
    if (projectId && path) stash.delete(stashKey(projectId, path));
    setRecoverable(false);
  };

  const dir = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const baseNoExt = (() => {
    if (!path) return "image";
    const b = path.split("/").pop() ?? path;
    const d = b.lastIndexOf(".");
    return d > 0 ? b.slice(0, d) : b;
  })();

  /**
   * @param ignoreStamp 외부 변경 확인창에서 "그래도 저장"을 누른 재시도. 스탬프를 빼야
   *   같은 CONFLICT 가 무한 반복되지 않는다.
   */
  const writeTo = (relPath: string, overwrite: boolean, ignoreStamp = false) => {
    if (!oriented || !projectId) return;
    // 스탬프는 **읽은 그 파일에 제자리로 쓸 때만** 의미가 있다. 다른 이름으로 저장은 대상이
    // 다른 파일이라 이 스탬프와 아무 관계가 없다 — 붙이면 항상 충돌한다.
    const stamp =
      !ignoreStamp && relPath === path ? stampRef.current ?? undefined : undefined;
    setBusy(true);
    // renderOutput()은 동기지만 encodeCanvas는 avif에서 wasm을 동적 로드하므로 프라미스로 처리.
    void Promise.resolve()
      .then(() => encodeCanvas(renderOutput(), format, quality))
      .then((bytes) => {
        const base64 = bytesToBase64(bytes);
        saveImage.mutate(
          { relPath, base64, overwrite, expectedStamp: stamp },
          {
            onSuccess: () => {
              // 열어 둔 **그 파일**에 구웠을 때만 복구 항목을 버린다 — 다시 열었을 때 같은
              // objects 를 복원하면 주석이 두 겹이 되기 때문이다. 다른 이름으로 저장했다면
              // 원본은 한 바이트도 안 바뀌었으므로 복구는 그대로 살려 둔다.
              if (projectId && path && relPath === path) {
                stash.delete(stashKey(projectId, path));
              }
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
                  onConfirm: () => writeTo(relPath, true, ignoreStamp),
                });
              } else if (isIpcError(e) && e.code === "CONFLICT") {
                // 편집을 시작한 뒤 남이 그 파일을 바꿨다. 종전에는 이 저장이 그 변경을
                // **말없이** 날렸다. 재시도는 반드시 ignoreStamp 로 — 안 그러면 무한 반복.
                askConfirm({
                  title: "외부에서 변경됨",
                  message:
                    "편집을 시작한 뒤 이 파일이 다른 곳에서 바뀌었습니다. 저장하면 그 변경을 덮어씁니다.",
                  detail: relPath,
                  confirmLabel: "그래도 저장",
                  danger: true,
                  onConfirm: () => writeTo(relPath, overwrite, true),
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
  //
  // in-place 판정은 **포맷**으로 한다 — 확장자 문자열로 비교하면 안 된다. extOf 는 언제나
  // 정규 확장자 하나만 돌려주므로(jpeg→jpg) `사진.jpeg`·`사진.PNG` 같은 원본은 대상이
  // `사진.jpg`·`사진.png` 가 되어 자기 자신과 불일치한다 → overwrite=false 로 나가서
  // 원본은 그대로 둔 채 형제 파일만 만들거나(.jpeg), 없는 충돌로 덮어쓰기 확인창을 띄운다
  // (대소문자 무시 파일시스템). "덮어쓰기 예를 눌렀는데 원본이 안 바뀐다"의 원인이었다.
  const saveInPlace = () => {
    const inPlace = path !== null && formatOfPath(path) === format;
    const targetPath = inPlace ? path : `${dir}${baseNoExt}.${extOf(format)}`;
    const go = () => writeTo(targetPath, inPlace);
    if (doc.objects.length) {
      askConfirm({
        title: "주석을 합쳐 저장",
        message: inPlace
          ? "주석이 이미지에 합쳐져 원본을 덮어씁니다. 벡터 편집 정보는 남지 않습니다."
          : "주석이 합쳐진 새 파일로 저장됩니다(원본은 그대로). 벡터 편집 정보는 남지 않습니다.",
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
    // objects 가 있을 때만 확인을 받고, **실제로 닫는 순간** 문서를 넣어 둔다.
    // 확인 앞에서 넣으면 사용자가 취소한 뒤 주석을 다 지우고 닫았을 때 옛 문서가 남아
    // "안 그린 주석"을 복원 제안하게 된다.
    if (docRef.current.objects.length) {
      askConfirm({
        title: "편집기 닫기",
        message:
          "닫으면 주석이 편집기에서 사라집니다. **이 창에서** 같은 파일을 다시 열면 복구할 수 있습니다(창을 닫으면 사라집니다).",
        confirmLabel: "닫기",
        danger: true,
        onConfirm: () => {
          if (projectId && path) {
            stashPut(stashKey(projectId, path), docRef.current, stampRef.current);
          }
          close();
        },
      });
    } else {
      close();
    }
  }, [askConfirm, close, projectId, path]);

  /**
   * doc 창의 X(FloatTitleBar → `win.close()`)는 편집기의 닫기 가드를 **지나지 않는다** —
   * 확인도 없이 창째 사라지고, stash 는 이 창 수명 스코프라 함께 죽는다. 즉 여기서 막을 수
   * 있는 것은 "말없이 사라지는 것" 하나뿐이므로 확인을 받는다.
   *
   * 확인 후에는 `destroy()` 를 부른다 — `close()` 는 CloseRequested 를 다시 발화시켜
   * 확인창이 무한히 뜬다. Rust 쪽 CloseRequested 핸들러는 `main` 라벨만 다루므로 간섭 없다.
   */
  useEffect(() => {
    if (!IS_DOC_WINDOW) return;
    const win = getCurrentWebviewWindow();
    let off: (() => void) | undefined;
    let dead = false;
    void win
      .onCloseRequested((e) => {
        if (!docRef.current.objects.length) return;
        e.preventDefault();
        askConfirm({
          title: "창 닫기",
          message:
            "저장하지 않은 주석이 있습니다. 창을 닫으면 되돌릴 수 없습니다.",
          confirmLabel: "닫기",
          danger: true,
          onConfirm: () => void win.destroy(),
        });
      })
      .then((f) => {
        if (dead) f();
        else off = f;
      })
      .catch(() => {
        /* 창 API 를 못 쓰는 환경 — 종전과 같이 그냥 닫힌다 */
      });
    return () => {
      dead = true;
      off?.();
    };
  }, [askConfirm]);

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
      // setDoc 은 **경계**다 — v1 리터럴이든 부분 문서든 여기서 완전한 v2 문서가 된다(37 §3.3).
      // 그래서 30·34·35 의 setDoc 리터럴 21건이 재작성 없이 산다.
      setDoc: (patch: Partial<EditorDoc>) =>
        patchDoc(normalizeDoc({ ...docRef.current, ...patch })),
      setTool: (t: Tool) => setTool(t),
      renderOnce: () => layerRef.current?.renderOnce(),
      /** 직렬화 왕복이 문서를 바꾸지 않는가 — 태스크 41(사이드카 자동저장)의 전제다. */
      roundTrip: () => {
        const env: ImageDocEnvelope = {
          v: 2,
          projectId: editorRepoId ?? "",
          relPath: path ?? "",
          imageStamp: stampRef.current,
          imageW: docRef.current.outW,
          imageH: docRef.current.outH,
          savedAt: 0,
          doc: docRef.current,
          foreign: [],
          log: [],
        };
        const back = parseImageDoc(serializeImageDoc(env)).env.doc;
        const key = (v: unknown): string =>
          JSON.stringify(v, (_k, x) =>
            x && typeof x === "object" && !Array.isArray(x)
              ? Object.fromEntries(Object.entries(x as object).sort())
              : x,
          );
        return key(back) === key(docRef.current);
      },
      schema: {
        normalizeDoc,
        parse: parseImageDoc,
        serialize: serializeImageDoc,
        documentColors,
        emptyDoc: () => EMPTY_DOC,
        version: DOC_VERSION,
      },
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
    // 래퍼의 클래스 문자열은 **그대로 두어야 한다** — e2e 30·34 가 `div.fixed.inset-0.z-50`
    // 안의 '이미지 편집' 문구로 편집기를 잡는다. doc 창에서는 인라인 top 으로 FloatTitleBar
    // (h-8 = 32px)를 비켜 주고, 안쪽 카드만 창을 꽉 채우게 편다. 덮으면 창을 옮기지도 닫지도
    // 못한다. stage 재적합은 기존 ResizeObserver 가 하므로 리사이즈 코드는 필요 없다.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      style={IS_DOC_WINDOW ? { top: 32 } : undefined}
    >
      <div
        className={
          IS_DOC_WINDOW
            ? "flex h-full w-full flex-col overflow-hidden bg-panel"
            : "flex h-[min(820px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        }
      >
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
          {/* 배율 표시·맞춤 복귀는 **헤더**에 둔다. 우측 패널에 넣으면 e2e 30의 selCount 가
              "N개 선택" 앞 텍스트 노드를 함께 읽어 오염된다(그 스위트 주석에 남은 기존 함정). */}
          {showStage && (
            <>
              <span
                title="휠로 확대·축소, 가운데 버튼 드래그로 이동"
                className="shrink-0 tabular-nums text-[11px] text-fg-dim"
              >
                {Math.round(screenScale * 100)}%
              </span>
              <button
                onClick={() => setView(IDENTITY_VIEW)}
                title="화면에 맞추기"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-raised hover:text-fg"
              >
                맞춤
              </button>
            </>
          )}
          <button
            onClick={requestClose}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        {recoverable && (
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px]">
            <FileWarning size={12} className="shrink-0 text-warn" />
            <span className="flex-1 truncate text-fg-muted">
              직전에 저장하지 않고 닫은 편집이 있습니다.
            </span>
            <button
              type="button"
              onClick={restoreStashed}
              className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-fg hover:bg-accent hover:text-on-accent"
            >
              이어서 하기
            </button>
            <button
              type="button"
              onClick={discardStashed}
              className="shrink-0 rounded px-1.5 py-0.5 text-fg-dim hover:bg-raised hover:text-fg"
            >
              버리기
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* 프리뷰 — 이미지(색보정 CSS 필터) 위에 주석 캔버스를 겹친다(§4.3) */}
          <div
            ref={stageRef}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            className="checkerboard flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
          >
            {loadErr ? (
              <div className="text-sm text-danger">{loadErr}</div>
            ) : !img ? (
              <div className="flex items-center gap-2 text-sm text-fg-dim">
                <Loader2 size={16} className="animate-spin" /> 이미지 불러오는 중…
              </div>
            ) : showStage && oriented ? (
              // 바깥은 **변환이 걸리지 않는 앵커**다 — 줌 수식의 기준 프레임이라 rect 가
              // view 에 따라 흔들리면 안 된다. 확대분은 stage 의 overflow-hidden 이 자른다.
              <div ref={boxRef} className="relative" style={{ width: dispW, height: dispH }}>
                <div
                  className="absolute inset-0 shadow-lg"
                  style={{
                    transformOrigin: "0 0",
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  }}
                >
                <canvas
                  ref={previewRef}
                  className="absolute inset-0 h-full w-full"
                  style={{
                    filter: filterStr,
                    // 100% 를 넘겨 확대하면 보간을 끄고 픽셀을 그대로 보여준다(뷰어와 같은 규칙).
                    imageRendering: screenScale >= 2 ? "pixelated" : "auto",
                  }}
                />
                <AnnotationLayer
                  ref={layerRef}
                  oriented={oriented}
                  backW={backW}
                  backH={backH}
                  scale={previewScale}
                  // 줌을 곱해 넘긴다 — 이 prop 의 계약은 "oriented → **화면** css px" 라
                  // 히트 허용오차·핸들 집기 반경·핸들 그리기 크기가 전부 스스로 맞는다.
                  // transform 안쪽 DOM(텍스트 편집 textarea)만 zoom 으로 되나눈다.
                  displayScale={screenScale}
                  zoom={view.scale}
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
