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
import { ensureAssets, imageStore } from "../../lib/annotate/imageStore";
import { useImageDocPersist } from "../../lib/annotate/persist";
import {
  estimateRenderBytes,
  renderOutput as renderOutputTiled,
  renderRegion,
} from "../../lib/annotate/render";
import { resolveScene } from "../../lib/annotate/scene";
import { isGeomNode, selectBox, translateObject } from "../../lib/annotate/geometry";
import { matchShortcut } from "../../lib/annotate/shortcuts";
import {
  assertTreeInvariant,
  group as treeGroup,
  makeMask as treeMakeMask,
  maskScope as treeMaskScope,
  nodeAABB as treeNodeAABB,
  remove as treeRemove,
  reorder as treeReorder,
  reparent as treeReparent,
  rotateNodes as treeRotate,
  subtreeRange as treeSubtreeRange,
  translateSubtree as treeTranslate,
  ungroup as treeUngroup,
} from "../../lib/annotate/tree";
import { acquireAsset, acquireFromFile } from "../../lib/annotate/assets";
import {
  applyPaintPatch,
  DOC_VERSION,
  documentColors,
  normalizeDoc,
  normalizeNode,
  paintOf,
  parseImageDoc,
  serializeImageDoc,
  type ImageDocEnvelope,
} from "../../lib/annotate/schema";
import {
  DEFAULT_OPACITY,
  DEFAULT_PAINT,
  DUPLICATE_OFFSET,
  newObjId,
  TOOL_KINDS,
  type Node,
  type EditorDoc,
  type ObjId,
  type Rect,
  type DefaultPaint,
} from "../../lib/annotate/types";
import {
  useImageEditorUi,
  type Mode,
  type Tool,
} from "../../stores/imageEditor";
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

import { copyText } from "../../lib/clipboard";
import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import {
  clampScale,
  IDENTITY_VIEW,
  WHEEL_STEP,
  zoomAt,
  zoomTo,
  type View,
} from "../../lib/zoom";
import { useSaveImage } from "../../queries";
import { useUi } from "../../stores/ui";
import AnnotationLayer, {
  type AnnotationLayerHandle,
} from "./AnnotationLayer";
import { newImageNode } from "./annotation/draft";
import EditorStatusBar, { type StatusBarHandle } from "./EditorStatusBar";
import EditorTitleBar from "./EditorTitleBar";
import { LeftPanel } from "./LeftPanel";
import ToolRail, { type ToolRailHandle } from "./ToolRail";
import { Inspector } from "./inspector/Inspector";
import { PropsLegacy, TextLegacy } from "./inspector/PropsLegacy";
import { useEditorKeys } from "./useEditorKeys";

// 프리뷰 백킹 스토어 상한 — 거대 이미지를 전체 해상도로 그리면 메모리 폭증 + Chromium 캔버스
// 한계(빈 화면)에 걸린다. 프리뷰는 이 한도로 다운스케일하고, 크롭 좌표는 항상 oriented px 기준.
const MAX_PREVIEW = 1800;
// 출력 캔버스 한 변 상한(Chromium 캔버스 한계 가드) — 초과 시 인코딩 전에 명확히 실패시킨다.
const MAX_OUTPUT_DIM = 16384;

/**
 * 객체 복사·붙여넣기의 클립보드 접두(42 §3.4). **텍스트로** 나가야 doc 창과 메인 창처럼
 * JS 컨텍스트가 갈린 두 창 사이에서도 붙는다 — 메모리에 든 노드는 서로 못 본다.
 * 접두가 없으면 붙여넣기 쪽이 남의 텍스트를 우리 문서로 오인해 파싱한다.
 */
const CLIP_PREFIX = "gpv-anno:";
// 입력 화소수 상한. 8K(33MP)는 통과시키고 초대형 스캔본을 막는 선 — 편집기 하나가 이미지
// 한 장을 두고 디코드·oriented·프리뷰 3장·저장 캔버스를 동시에 들기 때문이다(설계 §6.3).
const MAX_INPUT_PIXELS = 100_000_000;
/** 최근 사용 색 기억 개수(세션 한정). */
const RECENT_COLORS = 6;

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

  // ── 편집 문서(히스토리 스냅샷 단위, §5.1) ──
  const [doc, setDoc] = useState<EditorDoc>(EMPTY_DOC);
  const docRef = useRef(doc);
  docRef.current = doc;
  const histRef = useRef<DocHistory>(new DocHistory(EMPTY_DOC));
  // canUndo/canRedo 는 클래스 내부 상태라 리렌더 트리거가 따로 필요하다.
  const [histVer, setHistVer] = useState(0);

  /**
   * 편집 문서 영속(41). 커밋마다 1초 디바운스로 앱 데이터 사이드카에 쓰고, 열 때 되살린다.
   * 훅이 매 렌더 새 객체를 주므로 ref 로 미러해 effect·콜백이 최신 것을 보게 한다.
   */
  const persist = useImageDocPersist(editorRepoId ?? null, path ?? null, histRef, {
    imageStamp: stampRef.current,
    imageW: img?.naturalWidth ?? 0,
    imageH: img?.naturalHeight ?? 0,
  });
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // 이미지 페인트 디코드 캐시. `doc.assets` 참조를 키로 하는 WeakMap 위에 얹혀 있어
  // 여러 번 만들어도 같은 캐시를 본다(39 §3.6) — 참조만 안정시켜 재렌더를 줄인다.
  const store = useMemo(() => imageStore(doc), [doc]);
  const storeRef = useRef(store);
  storeRef.current = store;
  /** 디코드가 끝날 때마다 오른다 — 커밋 캐시를 한 번 무효화해 진짜 그림이 나오게 한다. */
  const [assetsVer, setAssetsVer] = useState(0);
  useEffect(() => {
    let alive = true;
    void ensureAssets(doc).then(() => {
      if (alive) setAssetsVer((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [doc.assets]);

  // ── 문서 밖 UI 상태 ──
  //
  // 도구·모드·선택은 **창별 스토어**가 갖는다(42 §3.1). 레이어 패널(44)·컨텍스트 바(45)·
  // 상태바가 같은 값을 봐야 하는데, 로컬 state 로 두면 prop 이 4단이 되고 호버(초당 60회)가
  // 이 1,400줄 컴포넌트를 통째로 리렌더한다. 아래 이름들은 종전 그대로라 사용처는 무변경이다.
  const tool = useImageEditorUi((s) => s.tool);
  const mode = useImageEditorUi((s) => s.mode);
  const setTool = useImageEditorUi((s) => s.setTool);
  const setMode = useImageEditorUi((s) => s.setMode);
  const uiSelect = useImageEditorUi((s) => s.select);
  const uiReset = useImageEditorUi((s) => s.reset);
  const setTextEditing = useImageEditorUi((s) => s.setTextEditing);
  const rawSelectedIds = useImageEditorUi((s) => s.selectedIds);
  /** `'__base'`(이미지 배경 의사 id)는 노드가 아니다 — 기하·페인트 경로에 흘리지 않는다. */
  const selectedIds = useMemo(
    () => rawSelectedIds.filter((id): id is ObjId => id !== "__base"),
    [rawSelectedIds],
  );
  const setSelectedIds = useCallback((ids: ObjId[]) => uiSelect(ids), [uiSelect]);
  const cropMode = mode.kind === "crop";
  const setCropMode = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      const next =
        typeof v === "function"
          ? v(useImageEditorUi.getState().mode.kind === "crop")
          : v;
      setMode(next ? { kind: "crop" } : { kind: "design" });
    },
    [setMode],
  );

  const [lockRatio, setLockRatio] = useState(true);
  const [format, setFormat] = useState<ImgFormat>("png");
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const [style, setStyle] = useState<DefaultPaint>(DEFAULT_PAINT);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [recent, setRecent] = useState<string[]>([]);

  /**
   * 화면 확대·이동. **CSS transform 으로만** 건다 — 프리뷰 백킹(previewScale/backW/backH)은
   * 절대 따라 키우지 않는다. 백킹을 건드리면 주석 캐시 키가 배율을 물고 있어(AnnotationLayer)
   * 휠 노치마다 전량 재렌더가 돌고, "oriented px == 백킹 px" 를 전제로 한 좌표가 전부 어긋난다.
   */
  const [view, setView] = useState<View>(IDENTITY_VIEW);

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 변환이 걸리지 않은 레이아웃 앵커 — 줌 수식의 기준 프레임(rect 가 view 에 흔들리지 않는다). */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<AnnotationLayerHandle | null>(null);
  const railRef = useRef<ToolRailHandle | null>(null);
  const statusRef = useRef<StatusBarHandle | null>(null);
  /**
   * 편집기 루트(`role="application"`). 포커스가 여기 있어야 Space 가 손 도구가 된다 —
   * 방금 누른 버튼에 남으면 Space 가 그 버튼을 다시 누르고, 아무 데도 없으면 뒤에 있는
   * 터미널 textarea 로 흘러간다(42 §3.3).
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusRoot = useCallback(() => rootRef.current?.focus(), []);
  useEffect(() => {
    rootRef.current?.focus();
  }, [path]);

  // ── 문서 갱신 ──────────────────────────────────────────────────────────────

  /**
   * 문서를 갱신한다. `mode:"commit"` 은 히스토리 스냅샷을 남기고, `"replace"` 는 남기지 않는다
   * (드래그 중 라이브 갱신). React 18+ StrictMode 가 업데이터를 두 번 부를 수 있으므로
   * 히스토리 조작은 setState 업데이터 **밖**에서 한다.
   */
  const applyDoc = useCallback(
    (next: EditorDoc, mode: "commit" | "replace" = "commit", label?: string) => {
      // 트리 불변식은 **커밋 경로 한 곳**에서 본다 — objects 를 직접 splice 한 코드가 있으면
      // 여기서 즉시 터진다(태스크 38 §3.1). DEV 전용이라 배포 빌드에는 없다.
      if (import.meta.env.DEV) assertTreeInvariant(next.objects);
      docRef.current = next;
      if (mode === "commit") {
        histRef.current.commit(next, label);
        // 커밋 = 사용자가 "한 일" 하나 — 여기서만 자동저장을 예약한다(드래그 중 틱은 replace).
        persistRef.current?.markDirty();
      } else {
        histRef.current.replace(next);
      }
      setDoc(next);
      setHistVer((v) => v + 1);
    },
    [],
  );

  /**
   * e2e 훅이 읽는 최신 값 미러 — 훅 effect 의 의존성을 늘리지 않으려고 ref 로 둔다
   * (의존성에 넣으면 조정 슬라이더 틱마다 훅이 재설치된다).
   */
  const orientedRef = useRef<HTMLCanvasElement | null>(null);
  const filterStrRef = useRef("none");

  /** 사이드카 복원 뒤 원본이 바뀌어 있었는가 — 배너로 한 번 알린다. */
  const [imageChanged, setImageChanged] = useState(false);

  /** 숨김·잠금·마스크가 풀린 씬. 렌더·히트·선택이 전부 이걸 본다(38 §3.2). */
  const scene = useMemo(() => resolveScene(doc), [doc]);

  /** 상태바 `W × H`·"선택 맞춤" 줌이 함께 쓰는 선택 상자(38 `selectBox`). */
  const selBox = useMemo(
    () => (selectedIds.length ? selectBox(scene, selectedIds).rect : null),
    [scene, selectedIds],
  );

  const patchDoc = useCallback(
    (patch: Partial<EditorDoc>, mode: "commit" | "replace" = "commit", label?: string) =>
      applyDoc({ ...docRef.current, ...patch }, mode, label),
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
    uiReset();

    // 사이드카에 저장해 둔 편집 문서를 **자동으로** 되살린다(41 §3.3). v1 은 창 수명 stash 에
    // 넣고 배너로 물었는데, 그건 창을 닫으면 사라지는 임시 보관이었다. 이제 파일로 남으므로
    // 물어볼 이유가 없다 — 닫아도 잃는 것이 없다.
    let alive = true;
    void (async () => {
      const restored = await persistRef.current
        ?.load(stampRef.current, img.naturalWidth, img.naturalHeight)
        .catch(() => null);
      if (!alive || !restored) return;
      const next = restored.imageChanged
        ? // 원본이 바뀌었으면 크롭·출력 크기는 새 이미지 기준으로 되돌린다 — 낡은 crop 으로
          // 저장하면 엉뚱한 영역이 잘려 나간다(조용한 데이터 손실).
          { ...restored.doc, crop: null, outW: img.naturalWidth, outH: img.naturalHeight }
        : restored.doc;
      docRef.current = next;
      histRef.current.reset(next, "이미지 열기", restored.log);
      setDoc(next);
      setHistVer((v) => v + 1);
      setImageChanged(restored.imageChanged);
      // 되돌린 crop 을 사이드카에도 반영한다 — 저장하지 않으면 열 때마다 같은 배너가 뜬다.
      if (restored.imageChanged) persistRef.current?.markDirty();
    })();
    return () => {
      alive = false;
    };
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

  // 팬은 **가운데 버튼 드래그**, 그리고 **손 도구의 좌드래그**다(42 §3.5 `button===1 || hand`).
  // 평소 좌버튼은 주석 레이어가 그리기·선택·이동·리사이즈·크롭에 전부 쓰지만, 손 도구일 때는
  // 레이어가 pointerdown 을 캡처도 처리도 하지 않고 버블시킨다(`annotation/pointer.ts`) —
  // 여기서 `button===1` 만 보면 그 이벤트가 조용히 버려져 손 도구·Space 홀드가 한 픽셀도
  // 움직이지 않는다(커서만 grab 이라 잡히는 것처럼 보인다).
  // 크롭은 모드가 도구를 이기므로(§3.2) 그때 좌버튼은 크롭 사각형 것이다.
  const panFrom = useRef<{ x: number; y: number } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    const byHand = e.button === 0 && tool === "hand" && !cropMode;
    if (e.button !== 1 && !byHand) return;
    e.preventDefault(); // 가운데 버튼 오토스크롤 · 손 드래그 중 텍스트 선택 차단
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

  orientedRef.current = oriented ?? null;
  filterStrRef.current = filterStr;

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
    const sw = d.crop ? d.crop.w : base.width;
    const sh = d.crop ? d.crop.h : base.height;
    const outW = Math.max(1, Math.round(d.outW || sw));
    const outH = Math.max(1, Math.round(d.outH || sh));
    if (outW > MAX_OUTPUT_DIM || outH > MAX_OUTPUT_DIM) {
      throw new Error(`출력 크기가 너무 큽니다 (한 변 ${MAX_OUTPUT_DIM}px 초과)`);
    }
    // 이미지·조정·주석이 **프리뷰와 같은 renderScene** 을 지난다. 큰 출력은 타일로 그려
    // 작업 메모리가 출력 크기에 비례해 늘지 않는다(태스크 40 §3.3).
    // jpeg/avif 등 비투명 포맷은 흰 바탕을 배경으로 준다(투명이 검게 나오지 않게).
    return renderOutputTiled(resolveScene(d), {
      crop: d.crop,
      outW,
      outH,
      background: opaqueBg ? "#ffffff" : "image",
      filter: filterStr,
      image: base,
      store: storeRef.current,
    });
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
    // 에셋 디코드를 먼저 끝낸다 — 안 그러면 회색 자리가 저장 파일에 그대로 굳는다(39 §3.6).
    void ensureAssets(docRef.current)
      .then(() => encodeCanvas(renderOutput(), format, quality))
      .then((bytes) => {
        const base64 = bytesToBase64(bytes);
        saveImage.mutate(
          { relPath, base64, overwrite, expectedStamp: stamp },
          {
            onSuccess: () => {
              // 열어 둔 **그 파일**에 구웠을 때만 편집 문서를 버린다 — 레이어가 이미지에
              // 들어갔으므로 다시 열 때 복원하면 주석이 두 겹이 된다. '다른 이름으로'는
              // 원본이 한 바이트도 안 바뀌었으니 문서를 살려 둔다(41 §3.3 R8).
              if (projectId && path && relPath === path) {
                void persistRef.current?.deleteDoc();
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
        title: "레이어를 이미지에 굽기",
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
    void ensureAssets(docRef.current)
      .then(() => encodeCanvas(renderOutput(false), "png"))
      .then((bytes) => writeImage(bytes))
      .then(() => pushToast("success", "클립보드에 복사됨 (PNG)"))
      .catch((e) => pushToast("error", errorMessage(e)))
      .finally(() => setBusy(false));
  };

  /**
   * 레일 '이미지' — 파일을 골라 캔버스 가운데에 놓는다(42 §3.5 · §3.4 "레일 클릭이 대신").
   *
   * 도구 상태로 남지 않는 **한 번의 동작**이다: `setTool('image')` 로 두면 그 뒤 캔버스
   * 클릭·드래그가 전부 조용한 no-op 이 된다(드래프트를 만들 수 있는 도구가 아니다).
   * 취소하면 `assetPickFile` 이 null 이라 문서를 건드리지 않는다 — 빈 히스토리 항목이 남으면
   * Ctrl+Z 가 아무 일도 안 하는 것처럼 보인다.
   */
  const placeImage = useCallback(() => {
    void (async () => {
      try {
        const picked = await ipc.assetPickFile();
        if (!picked) return;
        const d = docRef.current;
        const got = await acquireAsset(d, picked);
        // 원본 크기로 놓되 캔버스를 넘으면 줄인다 — 20MP 스크린샷을 200px 그림 위에 원본
        // 크기로 놓으면 화면 어디에도 안 보인다(붙여넣기와 같은 규칙).
        const fit = Math.min(1, d.outW / got.w, d.outH / got.h);
        const w = Math.max(1, Math.round(got.w * fit));
        const h = Math.max(1, Math.round(got.h * fit));
        const node = newImageNode({
          x: Math.round((d.outW - w) / 2),
          y: Math.round((d.outH - h) / 2),
          w,
          h,
          assetId: got.id,
          opacity,
        });
        applyDoc(
          { ...d, assets: got.assets, objects: [...d.objects, node] },
          "commit",
          "이미지 배치",
        );
        setSelectedIds([node.id]);
      } catch (err) {
        pushToast("error", errorMessage(err));
      }
    })();
  }, [applyDoc, opacity, pushToast, setSelectedIds]);

  // ── 닫기 · Esc 계층(§5.4) ─────────────────────────────────────────────────


  /**
   * 닫기 — 확인하지 않는다. 편집 문서는 사이드카에 남고 다음에 열 때 그대로 돌아온다.
   * 저장에 실패했을 때만(충돌·IO) 물어본다 — 그때는 진짜로 잃을 수 있기 때문이다.
   */
  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    void (async () => {
      await persistRef.current?.flush();
      if (persistRef.current?.state === "error") {
        askConfirm({
          title: "편집 문서를 저장하지 못했습니다",
          message:
            "이 창의 편집 내용을 파일로 남기지 못했습니다. 그래도 닫으면 마지막 저장 이후 변경분을 잃습니다.",
          confirmLabel: "그래도 닫기",
          danger: true,
          onConfirm: close,
        });
        return;
      }
      close();
    })();
  }, [askConfirm, close]);

  /**
   * doc 창의 X(FloatTitleBar → `win.close()`)는 편집기의 닫기 가드를 지나지 않는다 —
   * 창이 그냥 사라진다. 이제 잃을 것은 "마지막 디바운스가 아직 안 쓴 변경분"뿐이므로,
   * **확인 대신 flush** 한다. 저장에 실패했을 때만 물어본다.
   *
   * `destroy()` 를 부르는 이유: `close()` 는 CloseRequested 를 다시 발화시켜 무한 루프가 된다.
   * Rust 쪽 CloseRequested 핸들러는 `main` 라벨만 다루므로 간섭 없다.
   */
  useEffect(() => {
    if (!IS_DOC_WINDOW) return;
    const win = getCurrentWebviewWindow();
    let off: (() => void) | undefined;
    let dead = false;
    void win
      .onCloseRequested((e) => {
        const p = persistRef.current;
        if (!p || p.state === "clean") return;
        e.preventDefault();
        void (async () => {
          await p.flush();
          if (persistRef.current?.state === "error") {
            askConfirm({
              title: "편집 문서를 저장하지 못했습니다",
              message:
                "이 창의 편집 내용을 파일로 남기지 못했습니다. 그래도 닫으면 마지막 저장 이후 변경분을 잃습니다.",
              confirmLabel: "그래도 닫기",
              danger: true,
              onConfirm: () => void win.destroy(),
            });
            return;
          }
          void win.destroy();
        })();
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

  // 붙여넣기 한 곳 — 객체(`gpv-anno:` 텍스트, 42 §3.4)와 이미지 파일(→ 에셋 + 이미지 채우기
  // 사각형, 41 §3.5)을 함께 받는다. Ctrl+V 는 단축키 표에 **없다**: 브라우저가 만드는 paste
  // 이벤트 하나가 같은 창·창 간 붙여넣기를 다 처리한다.
  // 상한 검사는 annotate/assets.ts 한 곳에만 있다 — 세 획득 경로가 각자 세면 언젠가
  // 한 곳이 빠지고, 그 경로로 들어온 파일이 사이드카 32MB 상한에서 저장을 통째로 막는다.
  useEffect(() => {
    /**
     * `gpv-anno:` 텍스트를 노드로 되돌린다. 규칙 셋이 전부 필수다:
     * **새 id**(같은 id 를 넣으면 트리 불변식이 즉시 터진다), **8px 오프셋**(없으면 원본에
     * 정확히 겹쳐 붙여넣기가 안 된 것처럼 보인다), **`parentId` 버리기**(복사원의 그룹은
     * 이 문서에 없어 부모가 앞에 없는 노드가 된다).
     * 남이 만든 문자열일 수 있으므로 경계는 `normalizeNode` 하나다.
     */
    const pasteNodes = (text: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text.slice(CLIP_PREFIX.length));
      } catch {
        return;
      }
      if (!Array.isArray(raw)) return;
      const added: Node[] = [];
      for (const item of raw) {
        const n = normalizeNode(item);
        if (!n) continue;
        const moved = isGeomNode(n)
          ? translateObject(n, DUPLICATE_OFFSET, DUPLICATE_OFFSET)
          : n;
        added.push({ ...moved, id: newObjId(), parentId: null });
      }
      if (!added.length) return;
      applyDoc(
        { ...docRef.current, objects: [...docRef.current.objects, ...added] },
        "commit",
        "붙여넣기",
      );
      setSelectedIds(added.map((o) => o.id));
    };

    const onPaste = (e: ClipboardEvent) => {
      const ui = useUi.getState();
      if (ui.prompt || ui.confirm) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return; // 텍스트 편집 중에는 글자가 붙어야 한다
      }
      // preventDefault 는 **여기서** 불러야 한다 — await 를 하나라도 지나면 이벤트가 이미
      // 끝나 기본 붙여넣기가 그대로 나간다.
      //
      // 객체 붙여넣기(§3.4)를 파일보다 **먼저** 본다: 우리가 복사한 노드도 클립보드에
      // 그림 파일이 함께 실려 오는 환경이 있어, 순서가 반대면 벡터가 비트맵으로 붙는다.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.startsWith(CLIP_PREFIX)) {
        e.preventDefault();
        pasteNodes(text);
        return;
      }
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      );
      if (!file) return;
      e.preventDefault();
      void (async () => {
        const doc = docRef.current;
        try {
          const got = await acquireFromFile(doc, file);
          // 이미지 밖으로 튀어나오지 않게 자연 크기를 캔버스 안에 맞춘다 — 20MP 스크린샷이
          // 200px 이미지 위에 붙으면 화면 어디에도 안 보인다.
          const fit = Math.min(1, doc.outW / got.w, doc.outH / got.h);
          const w = Math.max(1, Math.round(got.w * fit));
          const h = Math.max(1, Math.round(got.h * fit));
          const node = normalizeNode({
            id: newObjId(),
            kind: "rect",
            x: Math.round((doc.outW - w) / 2),
            y: Math.round((doc.outH - h) / 2),
            w,
            h,
            strokeWidth: 0,
            // Fill 은 flat 이다(Paint & {visible, blend}) — {paint:…} 로 감싸면 정규화가
            // type 을 못 찾아 solid 로 떨어진다.
            fills: [{ type: "image", assetId: got.id, mode: "fill", visible: true }],
          });
          if (!node) return;
          applyDoc(
            { ...doc, assets: got.assets, objects: [...doc.objects, node] },
            "commit",
            "이미지 붙여넣기",
          );
          setSelectedIds([node.id]);
        } catch (err) {
          pushToast("error", errorMessage(err));
        }
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [applyDoc, pushToast, setSelectedIds]);

  // ── 단축키 ────────────────────────────────────────────────────────────────
  //
  // 리스너는 `useEditorKeys` 하나뿐이다(window **capture**). 다른 태스크는 표(shortcuts.ts)에
  // 행을 넣고 이 맵에 핸들러를 더한다 — 리스너를 새로 달지 않는다. 여기 없는 id 는
  // `preventDefault` 도 안 되므로 앱 전역으로 그대로 흘러간다(먹통 키가 생기지 않는다).
  const selIds = () => useImageEditorUi.getState().selectedIds as ObjId[];

  /**
   * 선택 노드를 OS 클립보드에 텍스트로 쓴다. 복사한 개수를 돌려준다 — 잘라내기가 그 값으로
   * "지울 것이 있었나"를 판단한다. 자손은 담지 않는다(`duplicate` 와 같은 범위 — 컨테이너
   * 통째 복제는 44 몫이다).
   */
  const copySel = () => {
    const ids = new Set(selIds());
    const nodes = docRef.current.objects.filter((o) => ids.has(o.id));
    if (nodes.length) void copyText(CLIP_PREFIX + JSON.stringify(nodes));
    return nodes.length;
  };

  /** 보기 토글 뒤집기. 스토어에서 직접 읽는다 — 액션 맵은 리렌더 없이 최신 값을 봐야 한다. */
  const flipToggle = (k: "rulers" | "pixelGrid" | "snapPixel") => {
    const u = useImageEditorUi.getState();
    u.setToggle(k, !u.toggles[k]);
  };

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const ids = new Set(selIds());
      if (!ids.size) return;
      patchDoc(
        {
          objects: docRef.current.objects.map((o) =>
            ids.has(o.id) && isGeomNode(o) ? translateObject(o, dx, dy) : o,
          ),
        },
        "commit",
        "이동",
      );
    },
    [patchDoc],
  );

  const reorderSel = useCallback(
    (dir: 1 | -1 | "front" | "back") => {
      const ids = selIds();
      if (!ids.length) return;
      patchDoc(
        { objects: treeReorder(docRef.current.objects, ids, dir) },
        "commit",
        dir === 1 ? "앞으로" : dir === -1 ? "뒤로" : dir === "front" ? "맨 앞" : "맨 뒤",
      );
    },
    [patchDoc],
  );

  const zoomBy = useCallback((factor: number) => {
    const el = stageRef.current;
    // 키 줌은 **스테이지 중심** 기준이다(휠만 커서 기준) — 포인터가 어디 있든 화면이 튀지 않아야 한다.
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    setView((v) => zoomAt(v, cx, cy, factor));
  }, []);

  /** 모드 종료(크롭 적용·노드 편집 완료) — 크롭 사각형은 문서에 남는다(§3.2). */
  const leaveMode = useCallback(() => {
    setMode({ kind: "design" });
    layerRef.current?.setCropPreview(null);
  }, [setMode]);

  /**
   * 줌 드롭다운(타이틀바). 넘어오는 숫자는 **화면 배율**이라 transform 배율로 바꾸려면
   * 맞춤 배율을 나눠야 한다(100% = `1/displayScale`). 기준점은 키 줌과 같은 스테이지 중심이다.
   */
  const zoomPreset = useCallback(
    (target: number | "fit" | "selection") => {
      const el = stageRef.current;
      if (target === "fit") {
        setView(IDENTITY_VIEW);
        return;
      }
      if (target === "selection") {
        if (!el || !selectedIds.length) return;
        const { rect } = selectBox(scene, selectedIds);
        if (rect.w <= 0 || rect.h <= 0) return;
        const s = clampScale(
          Math.min(
            (el.clientWidth * 0.8) / (rect.w * displayScale),
            (el.clientHeight * 0.8) / (rect.h * displayScale),
          ),
        );
        // 앵커 박스(dispW×dispH)는 스테이지 한가운데 놓이므로 박스 중심 = 화면 중심이다.
        // transform-origin 이 0 0 이라 중심 맞추기가 이 한 줄로 끝난다.
        setView({
          scale: s,
          x: dispW / 2 - (rect.x + rect.w / 2) * displayScale * s,
          y: dispH / 2 - (rect.y + rect.h / 2) * displayScale * s,
        });
        return;
      }
      const cx = el ? el.clientWidth / 2 : 0;
      const cy = el ? el.clientHeight / 2 : 0;
      setView((v) => zoomTo(v, cx, cy, target / displayScale));
    },
    [dispH, dispW, displayScale, scene, selectedIds],
  );

  const escape = useCallback(() => {
    if (busyRef.current) return;
    // 0) 레일 플라이아웃이 열려 있으면 그것부터 닫는다.
    if (railRef.current?.closeFlyout()) return;
    // 2~5) 텍스트 확정 → 드래프트 취소 → select 복귀 → 선택 해제
    if (layerRef.current?.handleEscape()) return;
    // 6) 크롭·노드 편집 종료(동급)
    if (useImageEditorUi.getState().mode.kind !== "design") {
      leaveMode();
      return;
    }
    // 7) 닫기 — 41 이후 확인창은 없다(문서가 사이드카에 남으므로).
    requestClose();
  }, [leaveMode, requestClose]);

  useEditorKeys(
    {
      "tool.select": () => setTool("select"),
      "tool.scale": () => setTool("scale"),
      "tool.frame": () => setTool("frame"),
      "tool.eraser": () => setTool("eraser"),
      "tool.pen": () => setTool("pen"),
      "tool.highlight": () => setTool("highlight"),
      "tool.rect": () => setTool("rect"),
      "tool.ellipse": () => setTool("ellipse"),
      "tool.line": () => setTool("line"),
      "tool.arrow": () => setTool("arrow"),
      "tool.text": () => setTool("text"),
      "tool.badge": () => setTool("badge"),
      "tool.mosaic": () => setTool("mosaic"),
      "mode.crop": () => setCropMode(true),
      // 홀드 도구 — 액션 하나가 누름/뗌을 모두 받는다(useEditorKeys 주석 참고).
      hand: (e) =>
        e.type === "keyup"
          ? useImageEditorUi.getState().restoreTool()
          : setTool("hand", { temporary: true }),

      undo: () => undo(),
      redo: () => redo(),
      esc: () => escape(),
      // Enter 는 **모드가 있을 때만** 맵에 넣는다. 항상 넣으면 design 모드의 Enter 까지
      // 소비해 포커스된 버튼이 Enter 로 눌리지 않는다 — design 의 Enter(텍스트 편집 진입·
      // 그룹 진입·노드 편집 진입)는 44·47·50 것이다.
      ...(mode.kind === "design" ? {} : { enter: () => leaveMode() }),

      duplicate: () => {
        const ids = selIds();
        const copies: Node[] = [];
        for (const o of docRef.current.objects) {
          if (!ids.includes(o.id)) continue;
          // 컨테이너는 기하가 없다 — 자손째 복제는 레이어 패널(44)이 붙인다.
          copies.push(
            isGeomNode(o)
              ? {
                  ...translateObject(o, DUPLICATE_OFFSET, DUPLICATE_OFFSET),
                  id: newObjId(),
                }
              : { ...o, id: newObjId() },
          );
        }
        if (!copies.length) return;
        patchDoc(
          { objects: [...docRef.current.objects, ...copies] },
          "commit",
          copies.length === 1 ? "복제" : copies.length + "개 복제",
        );
        setSelectedIds(copies.map((o) => o.id));
      },
      delete: () => {
        const ids = selIds();
        if (!ids.length) return;
        patchDoc({ objects: treeRemove(docRef.current.objects, ids) }, "commit", "삭제");
        setSelectedIds([]);
      },
      // 복사·잘라내기는 **표에 있어야** 한다. 맵에 없으면 Ctrl+C 가 그대로 앱으로 흘러
      // `terminal.ts` 의 폴백이 뒤에 있는 터미널 선택을 대신 복사한다(§3.3 출처표).
      copy: () => void copySel(),
      cut: () => {
        const ids = selIds();
        if (!copySel()) return;
        patchDoc(
          { objects: treeRemove(docRef.current.objects, ids) },
          "commit",
          "잘라내기",
        );
        setSelectedIds([]);
      },
      copyPng: () => copyToClipboard(),
      selectAll: () => {
        // 잠긴 노드는 클릭으로 고를 수 없다 — Ctrl+A 로만 잡히면 그다음 조작 결과가
        // 화면에서 본 것과 어긋난다. 씬이 유일한 판정이다(38).
        const sc = resolveScene(docRef.current);
        setSelectedIds(
          sc.nodes.map((n) => n.id).filter((id) => !sc.flags.get(id)?.locked),
        );
      },
      // 표는 방향 넷을 한 행으로 묶는다 — 여기서 방향을 읽는다.
      // auto-repeat 를 무시하는 것은 K5 다: 초당 ~30 커밋이면 히스토리 200칸이 7초에
      // 소진돼 그 앞의 기록이 통째로 날아간다.
      nudge: (e) => {
        if (e.repeat) return;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx || dy) nudge(dx, dy);
      },

      group: () => {
        const ids = selIds();
        if (ids.length < 2) return;
        const r = treeGroup(docRef.current.objects, ids, "group");
        patchDoc({ objects: r.objects }, "commit", "그룹");
        setSelectedIds([r.id]);
      },
      ungroup: () => {
        const ids = selIds();
        if (ids.length !== 1) return;
        patchDoc(
          { objects: treeUngroup(docRef.current.objects, ids[0]) },
          "commit",
          "그룹 해제",
        );
      },
      // 그룹과 같은 연산이고 컨테이너 kind 만 다르다(38 `tree.group`) — 프레임은 내용을 자른다.
      frame: () => {
        const ids = selIds();
        if (!ids.length) return;
        const r = treeGroup(docRef.current.objects, ids, "frame");
        if (!r.id) return;
        patchDoc({ objects: r.objects }, "commit", "프레임으로 감싸기");
        setSelectedIds([r.id]);
      },
      mask: () => {
        const ids = selIds();
        if (ids.length < 2) return;
        const r = treeMakeMask(docRef.current.objects, ids);
        patchDoc({ objects: r.objects }, "commit", "마스크");
      },
      forward: () => reorderSel(1),
      backward: () => reorderSel(-1),
      front: () => reorderSel("front"),
      back: () => reorderSel("back"),

      "zoom.in": () => zoomBy(WHEEL_STEP * WHEEL_STEP),
      "zoom.out": () => zoomBy(1 / (WHEEL_STEP * WHEEL_STEP)),
      "zoom.100": () => {
        const el = stageRef.current;
        setView((v) =>
          zoomTo(
            v,
            el ? el.clientWidth / 2 : 0,
            el ? el.clientHeight / 2 : 0,
            1 / displayScale,
          ),
        );
      },
      "zoom.fit": () => setView(IDENTITY_VIEW),
      "zoom.sel": () => zoomPreset("selection"),

      // 43 이 실제 눈금자·그리드를 그리기 전에도 **값은 여기서** 뒤집는다 — 표에 있는데
      // 맵에 없으면 Shift+R·Ctrl+' 이 앱 전역으로 새고(먹통), 상태바 토글과 키가 갈린다.
      "view.rulers": () => flipToggle("rulers"),
      "view.pixelGrid": () => flipToggle("pixelGrid"),
      "view.snapPixel": () => flipToggle("snapPixel"),
      // 0↔1 만 오간다(§3.4) — 45 가 넣는 2x 는 조정 탭이 정한다.
      "view.pixelPreview": () => {
        const u = useImageEditorUi.getState();
        u.setPixelPreview(u.pixelPreview === 0 ? 1 : 0);
      },

      "file.save": () => void persistRef.current?.flush(),
      "file.saveAs": () => saveAs(),
      "file.close": () => requestClose(),
    },
    {
      popoverOpen: () => railRef.current?.isFlyoutOpen() ?? false,
      blocked: () => {
        const ui = useUi.getState();
        return !!(ui.prompt || ui.confirm);
      },
      context: () => {
        const u = useImageEditorUi.getState();
        const ids = new Set(u.selectedIds);
        const kinds = new Set<Node["kind"]>();
        for (const o of docRef.current.objects) if (ids.has(o.id)) kinds.add(o.kind);
        return {
          mode: u.mode,
          sel: u.selectedIds.length,
          selKinds: kinds,
          textEditing: u.textEditing,
        };
      },
    },
  );

  // ── E2E 훅(§9.4) — DEV 빌드에서만 노출 ────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const g = window as unknown as { __gpv?: Record<string, unknown> };
    g.__gpv = g.__gpv ?? {};
    g.__gpv.imageDocs = {
      read: (pid: string, rel: string) => ipc.imageDocRead(pid, rel, "doc"),
      delete: (pid: string, rel: string) => ipc.imageDocDelete(pid, rel),
    };
    g.__gpv.imageEditor = {
      getDoc: () => docRef.current,
      // setDoc 은 **경계**다 — v1 리터럴이든 부분 문서든 여기서 완전한 v2 문서가 된다(37 §3.3).
      // 그래서 30·34·35 의 setDoc 리터럴 21건이 재작성 없이 산다.
      setDoc: (patch: Partial<EditorDoc>) =>
        patchDoc(normalizeDoc({ ...docRef.current, ...patch })),
      setTool: (t: Tool) => setTool(t),
      /** 셸 상태 한 벌(42 §4) — 레일·상태바·패널이 같은 값을 보는지 확인하는 근거. */
      getUi: () => {
        const u = useImageEditorUi.getState();
        return {
          tool: u.tool,
          mode: u.mode,
          pixelPreview: u.pixelPreview,
          selectedIds: u.selectedIds,
          hoverId: u.hoverId,
          toggles: u.toggles,
        };
      },
      setMode: (m: Mode) => setMode(m),
      /**
       * 표 판정만 떼어 본다 — 한글 IME(`key='ㅍ'`)·Mac ⌥(`key='å'`)에서도 물리 키로
       * 잡히는지를 두 플랫폼 모두 한 머신에서 확인하기 위한 훅이다.
       */
      matchShortcut: (init: KeyboardEventInit, platform?: "win" | "mac") => {
        const u = useImageEditorUi.getState();
        const ids = new Set(u.selectedIds);
        const kinds = new Set<Node["kind"]>();
        for (const o of docRef.current.objects) if (ids.has(o.id)) kinds.add(o.kind);
        return matchShortcut(
          init as KeyboardEvent,
          {
            mode: u.mode,
            sel: u.selectedIds.length,
            selKinds: kinds,
            textEditing: u.textEditing,
          },
          platform,
        );
      },
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
      /**
       * 창(win)만 렌더한 결과 — **윈도 불변** 검증용(40 §7 (d-2)). 서로 다른 두 창의 겹침
       * 픽셀이 달라지면 가림·효과가 창 경계에 의존한다는 뜻이다(클램프 사고).
       */
      renderRegion: (win: { x: number; y: number; w: number; h: number }, devScale: number) => {
        const img = orientedRef.current;
        if (!img) return null;
        const { ctx, work } = renderRegion(resolveScene(docRef.current), win, devScale, {
          image: img,
          background: "image",
          filter: filterStrRef.current,
          store: storeRef.current,
        });
        const x = Math.round((win.x - work.x) * devScale);
        const y = Math.round((win.y - work.y) * devScale);
        const w = Math.max(1, Math.round(win.w * devScale));
        const h = Math.max(1, Math.round(win.h * devScale));
        const d = ctx.getImageData(x, y, w, h).data;
        return { w, h, data: Array.from(d.slice(0, Math.min(d.length, 4 * 64))) };
      },
      /** 내보내기 배율 게이트·예상 용량의 단일 출처(40 §3.3). */
      estimate: (outW: number, outH: number) =>
        estimateRenderBytes(resolveScene(docRef.current), { outW, outH }),
      /** 히스토리 v2 — 라벨·커서·점프·스냅샷(41 §7). */
      history: {
        entries: () =>
          histRef.current.entries.map((e) => ({
            label: e.label,
            at: e.at,
            readonly: e.readonly,
          })),
        cursor: () => histRef.current.cursor,
        jumpTo: (i: number) => {
          const d = histRef.current.jumpTo(i);
          if (!d) return false;
          docRef.current = d;
          setDoc(d);
          setHistVer((v) => v + 1);
          persistRef.current?.markDirty();
          return true;
        },
        snapshot: (name: string) => persistRef.current?.saveSnapshot(name),
        listSnapshots: () => persistRef.current?.listSnapshots(),
        loadSnapshot: async (i: number) => {
          const d = await persistRef.current?.loadSnapshot(i);
          if (!d) return false;
          applyDoc(d, "commit", "스냅샷 복원");
          return true;
        },
        state: () => persistRef.current?.state ?? "clean",
        flush: () => persistRef.current?.flush(),
      },
      /** 씬 요약 — 숨김이 빠졌는지, 무엇이 잠겼는지, 컨테이너 범위가 맞는지(38 §7). */
      scene: () => {
        const sc = resolveScene(docRef.current);
        return {
          nodeIds: sc.nodes.map((n) => n.id),
          lockedIds: [...sc.flags.entries()].filter(([, f]) => f.locked).map(([id]) => id),
          containers: sc.containers.map((c) => ({ id: c.id, range: c.range })),
        };
      },
      /**
       * 트리 연산 — 패널·단축키(태스크 42·44)가 붙기 전에 연산 자체를 검증한다.
       * 전부 문서에 **커밋**하므로 히스토리·불변식 검사도 함께 지난다.
       */
      tree: {
        group: (ids: ObjId[], kind: "group" | "frame" = "group") => {
          const r = treeGroup(docRef.current.objects, ids, kind);
          patchDoc({ objects: r.objects });
          return r.id;
        },
        ungroup: (id: ObjId) => patchDoc({ objects: treeUngroup(docRef.current.objects, id) }),
        reorder: (ids: ObjId[], dir: 1 | -1 | "front" | "back") =>
          patchDoc({ objects: treeReorder(docRef.current.objects, ids, dir) }),
        reparent: (ids: ObjId[], parent: ObjId | null, index: number) =>
          patchDoc({ objects: treeReparent(docRef.current.objects, ids, parent, index) }),
        remove: (ids: ObjId[]) => patchDoc({ objects: treeRemove(docRef.current.objects, ids) }),
        makeMask: (ids: ObjId[]) => {
          const r = treeMakeMask(docRef.current.objects, ids);
          patchDoc({ objects: r.objects });
          return r.maskId;
        },
        maskScope: (maskId: ObjId) => treeMaskScope(docRef.current.objects, maskId),
        subtreeRange: (id: ObjId) => treeSubtreeRange(docRef.current.objects, id),
        nodeAABB: (id: ObjId) => treeNodeAABB(docRef.current.objects, id),
        translate: (ids: ObjId[], dx: number, dy: number) =>
          patchDoc({ objects: treeTranslate(docRef.current.objects, ids, dx, dy) }),
        rotate: (ids: ObjId[], deg: number, cx: number, cy: number) =>
          patchDoc({ objects: treeRotate(docRef.current.objects, ids, deg, { x: cx, y: cy }) }),
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
      delete g.__gpv?.imageDocs;
    };
  }, [patchDoc]);

  if (!path) return null;

  const warn = roundTripWarning(path);
  const canUndo = histRef.current.canUndo;
  const canRedo = histRef.current.canRedo;
  void histVer; // 히스토리 깊이 변화로 리렌더되게 하는 의존(값 자체는 쓰지 않는다)

  return (
    // 루트 클래스 `fixed inset-0 z-50` 는 **그대로 두어야 한다** — e2e 30·34·35 가 이 선택자로
    // 편집기를 잡는다(문구 대신 `aria-label` 로도 찾도록 헬퍼를 넓혔다). 카드는 없어졌고 창을
    // 통째로 쓴다. doc 창에서는 인라인 top 으로 FloatTitleBar(h-8 = 32px)를 비켜 준다 —
    // 덮으면 창을 옮기지도 닫지도 못한다. stage 재적합은 기존 ResizeObserver 가 한다.
    //
    // `role="application"` + `tabIndex={-1}`: 포커스가 루트에 있어야 Space 홀드가 손 도구가
    // 되고, 방향키·글자 키가 뒤의 앱으로 새지 않는다(§3.3).
    <div
      ref={rootRef}
      role="application"
      aria-label="이미지 편집"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel outline-none"
      style={IS_DOC_WINDOW ? { top: 32 } : undefined}
    >
      <EditorTitleBar
        projectId={projectId ?? null}
        path={path}
        dirty={persist.state !== "clean"}
        zoom={screenScale}
        onZoom={zoomPreset}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onClose={requestClose}
      />

      {warn && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-edge px-3 text-[11px] text-warn">
          <AlertTriangle size={12} className="shrink-0" />
          <span
            className="truncate"
            title="원본 포맷으로 되돌려 저장할 수 없습니다"
          >
            {warn}
          </span>
        </div>
      )}

      {/* 편집 문서는 자동으로 되살아난다(41 §3.3) — 물어볼 것이 없다. 대신 **원본이 바뀐**
          경우만 알린다: 그때는 크롭·출력 크기를 새 이미지 기준으로 되돌렸다는 뜻이다. */}
      {imageChanged && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px]">
          <FileWarning size={12} className="shrink-0 text-warn" />
          <span className="flex-1 truncate text-fg-muted">
            편집 문서를 저장한 뒤 원본 이미지가 바뀌었습니다 — 크롭과 출력 크기를 초기화했습니다.
          </span>
          <button
            type="button"
            onClick={() => setImageChanged(false)}
            className="shrink-0 rounded px-1.5 py-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            확인
          </button>
        </div>
      )}

      {/* 시안의 4열 — 레일 56 · 좌 패널 264 · 스테이지 · 인스펙터 320. 좌·우 폭은 각 패널이
          `usePanelWidth` 로 직접 들고 늘였다 줄이므로, 부모는 폭을 정하지 않는 flex 다. */}
      <div className="flex min-h-0 flex-1">
        <ToolRail
          onFocusRoot={focusRoot}
          paint={style}
          handleRef={railRef}
          onPlaceImage={placeImage}
        />
        <LeftPanel />

        {/* 프리뷰 — 이미지 위에 주석 캔버스를 겹친다(§4.3) */}
        <div
          ref={stageRef}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          className="checkerboard relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
        >
          {/* 모드 배너 — 지금 무엇이 Enter·Esc 를 받는지 알린다(§3.2). 포인터는 통과시킨다:
              스테이지 위에 떠 있어 클릭을 먹으면 그 자리에 그림을 못 그린다. */}
          {mode.kind !== "design" && (
            <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-edge bg-panel/90 px-2 py-1 text-[11px] text-fg-muted">
              {mode.kind === "crop"
                ? "크롭 모드 · ⏎ 적용 · Esc 취소"
                : "벡터 편집 모드 · Esc 로 편집 종료"}
            </div>
          )}
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
                {/* 이미지는 이제 **씬 캔버스**가 그린다(태스크 39 §3.1 병합) — 별도 베이스
                    캔버스도, CSS 필터도 없다. 조정은 renderScene 안에서 이미지에만 걸린다. */}
                <AnnotationLayer
                  ref={layerRef}
                  scene={scene}
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
                  store={store}
                  assetsVer={assetsVer}
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
                  onCommit={(objects, label) => patchDoc({ objects }, "commit", label)}
                  onEditingChange={setTextEditing}
                  onToolChange={setTool}
                  onSelectionChange={setSelectedIds}
                  statusRef={statusRef}
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* 인스펙터 — 탭 4개(속성·텍스트·조정·내보내기)와 시안 푸터. 내용은 v1 우측 패널의
            섹션을 **옮겨 담은 것**이다: 45 가 진짜 속성 필드를 만들 때까지 기능이 하나도
            없어지지 않게 한다. */}
        <Inspector
          panes={{
            props: (
              <PropsLegacy
                propTool={propTool}
                style={style}
                onStyleChange={onStyleChange}
                opacity={opacity}
                onOpacityChange={onOpacityChange}
                onEditEnd={endLive}
                recentColors={recent}
              />
            ),
            text: (
              <TextLegacy
                propTool={propTool}
                style={style}
                onStyleChange={onStyleChange}
                onEditEnd={endLive}
              />
            ),
            adjust: (
              <>
                <Section title="회전 · 반전">
                  <div className="grid grid-cols-4 gap-1.5">
                    <IconBtn title="왼쪽 90°" onClick={() => rotateBy(false)}>
                      <RotateCcw size={15} />
                    </IconBtn>
                    <IconBtn title="오른쪽 90°" onClick={() => rotateBy(true)}>
                      <RotateCw size={15} />
                    </IconBtn>
                    <IconBtn title="좌우 반전" active={flipH} onClick={() => flipBy("h")}>
                      <FlipHorizontal size={15} />
                    </IconBtn>
                    <IconBtn title="상하 반전" active={flipV} onClick={() => flipBy("v")}>
                      <FlipVertical size={15} />
                    </IconBtn>
                  </div>
                </Section>

                <Section title="크롭">
                  <div className="flex items-center gap-1.5">
                    {/* 두 라벨은 e2e 30 이 크롭 모드를 판정하는 근거다(`영역을 드래그`) —
                        문구를 바꾸면 그 스위트가 통째로 빨개진다. */}
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
              </>
            ),
            export: (
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
            ),
          }}
          footer={
            <>
              {/* `취소` 는 없다 — 타이틀바 X 가 닫기다(§3.8). */}
              <button
                onClick={resetAll}
                disabled={busy}
                className="mr-auto rounded px-2 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
              >
                초기화
              </button>
              <button
                onClick={copyToClipboard}
                disabled={busy || !img}
                title="편집 결과를 PNG로 클립보드에 복사"
                className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
              >
                <Copy size={14} /> 복사
              </button>
              <button
                onClick={saveAs}
                disabled={busy || !img}
                className="rounded border border-edge px-2 py-1.5 text-[13px] text-fg-muted hover:bg-raised disabled:opacity-50"
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
            </>
          }
        />
      </div>

      <EditorStatusBar
        ref={statusRef}
        zoomPercent={screenScale * 100}
        undoDepth={histRef.current.cursor}
        selectBox={selBox}
      />
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
