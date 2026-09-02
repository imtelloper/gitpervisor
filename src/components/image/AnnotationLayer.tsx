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
  appendPenPoint,
  hitTestIndex,
  layoutText,
  normalizeRect,
  objectAABB,
  snapAngle,
  translateObject,
} from "../../lib/annotate/geometry";
import { renderScene, type PreviewBackdrop } from "../../lib/annotate/render";
import {
  DUPLICATE_OFFSET,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_WIDTH_SCALE,
  SHIFT_SNAP_DEG,
  TEXT_LINE_HEIGHT,
  newObjId,
  type AnnoObject,
  type ObjId,
  type Rect,
  type SceneTransform,
  type TextObject,
  type Tool,
  type ToolStyle,
} from "../../lib/annotate/types";
import { useUi } from "../../stores/ui";

/** 선택 핸들 한 변(css px). */
const HANDLE_CSS = 8;
/** 핸들 집기 허용 반경(css px) — 손가락/트랙패드로도 집히게 넉넉히. */
const HANDLE_GRAB_CSS = 10;
/** 이보다 작은 드래그는 클릭 오조작으로 보고 객체를 만들지 않는다(oriented px). */
const MIN_DRAG = 3;

const SELECT_COLOR = "#4fa3ff";

/** 도구 단축키(§5.2) — 모달 안에서만, 텍스트 입력 중이 아닐 때만 활성. */
const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  p: "pen",
  h: "highlight",
  l: "line",
  a: "arrow",
  r: "rect",
  o: "ellipse",
  t: "text",
  n: "badge",
  m: "mosaic",
};

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

interface Point {
  x: number;
  y: number;
}

/** 진행 중인 포인터 제스처. */
type DragState =
  | { mode: "crop" }
  | { mode: "draw"; start: Point }
  | { mode: "move"; start: Point; base: AnnoObject[] }
  | {
      mode: "resize";
      start: Point;
      handle: number;
      base: AnnoObject;
      bbox: Rect;
    };

interface EditState {
  /** 편집 중인 텍스트 객체(확정 전 값). */
  obj: TextObject;
  /** 새로 만드는 중인가 — 빈 내용으로 끝나면 그냥 버린다. */
  isNew: boolean;
  text: string;
}

export interface AnnotationLayerProps {
  /** 회전·반전이 적용된 원본 캔버스 — 모자이크가 샘플링할 픽셀 소스(§5.2). */
  oriented: HTMLCanvasElement;
  /** 백킹 스토어 크기(base 캔버스와 반드시 동일). */
  backW: number;
  backH: number;
  /** oriented → backing px 배율. */
  scale: number;
  /** oriented → css px 배율. */
  displayScale: number;
  /** 이미지에만 걸리는 색보정 필터 — 모자이크 샘플이 출력과 같은 픽셀을 보도록 여기서도 쓴다. */
  filterStr: string;
  objects: readonly AnnoObject[];
  selectedIds: readonly ObjId[];
  tool: Tool;
  style: ToolStyle;
  opacity: number;
  cropMode: boolean;
  cropRect: Rect | null;
  onCropDown: (p: Point) => void;
  onCropMove: (p: Point) => void;
  onCropUp: () => void;
  /** 진행 중인 크롭 드래그를 버린다(Esc 계층 3) — 에디터 쪽 시작점·라이브 사각형도 함께 지운다. */
  onCropCancel: () => void;
  /** 커밋 시점에만 부른다(§5.3) — 히스토리 스냅샷이 여기서 쌓인다. */
  onCommit: (next: AnnoObject[]) => void;
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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // 커밋 레이어 캐시(§4.4) — 문서가 바뀔 때만 renderScene 전체를 돌린다.
  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  const cacheKeyRef = useRef("");
  const cacheSrcRef = useRef<readonly AnnoObject[] | null>(null);

  const rafRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  /** 아직 커밋되지 않은 새 객체(드래그 중). */
  const draftRef = useRef<AnnoObject | null>(null);
  /** 이동·리사이즈 미리보기(원본 대신 이것을 그린다). */
  const liveRef = useRef<AnnoObject[] | null>(null);
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
    const live: AnnoObject[] = [];
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

  // ── 좌표 변환 ─────────────────────────────────────────────────────────────

  const toOriented = useCallback((e: React.PointerEvent): Point => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const ow = p.current.oriented.width;
    const oh = p.current.oriented.height;
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * ow;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * oh;
    return {
      x: Math.max(0, Math.min(ow, x)),
      y: Math.max(0, Math.min(oh, y)),
    };
  }, []);

  // ── 커밋 헬퍼 ─────────────────────────────────────────────────────────────

  const commitObjects = useCallback((next: AnnoObject[]) => {
    p.current.onCommit(next);
  }, []);

  /** 편집 중이던 텍스트를 확정한다. 내용이 비면 객체를 만들지 않거나 삭제한다(§5.5). */
  const finishEditing = useCallback(() => {
    const st = editingRef.current;
    if (!st || editDoneRef.current) return;
    editDoneRef.current = true;
    const s = p.current;
    const text = st.text.replace(/\s+$/g, "");
    if (!text.trim()) {
      if (!st.isNew) commitObjects(s.objects.filter((o) => o.id !== st.obj.id));
    } else {
      const obj: TextObject = { ...st.obj, text };
      commitObjects(
        st.isNew
          ? [...s.objects, obj]
          : s.objects.map((o) => (o.id === obj.id ? obj : o)),
      );
    }
    setEditing(null);
    editingRef.current = null;
    schedule();
  }, [commitObjects, schedule]);

  const beginEditing = useCallback(
    (obj: TextObject, isNew: boolean) => {
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

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = p.current;
    const pt = toOriented(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (s.cropMode) {
      dragRef.current = { mode: "crop" };
      s.onCropDown(pt);
      return;
    }
    // 텍스트 편집 중 캔버스를 누르면 textarea blur 로 확정된다 — 여기서 한 번 더 보장.
    if (editingRef.current) finishEditing();

    if (s.tool === "select") {
      // 1) 단일 선택 상태면 리사이즈 핸들을 먼저 본다(핸들이 객체 위에 있을 수 있다).
      const only =
        s.selectedIds.length === 1
          ? s.objects.find((o) => o.id === s.selectedIds[0])
          : undefined;
      if (only) {
        const bbox = objectAABB(only);
        const h = hitHandle(bbox, pt, HANDLE_GRAB_CSS / s.displayScale);
        if (h >= 0) {
          dragRef.current = { mode: "resize", start: pt, handle: h, base: only, bbox };
          liveRef.current = [only];
          schedule();
          return;
        }
      }
      const idx = hitTestIndex(s.objects, pt.x, pt.y, s.displayScale);
      if (idx < 0) {
        if (!e.shiftKey && s.selectedIds.length) s.onSelectionChange([]);
        dragRef.current = null;
        return;
      }
      const id = s.objects[idx].id;
      let ids: ObjId[];
      if (e.shiftKey) {
        ids = s.selectedIds.includes(id)
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id];
      } else {
        ids = s.selectedIds.includes(id) ? [...s.selectedIds] : [id];
      }
      s.onSelectionChange(ids);
      const base = s.objects.filter((o) => ids.includes(o.id));
      dragRef.current = base.length ? { mode: "move", start: pt, base } : null;
      liveRef.current = base.length ? base : null;
      schedule();
      return;
    }

    if (s.tool === "text") {
      beginEditing(
        {
          id: newObjId(),
          kind: "text",
          stroke: s.style.stroke,
          strokeWidth: 0,
          opacity: s.opacity,
          rot: 0,
          x: pt.x,
          y: pt.y,
          text: "",
          fontSize: s.style.fontSize,
          fontFamily: FONT_FAMILY,
        },
        true,
      );
      return;
    }

    if (s.tool === "badge") {
      const n = nextBadgeNumber(s.objects, badgeSeqRef);
      commitObjects([
        ...s.objects,
        {
          id: newObjId(),
          kind: "badge",
          stroke: "#FFFFFF",
          strokeWidth: 0,
          opacity: s.opacity,
          rot: 0,
          x: pt.x,
          y: pt.y,
          n,
          fontSize: s.style.fontSize,
          fill: s.style.stroke,
        },
      ]);
      return;
    }

    dragRef.current = { mode: "draw", start: pt };
    draftRef.current = makeDraft(s, pt, pt, e.shiftKey);
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const s = p.current;
    const pt = toOriented(e);

    if (d.mode === "crop") {
      s.onCropMove(pt);
      return;
    }
    if (d.mode === "draw") {
      const cur = draftRef.current;
      if (cur && (cur.kind === "pen" || cur.kind === "highlight")) {
        // 드래프트는 커밋 전이므로 제자리 변경한다 — 이벤트마다 복제하면 O(n²).
        appendPenPoint(cur.pts, pt.x, pt.y);
      } else {
        draftRef.current = makeDraft(s, d.start, pt, e.shiftKey);
      }
      schedule();
      return;
    }
    if (d.mode === "move") {
      const dx = pt.x - d.start.x;
      const dy = pt.y - d.start.y;
      liveRef.current = d.base.map((o) => translateObject(o, dx, dy));
      schedule();
      return;
    }
    // resize
    liveRef.current = [resizeObject(d.base, d.bbox, d.handle, pt, e.shiftKey)];
    schedule();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const s = p.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (d.mode === "crop") {
      s.onCropUp();
      return;
    }
    if (d.mode === "draw") {
      const draft = draftRef.current;
      draftRef.current = null;
      if (draft && isDraftUsable(draft)) commitObjects([...s.objects, draft]);
      schedule();
      return;
    }
    const live = liveRef.current;
    liveRef.current = null;
    if (live) {
      const byId = new Map(live.map((o) => [o.id, o]));
      const moved = s.objects.some((o) => byId.has(o.id) && byId.get(o.id) !== o);
      if (moved) commitObjects(s.objects.map((o) => byId.get(o.id) ?? o));
    }
    schedule();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = p.current;
    if (s.cropMode || s.tool !== "select") return;
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * s.oriented.width;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * s.oriented.height;
    const idx = hitTestIndex(s.objects, x, y, s.displayScale);
    if (idx < 0) return;
    const o = s.objects[idx];
    if (o.kind === "text") beginEditing(o, false);
  };

  // ── 키보드(§5.6) ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const s = p.current;
      // 텍스트 편집 중이거나 입력 요소에 포커스가 있으면 단축키를 잡지 않는다(§5.5).
      if (editingRef.current) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      const ui = useUi.getState();
      if (ui.prompt || ui.confirm) return;

      const mod = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();

      if (mod && key === "d") {
        if (!s.selectedIds.length) return;
        const copies: AnnoObject[] = [];
        for (const o of s.objects) {
          if (!s.selectedIds.includes(o.id)) continue;
          copies.push({
            ...translateObject(o, DUPLICATE_OFFSET, DUPLICATE_OFFSET),
            id: newObjId(),
          });
        }
        if (!copies.length) return;
        ev.preventDefault();
        s.onCommit([...s.objects, ...copies]);
        s.onSelectionChange(copies.map((o) => o.id));
        return;
      }
      if (mod) return;

      if (ev.key === "Delete" || ev.key === "Backspace") {
        if (!s.selectedIds.length) return;
        ev.preventDefault();
        s.onCommit(s.objects.filter((o) => !s.selectedIds.includes(o.id)));
        s.onSelectionChange([]);
        return;
      }
      if (ev.key === "[" || ev.key === "]") {
        if (!s.selectedIds.length) return;
        ev.preventDefault();
        s.onCommit(reorder(s.objects, s.selectedIds, ev.key === "]" ? 1 : -1));
        return;
      }
      const t = TOOL_KEYS[key];
      if (t && !ev.altKey) {
        ev.preventDefault();
        s.onToolChange(t);
      }
    };
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

  // ── textarea 오버레이(§5.5) ───────────────────────────────────────────────

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  const ds = props.displayScale;
  const editBox = editing
    ? (() => {
        const m = layoutText({ ...editing.obj, text: editing.text || " " });
        const fs = editing.obj.fontSize * ds;
        const lh = editing.obj.fontSize * TEXT_LINE_HEIGHT * ds;
        // 캔버스는 textBaseline="top"(em 상단 기준)인데 줄 상자는 half-leading 만큼
        // 글리프를 내린다 — 그 차이를 빼서 편집 중에도 같은 자리에 보이게 한다.
        const halfLeading = (lh - fs) / 2;
        return {
          left: editing.obj.x * ds,
          top: editing.obj.y * ds - halfLeading,
          width: (m.width + editing.obj.fontSize) * ds,
          height: m.height * ds + (lh - fs),
          fontSize: fs,
          lineHeight: `${lh}px`,
          // 이미지 회전으로 rot 이 붙은 텍스트도 캔버스와 같은 방향·자리에 뜨게 한다(§5.5).
          // 피벗은 applyObjectTransform 과 같은 앵커(=obj.x,obj.y)이고, 그 점은 textarea 상자
          // 안에서 (0, half-leading) 이다.
          rot: editing.obj.rot,
          originY: halfLeading,
        };
      })()
    : null;

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
      {editing && editBox && (
        <textarea
          ref={taRef}
          value={editing.text}
          onChange={(e) =>
            setEditing((st) => (st ? { ...st, text: e.target.value } : st))
          }
          onBlur={finishEditing}
          onKeyDown={(e) => {
            // Ctrl+Enter 확정. Esc 는 모달의 Esc 계층이 handleEscape() 로 처리하므로
            // **전파를 막지 않는다** — 막으면 window 리스너까지 못 가 Esc 가 죽는다.
            // 도구 단축키·Ctrl+Z 는 리스너 쪽이 포커스된 입력 요소를 보고 스스로 비켜난다.
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              finishEditing();
            }
          }}
          spellCheck={false}
          className="absolute m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
          style={{
            left: editBox.left,
            top: editBox.top,
            width: editBox.width,
            height: editBox.height,
            fontSize: editBox.fontSize,
            lineHeight: editBox.lineHeight,
            fontFamily: editing.obj.fontFamily,
            color: editing.obj.stroke,
            caretColor: editing.obj.stroke,
            whiteSpace: "pre",
            transformOrigin: `0px ${editBox.originY}px`,
            transform: `rotate(${editBox.rot}deg)`,
          }}
        />
      )}
    </>
  );
}

const AnnotationLayer = forwardRef<AnnotationLayerHandle, AnnotationLayerProps>(
  AnnotationLayerImpl,
);
export default AnnotationLayer;

// ── 순수 헬퍼 ───────────────────────────────────────────────────────────────

/** 텍스트 객체의 기본 폰트 — textarea CSS 와 반드시 같은 문자열이어야 한다(§5.5). */
const FONT_FAMILY =
  '"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';

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
  objects: readonly AnnoObject[],
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

/** 선택 바운딩 박스 + 8핸들. 화면 크롬이므로 출력 경로(renderScene)에는 절대 없다(§5.6). */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  s: AnnotationLayerProps,
  live: readonly AnnoObject[] | null,
): void {
  if (!s.selectedIds.length) return;
  const byId = new Map((live ?? []).map((o) => [o.id, o]));
  const sel: AnnoObject[] = [];
  for (const o of s.objects) {
    if (s.selectedIds.includes(o.id)) sel.push(byId.get(o.id) ?? o);
  }
  if (!sel.length) return;
  // 백킹 px / css px — 핸들이 배율과 무관하게 같은 크기로 보이게 한다.
  const k = s.scale / Math.max(s.displayScale, 1e-6);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = Math.max(1, k);
  ctx.setLineDash([4 * k, 3 * k]);
  for (const o of sel) {
    const b = objectAABB(o);
    ctx.strokeRect(b.x * s.scale, b.y * s.scale, b.w * s.scale, b.h * s.scale);
  }
  ctx.setLineDash([]);
  if (sel.length === 1) {
    const b = objectAABB(sel[0]);
    const size = HANDLE_CSS * k;
    ctx.fillStyle = "#ffffff";
    for (const h of handlePoints(b)) {
      const cx = h.x * s.scale;
      const cy = h.y * s.scale;
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
      ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
    }
  }
  ctx.restore();
}

/** 크롭 오버레이 — 기존 ImageEditor.paint() 에서 이관(§4.3). */
function drawCropOverlay(
  ctx: CanvasRenderingContext2D,
  s: AnnotationLayerProps,
  preview: Rect | null | undefined,
): void {
  const r = preview !== undefined ? preview : s.cropRect;
  if (!r || r.w <= 0 || r.h <= 0) return;
  const x = r.x * s.scale;
  const y = r.y * s.scale;
  const w = r.w * s.scale;
  const h = r.h * s.scale;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, cw, y);
  ctx.fillRect(0, y + h, cw, ch - (y + h));
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, cw - (x + w), h);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = Math.max(1.5, cw / 400);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/** 8핸들 위치(0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w). */
function handlePoints(b: Rect): Point[] {
  const mx = b.x + b.w / 2;
  const my = b.y + b.h / 2;
  return [
    { x: b.x, y: b.y },
    { x: mx, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: my },
    { x: b.x + b.w, y: b.y + b.h },
    { x: mx, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
    { x: b.x, y: my },
  ];
}

/** 점이 어느 핸들 위인가(oriented px 허용오차). 없으면 -1. */
function hitHandle(b: Rect, pt: Point, tol: number): number {
  const hs = handlePoints(b);
  for (let i = 0; i < hs.length; i++) {
    if (Math.abs(hs[i].x - pt.x) <= tol && Math.abs(hs[i].y - pt.y) <= tol) {
      return i;
    }
  }
  return -1;
}

/** 현재 도구·속성으로 드래그 드래프트를 만든다. */
function makeDraft(
  s: AnnotationLayerProps,
  a: Point,
  b: Point,
  shift: boolean,
): AnnoObject | null {
  const id = newObjId();
  const common = {
    id,
    stroke: s.style.stroke,
    strokeWidth: s.style.strokeWidth,
    opacity: s.opacity,
    rot: 0,
  };
  switch (s.tool) {
    case "pen":
      return { ...common, kind: "pen", pts: [a.x, a.y] };
    case "highlight":
      return {
        ...common,
        kind: "highlight",
        strokeWidth: s.style.strokeWidth * HIGHLIGHT_WIDTH_SCALE,
        opacity: HIGHLIGHT_OPACITY,
        pts: [a.x, a.y],
      };
    case "line":
    case "arrow": {
      const e = shift ? snapAngle(a.x, a.y, b.x, b.y, SHIFT_SNAP_DEG) : b;
      return {
        ...common,
        kind: s.tool,
        x1: a.x,
        y1: a.y,
        x2: e.x,
        y2: e.y,
        head: "end",
      };
    }
    case "rect": {
      const r = squareable(a, b, shift);
      return { ...common, kind: "rect", ...r, fill: s.style.fill, radius: s.style.radius };
    }
    case "ellipse": {
      const r = squareable(a, b, shift);
      return { ...common, kind: "ellipse", ...r, fill: s.style.fill };
    }
    case "mosaic": {
      const r = squareable(a, b, shift);
      return {
        ...common,
        kind: "mosaic",
        ...r,
        mode: s.style.mosaicMode,
        strength: s.style.mosaicStrength,
      };
    }
    default:
      return null;
  }
}

/** Shift 면 정사각/정원으로 맞춘 사각형(§5.2). */
function squareable(a: Point, b: Point, shift: boolean): Rect {
  if (!shift) return normalizeRect(a.x, a.y, b.x, b.y);
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const x = a.x + Math.sign(b.x - a.x || 1) * side;
  const y = a.y + Math.sign(b.y - a.y || 1) * side;
  return normalizeRect(a.x, a.y, x, y);
}

/** 클릭 오조작으로 생긴 티끌 객체를 거른다. */
function isDraftUsable(o: AnnoObject): boolean {
  switch (o.kind) {
    case "pen":
    case "highlight":
      return o.pts.length >= 4;
    case "line":
    case "arrow":
      return Math.hypot(o.x2 - o.x1, o.y2 - o.y1) >= MIN_DRAG;
    case "rect":
    case "ellipse":
    case "mosaic":
      return o.w >= MIN_DRAG && o.h >= MIN_DRAG;
    default:
      return true;
  }
}

/** 다음 뱃지 번호 — 기존 최대값과 카운터 중 큰 쪽에서 이어 붙인다(삭제해도 재정렬 없음). */
function nextBadgeNumber(
  objects: readonly AnnoObject[],
  seq: React.RefObject<number>,
): number {
  let max = 0;
  for (const o of objects) if (o.kind === "badge") max = Math.max(max, o.n);
  const n = Math.max(seq.current, max + 1);
  seq.current = n + 1;
  return n;
}

/** z-order 한 칸 이동(`[` 뒤로, `]` 앞으로). */
function reorder(
  objects: readonly AnnoObject[],
  ids: readonly ObjId[],
  dir: 1 | -1,
): AnnoObject[] {
  const next = objects.slice();
  // 앞으로 보낼 때는 뒤에서부터, 뒤로 보낼 때는 앞에서부터 옮겨야 서로 자리를 뺏지 않는다.
  const order =
    dir === 1
      ? next.map((_, i) => i).reverse()
      : next.map((_, i) => i);
  for (const i of order) {
    const o = next[i];
    if (!o || !ids.includes(o.id)) continue;
    const j = i + dir;
    if (j < 0 || j >= next.length) continue;
    if (ids.includes(next[j].id)) continue;
    next[i] = next[j];
    next[j] = o;
  }
  return next;
}

/**
 * 8핸들 리사이즈 — 시작 시점 bbox 를 기준으로 배율을 구해 객체 기하를 늘린다.
 * Shift 면 변화가 큰 축의 배율을 양축에 함께 적용해 비율을 고정한다(§5.6).
 */
function resizeObject(
  base: AnnoObject,
  b: Rect,
  handle: number,
  pt: Point,
  shift: boolean,
): AnnoObject {
  const west = handle === 0 || handle === 6 || handle === 7;
  const east = handle === 2 || handle === 3 || handle === 4;
  const north = handle === 0 || handle === 1 || handle === 2;
  const south = handle === 4 || handle === 5 || handle === 6;

  let fx = 1;
  let fy = 1;
  let ox = b.x;
  let oy = b.y;
  if (east && b.w > 0) {
    ox = b.x;
    fx = (pt.x - ox) / b.w;
  } else if (west && b.w > 0) {
    ox = b.x + b.w;
    fx = (ox - pt.x) / b.w;
  }
  if (south && b.h > 0) {
    oy = b.y;
    fy = (pt.y - oy) / b.h;
  } else if (north && b.h > 0) {
    oy = b.y + b.h;
    fy = (oy - pt.y) / b.h;
  }
  if (shift) {
    const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
    // 변 핸들(n/s/e/w)은 한 축 배율만 잡히므로, 비활성 축은 bbox 중심을 원점으로 같은 배율을
    // 건다 — 그래야 마주 보는 변이 양쪽으로 대칭 확대되며 비율이 실제로 고정된다.
    if (!east && !west) ox = b.x + b.w / 2;
    if (!north && !south) oy = b.y + b.h / 2;
    fx = f;
    fy = f;
  }
  // 뒤집기(음수 배율)는 v1 비범위 — 최소 배율로 잡아 둔다.
  const MIN_F = 0.02;
  fx = Math.max(MIN_F, fx);
  fy = Math.max(MIN_F, fy);
  return scaleObject(base, fx, fy, ox, oy);
}

/**
 * 객체 기하를 (ox,oy) 기준으로 늘린다. 선 두께는 사용자가 고른 값이라 건드리지 않고,
 * 텍스트·뱃지는 크기 자체가 글자 크기라 fontSize 를 함께 키운다.
 */
function scaleObject(
  o: AnnoObject,
  fx: number,
  fy: number,
  ox: number,
  oy: number,
): AnnoObject {
  const sx = (x: number) => ox + (x - ox) * fx;
  const sy = (y: number) => oy + (y - oy) * fy;
  const k = Math.sqrt(Math.abs(fx * fy)) || 1;
  switch (o.kind) {
    case "pen":
    case "highlight": {
      const pts = o.pts.slice();
      for (let i = 0; i + 1 < pts.length; i += 2) {
        pts[i] = sx(pts[i]);
        pts[i + 1] = sy(pts[i + 1]);
      }
      return { ...o, pts };
    }
    case "line":
    case "arrow":
      return {
        ...o,
        x1: sx(o.x1),
        y1: sy(o.y1),
        x2: sx(o.x2),
        y2: sy(o.y2),
      };
    case "rect":
    case "ellipse":
    case "mosaic": {
      const r = normalizeRect(sx(o.x), sy(o.y), sx(o.x + o.w), sy(o.y + o.h));
      return { ...o, x: r.x, y: r.y, w: r.w, h: r.h };
    }
    case "text":
    case "badge":
      return {
        ...o,
        x: sx(o.x),
        y: sy(o.y),
        fontSize: Math.max(4, o.fontSize * k),
      };
  }
}
