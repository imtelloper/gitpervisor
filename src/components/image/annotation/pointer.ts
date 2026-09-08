// 포인터 제스처 — 선택·이동·리사이즈·마퀴·그리기·크롭 드래그(설계 §5.2~5.4).

import {
  appendPenPoint,
  hitTest,
  isGeomNode,
  normalizeDeg,
  objectAABB,
  objectBBox,
  translateObject,
} from "../../../lib/annotate/geometry";
import { remove } from "../../../lib/annotate/tree";
import {
  type GeomNode,
  type Node,
  type ObjId,
  type Rect,
  type TextNode,
} from "../../../lib/annotate/types";
import type { Tool } from "../../../stores/imageEditor";
import type { AnnotationLayerProps } from "../AnnotationLayer";
import {
  isDraftUsable,
  makeDraft,
  newBadgeNode,
  newTextNode,
  nextBadgeNumber,
  resizeObject,
} from "./draft";
import {
  HANDLE_CURSORS,
  HANDLE_GRAB_CSS,
  MIN_DRAG,
  hitHandle,
  marqueeRect,
  rectsOverlap,
} from "./chrome";
import type { EditState } from "./textEdit";

export interface Point {
  x: number;
  y: number;
}

/**
 * 선택 도구처럼 구는 도구 — 히트·핸들·이동·마퀴가 같다. 배율(K)은 리사이즈 수식만 다르다.
 */
const isSelectLike = (t: Tool) => t === "select" || t === "scale";

/** 진행 중인 포인터 제스처. */
export type DragState =
  | { mode: "crop" }
  | { mode: "draw"; start: Point }
  /**
   * 지우개. 지날 때마다 지우지 **않고** 적중 id 만 모았다가 pointerup 에 한 번 커밋한다 —
   * 틱마다 커밋하면 드래그 한 번이 히스토리 200칸을 통째로 태워 직전 작업으로 못 돌아간다.
   */
  | { mode: "erase"; ids: Set<ObjId> }
  /**
   * 빈 곳에서 시작한 선택 사각형. `keep` 은 Shift 누적의 기준이 되는 **드래그 시작 시점의**
   * 선택이다 — 비-Shift 는 pointerdown 에 이미 비우므로 up 에서 스토어를 되읽으면 늦다.
   */
  | { mode: "marquee"; start: Point; cur: Point; keep: readonly ObjId[] }
  | { mode: "move"; start: Point; base: GeomNode[] }
  | {
      mode: "resize";
      start: Point;
      handle: number;
      base: GeomNode;
      bbox: Rect;
    };

/** 포인터 핸들러가 만지는 컴포넌트 상태(ref 미러·커밋 헬퍼). */
export interface PointerCtx {
  p: React.RefObject<AnnotationLayerProps>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  dragRef: React.RefObject<DragState | null>;
  /** 아직 커밋되지 않은 새 객체(드래그 중). */
  draftRef: React.RefObject<GeomNode | null>;
  /** 이동·리사이즈 미리보기(원본 대신 이것을 그린다). */
  liveRef: React.RefObject<GeomNode[] | null>;
  editingRef: React.RefObject<EditState | null>;
  /** 번호 뱃지 카운터. */
  badgeSeqRef: React.RefObject<number>;
  schedule: () => void;
  /** `label` 은 히스토리 항목 이름(41) — 넘기지 않으면 '편집' 류 기본 라벨이 붙는다. */
  commitObjects: (next: Node[], label?: string) => void;
  finishEditing: () => void;
  beginEditing: (obj: TextNode, isNew: boolean) => void;
}

export function createPointerHandlers(ctx: PointerCtx) {
  const {
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
  } = ctx;

  // ── 좌표 변환 ───────────────────────────────────────────────────────────

  const toOriented = (e: React.PointerEvent): Point => {
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
  };

  /** 지우개가 지난 자리의 적중 노드를 모은다. 씬을 보므로 숨김·잠금은 애초에 안 걸린다. */
  const eraseHit = (ids: Set<ObjId>, pt: Point) => {
    const s = p.current;
    const id = hitTest(s.scene, pt.x, pt.y, s.displayScale);
    if (id) ids.add(id);
  };

  // ── 포인터 ──────────────────────────────────────────────────────────────

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = p.current;
    // 손 도구는 좌버튼을 **잡지 않는다**(캡처도, 처리도 없다) — 그래야 이벤트가 그대로
    // 버블해 스테이지의 팬 핸들러가 받는다. setPointerCapture 를 먼저 걸어 버리면 이후
    // move/up 이 이 캔버스로만 배달돼 화면이 한 픽셀도 안 밀린다.
    // 크롭은 모드라 도구보다 우선한다(42 §3.2 — 직교).
    if (s.tool === "hand" && !s.cropMode) return;
    const pt = toOriented(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (s.cropMode) {
      dragRef.current = { mode: "crop" };
      s.onCropDown(pt);
      return;
    }
    // 텍스트 편집 중 캔버스를 누르면 textarea blur 로 확정된다 — 여기서 한 번 더 보장.
    if (editingRef.current) finishEditing();

    if (s.tool === "eraser") {
      const ids = new Set<ObjId>();
      eraseHit(ids, pt);
      dragRef.current = { mode: "erase", ids };
      return;
    }

    if (isSelectLike(s.tool)) {
      // 1) 단일 선택 상태면 리사이즈 핸들을 먼저 본다(핸들이 객체 위에 있을 수 있다).
      const only =
        s.selectedIds.length === 1
          ? s.scene.nodes.find((o) => o.id === s.selectedIds[0])
          : undefined;
      if (only) {
        // 리사이즈 수학이 쓰는 bbox 는 **로컬**이다(회전 외접 사각형이 아니다).
        const bbox = objectBBox(only);
        const h = hitHandle(only, pt, HANDLE_GRAB_CSS / s.displayScale);
        if (h >= 0) {
          dragRef.current = { mode: "resize", start: pt, handle: h, base: only, bbox };
          liveRef.current = [only];
          schedule();
          return;
        }
      }
      // 씬 히트 — 숨김은 애초에 씬에 없고, 잠금은 flags 로 걸러진다. 그룹이 있으면 최상위
      // 조상이 돌아온다(클릭 = 그룹 단위, 시안 ① ⇧클릭 규칙).
      const hitId = hitTest(s.scene, pt.x, pt.y, s.displayScale);
      if (!hitId) {
        // 빈 곳 = 마퀴 시작. 종전에는 여기서 dragRef 를 비워 드래그가 통째로 no-op 이었다 —
        // 모든 그래픽 도구가 이 자리에서 고무줄을 그리므로 "이건 그리기 도구가 아니다"라는
        // 가장 큰 신호였다. 클릭(3px 미만)의 선택 해제는 종전 그대로 여기서 한다.
        const keep = e.shiftKey ? s.selectedIds : [];
        if (!e.shiftKey && s.selectedIds.length) s.onSelectionChange([]);
        dragRef.current = { mode: "marquee", start: pt, cur: pt, keep };
        schedule();
        return;
      }
      const id = hitId;
      let ids: ObjId[];
      if (e.shiftKey) {
        ids = s.selectedIds.includes(id)
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id];
      } else {
        ids = s.selectedIds.includes(id) ? [...s.selectedIds] : [id];
      }
      s.onSelectionChange(ids);
      // 컨테이너는 기하가 없어 직접 못 움직인다 — 그룹 이동은 태스크 38 translateSubtree.
      const base = s.objects.filter(
        (o): o is GeomNode => ids.includes(o.id) && isGeomNode(o),
      );
      dragRef.current = base.length ? { mode: "move", start: pt, base } : null;
      liveRef.current = base.length ? base : null;
      schedule();
      return;
    }

    if (s.tool === "text") {
      // 글자색은 채우기다(v1 의 stroke 자리 — 37 §3.3 매핑표).
      beginEditing(
        newTextNode({
          x: pt.x,
          y: pt.y,
          opacity: s.opacity,
          fontSize: s.style.fontSize,
          fills: s.style.strokes.map((f) => ({ ...f })),
        }),
        true,
      );
      return;
    }

    if (s.tool === "badge") {
      const n = nextBadgeNumber(s.objects, badgeSeqRef);
      // 뱃지의 "색"은 원 채움이다 — 숫자 글자색은 렌더러가 대비로 정한다(v1 규칙 승계).
      commitObjects([
        ...s.objects,
        newBadgeNode({
          x: pt.x,
          y: pt.y,
          n,
          opacity: s.opacity,
          fontSize: s.style.fontSize,
          fills: s.style.strokes.map((f) => ({ ...f })),
        }),
      ]);
      return;
    }

    dragRef.current = { mode: "draw", start: pt };
    draftRef.current = makeDraft(s, pt, pt, e.shiftKey);
    schedule();
  };

  /**
   * 드래그가 없을 때의 호버 커서. **React state 를 쓰지 않는다** — 매 mousemove 리렌더는
   * useLayoutEffect 의존성을 매번 돌려 schedule 을 폭주시킨다.
   *
   * hitTestIndex 는 부르지 않는다(설계 K4): 그 안에서 객체마다 Path2D 를 새로 만들기 때문에
   * 최고 핫패스에 얹으면 펜 200개 문서에서 프레임당 200개가 생긴다. 핸들 8점 비교는 공짜다.
   */
  const updateHoverCursor = (e: React.PointerEvent) => {
    const c = canvasRef.current;
    if (!c) return;
    const s = p.current;
    let cur = "";
    // 크롭 중에는 도구 커서를 덮지 않는다 — 모드가 이긴다(className 의 crosshair 유지).
    if (!s.cropMode && s.tool === "hand") {
      cur = "grab";
    } else if (!s.cropMode && isSelectLike(s.tool) && s.selectedIds.length === 1) {
      const only = s.objects.find(
        (o): o is GeomNode => o.id === s.selectedIds[0] && isGeomNode(o),
      );
      if (only) {
        const h = hitHandle(only, toOriented(e), HANDLE_GRAB_CSS / s.displayScale);
        // 핸들 인덱스는 **로컬**(회전 이전) 방향이라 그대로 쓰면 회전 객체에서 어긋난다.
        // 8방향이 45° 간격이므로 회전각을 45° 단위로 반올림해 인덱스를 돌린다.
        if (h >= 0) {
          const turn = Math.round(normalizeDeg(only.rot) / 45);
          cur = HANDLE_CURSORS[(h + turn) % 8];
        }
      }
    }
    // className 의 Tailwind 커서로 되돌리려면 **빈 문자열**이어야 한다.
    if (c.style.cursor !== cur) c.style.cursor = cur;
  };

  /**
   * 드래그 상태를 포인터 위치로 갱신한다.
   *
   * **move 와 up 이 같은 함수를 쓴다.** 종전에는 up 이 이 갱신을 하지 않고 마지막
   * pointermove 가 남긴 값을 그대로 커밋해, 그 사이의 이동이 통째로 사라졌다 — 실제 마우스는
   * up 직전에 move 를 내보내 서브프레임 손실로 끝나지만, 펜/터치의 리프트나 합성 이벤트에서는
   * 드래그 구간 전체가 유실된다.
   */
  const applyDragAt = (d: DragState, pt: Point, shift: boolean) => {
    const s = p.current;
    if (d.mode === "crop") {
      s.onCropMove(pt);
      return;
    }
    if (d.mode === "marquee") {
      d.cur = pt;
      return;
    }
    if (d.mode === "erase") {
      eraseHit(d.ids, pt);
      return;
    }
    if (d.mode === "draw") {
      const cur = draftRef.current;
      if (cur && (cur.kind === "pen" || cur.kind === "highlight")) {
        // 드래프트는 커밋 전이므로 제자리 변경한다 — 이벤트마다 복제하면 O(n²).
        appendPenPoint(cur.pts, pt.x, pt.y);
      } else {
        draftRef.current = makeDraft(s, d.start, pt, shift);
      }
      return;
    }
    if (d.mode === "move") {
      const dx = pt.x - d.start.x;
      const dy = pt.y - d.start.y;
      liveRef.current = d.base.map((o) => translateObject(o, dx, dy));
      return;
    }
    liveRef.current = [
      resizeObject(d.base, d.bbox, d.handle, pt, shift, s.tool === "scale"),
    ];
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      updateHoverCursor(e);
      return;
    }
    applyDragAt(d, toOriented(e), e.shiftKey);
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
    // 릴리스 좌표를 마지막으로 한 번 더 반영한다. pointercancel 은 제외한다 —
    // OS 가 제스처를 물린 것이라 그 좌표에는 의미가 없다.
    if (e.type === "pointerup") applyDragAt(d, toOriented(e), e.shiftKey);

    if (d.mode === "crop") {
      s.onCropUp();
      return;
    }
    if (d.mode === "marquee") {
      const r = marqueeRect(d);
      // 3px 미만은 클릭 오조작 — 선택 해제는 이미 pointerdown 에서 했다(종전 동작 보존).
      if (r.w >= MIN_DRAG || r.h >= MIN_DRAG) {
        const ids = new Set(d.keep);
        // "닿으면 선택"(Figma 규칙) — objectAABB 교차라 새 기하 코드가 0이다.
        // 마퀴도 씬을 본다 — 숨긴 노드가 "닿으면 선택"으로 되살아나지 않게.
        for (const o of s.scene.nodes) {
          if (!s.scene.flags.get(o.id)?.locked && rectsOverlap(r, objectAABB(o))) ids.add(o.id);
        }
        s.onSelectionChange([...ids]);
      }
      schedule();
      return;
    }
    if (d.mode === "erase") {
      // 지운 게 없으면 커밋도 없다 — 빈 히스토리 항목이 쌓이면 Ctrl+Z 가 몇 번은
      // 아무 일도 안 하는 것처럼 보인다.
      if (d.ids.size) commitObjects(remove(s.objects, [...d.ids]), "지우개");
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
    // 더블클릭은 그룹 안으로 들어간다(deep) — 텍스트를 바로 편집할 수 있어야 한다.
    const hitId = hitTest(s.scene, x, y, s.displayScale, { deep: true });
    if (!hitId) return;
    const o = s.scene.nodes.find((n) => n.id === hitId);
    if (o && o.kind === "text") beginEditing(o, false);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onDoubleClick };
}
