// 주석 오버레이 캔버스 — 포인터 상호작용·선택 핸들·텍스트 입력·커밋 레이어 캐시(설계 §4.3~4.4, §5.4~5.6).
//
// **상태 소유권**: 객체 배열과 히스토리는 ImageEditor 가 소유한다. 이 컴포넌트는 제어 컴포넌트로,
// 아직 커밋되지 않은 것(드래그 중인 드래프트, 이동/리사이즈 미리보기, 편집 중인 텍스트)만
// 내부에 들고 있다가 커밋 시점(§5.3)에 onCommit 으로 새 배열을 통째로 올려보낸다.
//
// 좌표계는 셋뿐이다:
//   oriented px  객체가 사는 정본 공간(§3)
//   backing px   = oriented × scale       캔버스 백킹 스토어(그리는 곳)
//   css px       = oriented × displayScale 화면에 보이는 크기(포인터·핸들 크기·textarea)
//
// 제스처·키보드·화면 크롬·텍스트 편집은 `annotation/` 4모듈로 나뉜다(37 §3.5).

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  applyObjectTransform,
  applySceneTransform,
} from "../../lib/annotate/geometry";
import {
  releaseScratch,
  renderScene,
  type PreviewBackdrop,
} from "../../lib/annotate/render";
import {
  type GeomNode,
  type Node,
  type ObjId,
  type Rect,
  type SceneTransform,
  type TextNode,
  type Tool,
  type DefaultPaint,
} from "../../lib/annotate/types";
import {
  drawCropOverlay,
  drawHud,
  drawMarquee,
  drawSelection,
} from "./annotation/chrome";
import { createKeyHandler } from "./annotation/keys";
import {
  createPointerHandlers,
  type DragState,
  type Point,
} from "./annotation/pointer";
import {
  TextEditOverlay,
  finishEditing as finishEditingImpl,
  type EditState,
} from "./annotation/textEdit";

export interface AnnotationLayerHandle {
  /**
   * Esc 계층 2~5를 처리한다(§5.4): 텍스트 확정 → 드래프트 취소 → select 복귀 → 선택 해제.
   * @returns 소비했으면 true(상위는 멈춘다), 처리할 게 없으면 false.
   */
  handleEscape(): boolean;
  /** 다음 프레임에 다시 그린다(외부 상태 변화·E2E 훅용). */
  renderOnce(): void;
  /** 크롭 드래그 중 라이브 사각형(React 상태를 태우지 않고 오버레이만 갱신). null 이면 지운다. */
  setCropPreview(r: Rect | null): void;
}

export interface AnnotationLayerProps {
  /** 회전·반전이 적용된 원본 캔버스 — 모자이크가 샘플링할 픽셀 소스(§5.2). */
  oriented: HTMLCanvasElement;
  /** 백킹 스토어 크기(base 캔버스와 반드시 동일). */
  backW: number;
  backH: number;
  /** oriented → backing px 배율. */
  scale: number;
  /**
   * oriented → **화면** css px 배율(맞춤 배율 × 줌). 히트 허용오차·핸들 집기 반경·핸들
   * 그리기 크기가 전부 이 값을 화면 실배율로 믿는다 — 그래서 줌이 여기 곱해져 들어온다.
   */
  displayScale: number;
  /**
   * 부모가 CSS transform 으로 건 줌 배율(기본 1). `displayScale` 에 이미 곱해져 있으므로,
   * **변환 안쪽 DOM**(텍스트 편집 textarea)만 이 값으로 되나눠 레이아웃 px 를 되찾는다 —
   * 그 요소는 조상 transform 에 함께 스케일되므로 줌을 두 번 먹으면 안 된다.
   */
  zoom?: number;
  /** 이미지에만 걸리는 색보정 필터 — 모자이크 샘플이 출력과 같은 픽셀을 보도록 여기서도 쓴다. */
  filterStr: string;
  objects: readonly Node[];
  selectedIds: readonly ObjId[];
  tool: Tool;
  style: DefaultPaint;
  opacity: number;
  cropMode: boolean;
  cropRect: Rect | null;
  onCropDown: (p: Point) => void;
  onCropMove: (p: Point) => void;
  onCropUp: () => void;
  /** 진행 중인 크롭 드래그를 버린다(Esc 계층 3) — 에디터 쪽 시작점·라이브 사각형도 함께 지운다. */
  onCropCancel: () => void;
  /** 커밋 시점에만 부른다(§5.3) — 히스토리 스냅샷이 여기서 쌓인다. */
  onCommit: (next: Node[]) => void;
  onToolChange: (t: Tool) => void;
  onSelectionChange: (ids: ObjId[]) => void;
}

function AnnotationLayerImpl(
  props: AnnotationLayerProps,
  ref: React.Ref<AnnotationLayerHandle>,
) {
  // 윈도우 리스너·포인터 핸들러가 항상 최신 props 를 보게 하는 거울(리스너 재등록 회피).
  const p = useRef(props);
  p.current = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 커밋 레이어 캐시(§4.4) — 문서가 바뀔 때만 renderScene 전체를 돌린다.
  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  const cacheKeyRef = useRef("");
  const cacheSrcRef = useRef<readonly Node[] | null>(null);

  const rafRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  /** 아직 커밋되지 않은 새 객체(드래그 중). */
  const draftRef = useRef<GeomNode | null>(null);
  /** 이동·리사이즈 미리보기(원본 대신 이것을 그린다). */
  const liveRef = useRef<GeomNode[] | null>(null);
  /** 크롭 라이브 사각형. undefined = 오버라이드 없음(props.cropRect 사용). */
  const cropPreviewRef = useRef<Rect | null | undefined>(undefined);
  /** 번호 뱃지 카운터 — 삭제해도 재정렬하지 않고 계속 증가한다(§12). */
  const badgeSeqRef = useRef(1);

  const [editing, setEditing] = useState<EditState | null>(null);
  const editingRef = useRef<EditState | null>(null);
  editingRef.current = editing;
  /** blur 와 Esc 가 동시에 확정을 부르는 이중 커밋 방지. */
  const editDoneRef = useRef(false);

  // ── 그리기 ────────────────────────────────────────────────────────────────

  /** 커밋된 객체 캐시. 문서·배율·크기·필터·제외 대상이 그대로면 재사용한다. */
  const ensureCache = useCallback((): HTMLCanvasElement | null => {
    const s = p.current;
    const excluded = new Set<ObjId>();
    if (liveRef.current) for (const o of liveRef.current) excluded.add(o.id);
    if (editingRef.current) excluded.add(editingRef.current.obj.id);
    const key = `${s.backW}x${s.backH}|${s.scale}|${s.filterStr}|${[...excluded].join(",")}`;
    if (
      cacheRef.current &&
      cacheSrcRef.current === s.objects &&
      cacheKeyRef.current === key
    ) {
      return cacheRef.current;
    }
    const cv = cacheRef.current ?? document.createElement("canvas");
    cacheRef.current = cv;
    if (cv.width !== s.backW || cv.height !== s.backH) {
      cv.width = s.backW;
      cv.height = s.backH;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cv.width, cv.height);
    const objs = excluded.size
      ? s.objects.filter((o) => !excluded.has(o.id))
      : s.objects;
    if (objs.length) {
      seedMosaicSources(ctx, objs, s);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = "none";
      renderScene(ctx, objs, sceneTransform(s.scale), {
        backdrop: previewBackdrop(s),
      });
    }
    cacheSrcRef.current = s.objects;
    cacheKeyRef.current = key;
    return cv;
  }, []);

  const paintNow = useCallback(() => {
    const c = canvasRef.current;
    const s = p.current;
    if (!c) return;
    if (c.width !== s.backW || c.height !== s.backH) {
      c.width = s.backW;
      c.height = s.backH;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, c.width, c.height);

    const cache = ensureCache();
    if (cache) ctx.drawImage(cache, 0, 0);

    // 아직 커밋되지 않은 것들은 매 프레임 새로 그린다(캐시에는 없다).
    const live: Node[] = [];
    if (liveRef.current) live.push(...liveRef.current);
    if (draftRef.current) live.push(draftRef.current);
    if (live.length) {
      seedMosaicSources(ctx, live, s);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = "none";
      // 드래그 중인 형광펜도 커밋본과 같은 배경 합성을 거쳐야 프리뷰가 튀지 않는다.
      renderScene(ctx, live, sceneTransform(s.scale), {
        backdrop: previewBackdrop(s),
      });
    }

    drawSelection(ctx, s, liveRef.current);
    drawMarquee(ctx, s, dragRef.current);
    drawHud(ctx, s, dragRef.current, draftRef.current, liveRef.current);
    drawCropOverlay(ctx, s, cropPreviewRef.current);
  }, [ensureCache]);

  /** rAF 코얼레싱 — 한 프레임에 한 번만 그린다(§4.4). */
  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      paintNow();
    });
  }, [paintNow]);

  // 캐시를 버려야 하는 변화(문서·배율·크기·필터)와 매 프레임 크롬(선택)을 모두 다시 그린다.
  useLayoutEffect(() => {
    schedule();
  }, [
    schedule,
    props.objects,
    props.selectedIds,
    props.backW,
    props.backH,
    props.scale,
    props.displayScale,
    props.filterStr,
    props.cropRect,
    props.cropMode,
    props.oriented,
    editing,
  ]);

  useEffect(
    () => () => {
      // 취소한 rAF 는 콜백이 돌지 않으니 플래그도 직접 되돌린다 — 남겨 두면 이후 schedule() 이
      // 전부 무시돼 캔버스가 미도색으로 굳는다(StrictMode 이중 마운트에서 실제로 잠겼다).
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    },
    [],
  );

  // ── 커밋 헬퍼 ─────────────────────────────────────────────────────────────

  const commitObjects = useCallback((next: Node[]) => {
    p.current.onCommit(next);
  }, []);

  /** 편집 중이던 텍스트를 확정한다. 내용이 비면 객체를 만들지 않거나 삭제한다(§5.5). */
  const finishEditing = useCallback(() => {
    finishEditingImpl({
      p,
      editingRef,
      editDoneRef,
      setEditing,
      commitObjects,
      schedule,
    });
  }, [commitObjects, schedule]);

  const beginEditing = useCallback(
    (obj: TextNode, isNew: boolean) => {
      // 이전 편집이 남아 있으면 먼저 확정한다(두 개가 동시에 열리지 않게).
      if (editingRef.current) finishEditing();
      editDoneRef.current = false;
      const st: EditState = { obj, isNew, text: obj.text };
      editingRef.current = st;
      setEditing(st);
      schedule();
    },
    [finishEditing, schedule],
  );

  // ── 포인터 ────────────────────────────────────────────────────────────────

  const { onPointerDown, onPointerMove, onPointerUp, onDoubleClick } =
    createPointerHandlers({
      p,
      canvasRef,
      dragRef,
      draftRef,
      liveRef,
      editingRef,
      badgeSeqRef,
      schedule,
      commitObjects,
      finishEditing,
      beginEditing,
    });

  // 편집기가 사라지면 모듈 스크래치를 놓아 준다 — 모듈 전역이라 창 수명 동안 마지막 크기
  // 그대로 남아 있었다(창당 최대 ~15MB). doc-* 창은 별도 WebView2라 창마다 따로 쌓인다.
  useEffect(() => releaseScratch, []);

  // ── 키보드(§5.6) ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = createKeyHandler({ p, editingRef });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── 외부 노출 핸들 ────────────────────────────────────────────────────────

  useImperativeHandle(
    ref,
    (): AnnotationLayerHandle => ({
      handleEscape() {
        const s = p.current;
        if (editingRef.current) {
          finishEditing();
          return true;
        }
        // 진행 중인 드래그는 종류를 가리지 않고 버린다(§5.4 계층 3). 크롭 드래그도 포함해야
        // Esc 뒤에 버튼을 떼는 것만으로 크롭이 확정되는 일이 없다.
        const d = dragRef.current;
        if (draftRef.current || d) {
          draftRef.current = null;
          liveRef.current = null;
          dragRef.current = null;
          if (d?.mode === "crop") {
            cropPreviewRef.current = undefined;
            s.onCropCancel();
          }
          schedule();
          return true;
        }
        if (s.tool !== "select") {
          s.onToolChange("select");
          return true;
        }
        if (s.selectedIds.length) {
          s.onSelectionChange([]);
          return true;
        }
        return false;
      },
      renderOnce() {
        schedule();
      },
      setCropPreview(r) {
        cropPreviewRef.current = r === null ? undefined : r;
        schedule();
      },
    }),
    [finishEditing, schedule],
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className={`absolute inset-0 h-full w-full ${
          props.cropMode || props.tool !== "select"
            ? "cursor-crosshair"
            : "cursor-default"
        }`}
        style={{ touchAction: "none" }}
      />
      <TextEditOverlay
        editing={editing}
        setEditing={setEditing}
        onFinish={finishEditing}
        displayScale={props.displayScale}
        zoom={props.zoom}
      />
    </>
  );
}

const AnnotationLayer = forwardRef<AnnotationLayerHandle, AnnotationLayerProps>(
  AnnotationLayerImpl,
);
export default AnnotationLayer;

// ── 순수 헬퍼 ───────────────────────────────────────────────────────────────

function sceneTransform(scale: number): SceneTransform {
  return { tx: 0, ty: 0, sx: scale, sy: scale };
}

/**
 * 프리뷰 배경(§4.3) — 이미지는 아래 base 캔버스에 있고 오버레이는 투명하다. 배경 픽셀이 있어야
 * 성립하는 블렌드(형광펜 multiply)를 렌더러가 재구성할 수 있게 소스를 넘긴다.
 */
function previewBackdrop(s: AnnotationLayerProps): PreviewBackdrop {
  return { image: s.oriented, filter: s.filterStr };
}

/**
 * 모자이크가 샘플링할 이미지 픽셀을 대상 캔버스의 해당 영역에만 심는다.
 *
 * renderScene 의 모자이크는 "대상 ctx 자신"을 되읽는데(§5.2), 프리뷰에서는 이미지가 아래쪽
 * base 캔버스에 있어 오버레이에는 아무것도 없다. 그래서 모자이크 사각형으로 **클립한 채**
 * 이미지를 먼저 그려 넣는다. 색보정 필터를 함께 걸어 출력 경로와 같은 픽셀을 보게 한다.
 *
 * 알려진 한계: blur 모드는 사각형 바깥을 패딩해 샘플링하므로 가장자리에서 투명을 조금
 * 빨아들인다(프리뷰에서만, 경계 몇 px). 출력 경로에는 이미지가 전면에 있어 발생하지 않는다.
 */
function seedMosaicSources(
  ctx: CanvasRenderingContext2D,
  objects: readonly Node[],
  s: AnnotationLayerProps,
): void {
  const t = sceneTransform(s.scale);
  for (const o of objects) {
    if (o.kind !== "mosaic") continue;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = s.filterStr;
    applySceneTransform(ctx, t);
    applyObjectTransform(ctx, o);
    ctx.beginPath();
    ctx.rect(o.x, o.y, o.w, o.h);
    ctx.clip();
    ctx.drawImage(s.oriented, 0, 0);
    ctx.restore();
  }
}



