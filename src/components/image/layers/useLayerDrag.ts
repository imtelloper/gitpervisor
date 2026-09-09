// 레이어 행 드래그 — 순서·부모 바꾸기. `FileTreePanel.tsx:733-889` 의 포인터 드래그 관례를
// 그대로 옮긴 것이다(임계 5px · `elementFromPoint` · `window` 리스너 · click 억제).
//
// **Escape 만은 관례를 못 따른다**: 파일 트리는 자기 `window` keydown 리스너로 취소하지만,
// 편집기 안에서는 `useEditorKeys` 의 window **capture** 리스너가 Escape 를 먼저 잡아
// `stopImmediatePropagation` 한다 — 버블 단계의 리스너는 한 번도 호출되지 않는다.
// 그래서 취소가 조용히 죽고, Esc 로 선택만 비워진 뒤 손을 떼는 순간 이동이 커밋된다.
// 취소는 `cancelDrag()` 로 내보내고 42 의 단일 리스너(ImageEditor `escape()`)가 부른다.
//
// **HTML5 DnD 를 쓰지 않는 이유**: 편집기가 사는 doc 창 빌더에는 메인 창의
// `.disable_drag_drop_handler()` 가 없어 Windows(WebView2) OS 핸들러가 drop 을 가로챈다 —
// `dragstart` 는 뜨는데 `drop` 이 영영 안 온다. 게다가 고스트·자동 스크롤·Escape 취소는
// 어느 쪽이든 직접 만들어야 한다.
//
// **리스너는 `window` 이고 포인터 캡처를 쓰지 않는다**. 캡처하면 스크롤 컨테이너가 포인터를
// 못 받아 가장자리 자동 스크롤이 브라우저 몫에서 사라지는데, 여기서는 어차피 rAF 로 직접
// 민다 — 포인터가 가장자리에서 **멈춰 있으면** pointermove 가 더 오지 않아, 이동 이벤트에
// 스크롤을 얹는 파일 트리 방식으로는 목록이 그 자리에서 굳는다.
//
// 드래그 중 React state 는 0 이다. 고스트는 자기 state, 표시선·행 하이라이트는 DOM 직접
// 조작 — 프레임마다 행 수백 개를 다시 그리지 않으려는 파일 트리와 같은 이유다.
//
// 배경: DOCS/task/44-image-panels.md §3.5

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  dropTarget,
  type DropTarget,
  type LayerRow as Row,
} from "../../../lib/annotate/layer-rows";
import { nodeOf } from "../../../lib/annotate/tree";
import type { Node, ObjId } from "../../../lib/annotate/types";
import { useImageEditorUi } from "../../../stores/imageEditor";
import type { DragGhostHandle } from "../../common/DragGhost";
import { ROW_H } from "./LayerRow";

/** 드롭 대상 컨테이너 행 하이라이트 — 문자열 리터럴이라 Tailwind JIT 가 클래스를 만든다. */
const DROP_HL = ["ring-1", "ring-inset", "ring-accent", "bg-accent/15"];
/** 이 거리를 넘어야 드래그다. 그 전에는 평범한 클릭 후보 — 낮추면 클릭이 죽는다. */
const THRESHOLD = 5;
/** 컨테이너 위아래 이 폭 안에 포인터가 있으면 자동 스크롤. */
const EDGE = 28;
const SCROLL_STEP = 10;

export interface LayerDrag {
  onRowPointerDown(e: ReactPointerEvent, row: Row): void;
  /** 진행 중인 드래그를 버린다 — 실제로 취소했으면 true(Esc 를 여기서 소비). */
  cancelDrag(): boolean;
  /** 패널이 `<DragGhost ref={…}/>` 에 그대로 단다. */
  ghostRef: RefObject<DragGhostHandle | null>;
  /** 드롭 표시선 — 스크롤 컨테이너 안 `absolute` 자식이어야 위치가 내용과 함께 스크롤된다. */
  indicatorRef: RefObject<HTMLDivElement | null>;
}

interface DragState {
  startX: number;
  startY: number;
  active: boolean;
  canceled: boolean;
  ids: ObjId[];
  label: string;
  lastX: number;
  lastY: number;
  target: DropTarget | null;
  overEl: HTMLElement | null;
  raf: number;
  cleanup(): void;
}

export function useLayerDrag(
  containerRef: RefObject<HTMLElement | null>,
  getRows: () => readonly Row[],
  getObjects: () => readonly Node[],
  onDrop: (target: DropTarget, ids: ObjId[]) => void,
): LayerDrag {
  const ghostRef = useRef<DragGhostHandle | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // 인자는 전부 ref 로 본다. 반환하는 `onRowPointerDown` 이 매 렌더 새 함수가 되면 행의
  // `memo` 가 통째로 풀려, 선택 한 번에 목록 전체가 다시 그려진다(이 훅이 있는 이유가 사라진다).
  const env = useRef({ containerRef, getRows, getObjects, onDrop });
  env.current = { containerRef, getRows, getObjects, onDrop };

  // 드래그 도중 패널이 언마운트되면(탭 전환·편집기 닫기) 리스너·고스트·`body.userSelect` 가
  // 남는다 — 그 뒤로는 앱 어디서도 글자를 선택할 수 없다.
  useEffect(() => () => dragRef.current?.cleanup(), []);

  const onRowPointerDown = useCallback((e: ReactPointerEvent, row: Row): void => {
    // 배경 행은 문서 노드가 아니라 옮길 것이 없다.
    if (e.button !== 0 || dragRef.current || row.node === null) return;

    const rowName = (id: ObjId): string => {
      const { getRows: rows, getObjects: objects } = env.current;
      return rows().find((r) => r.id === id)?.name ?? nodeOf(objects(), id)?.name ?? "그룹";
    };

    /** 표시선·하이라이트·고스트를 지금 상태에 맞춘다. 스크롤 뒤에도 같은 좌표로 다시 부른다. */
    const apply = (): void => {
      const st = dragRef.current;
      const cont = env.current.containerRef.current;
      if (!st?.active || !cont) return;

      const el = document.elementFromPoint(st.lastX, st.lastY) as HTMLElement | null;
      const rowEl =
        el && cont.contains(el) ? (el.closest("[data-layer-id]") as HTMLElement | null) : null;
      let target: DropTarget | null = null;
      if (rowEl) {
        const rows = env.current.getRows();
        const hit = rows.find((r) => r.id === rowEl.dataset.layerId);
        if (hit) {
          // 화면 안 행의 rect 만 읽는다 — 화면 밖 행은 `content-visibility:auto` 라 0 이 나온다.
          const r = rowEl.getBoundingClientRect();
          const ratio = r.height > 0 ? (st.lastY - r.top) / r.height : 0.5;
          target = dropTarget(
            rows,
            env.current.getObjects(),
            st.ids,
            hit,
            Math.min(1, Math.max(0, ratio)),
          );
        }
      }
      st.target = target;

      const hl = target?.pos === "inside" ? rowEl : null;
      if (st.overEl !== hl) {
        st.overEl?.classList.remove(...DROP_HL);
        hl?.classList.add(...DROP_HL);
        st.overEl = hl;
      }

      const bar = indicatorRef.current;
      if (bar) {
        if (target && target.pos !== "inside" && rowEl) {
          // `offsetTop` 은 컨테이너(position:relative) 기준이라 스크롤 위치와 무관하다.
          bar.style.display = "block";
          bar.style.top = `${rowEl.offsetTop + (target.pos === "after" ? ROW_H : 0) - 1}px`;
          // 들여쓰기를 물려받아야 "어느 깊이로 들어가는지"가 선만 보고도 읽힌다.
          bar.style.left = rowEl.style.paddingLeft || "0px";
        } else {
          bar.style.display = "none";
        }
      }

      ghostRef.current?.update({
        x: st.lastX,
        y: st.lastY,
        label: st.ids.length > 1 ? `${st.ids.length}개 항목` : st.label,
        dest: target ? (target.parentId ? `${rowName(target.parentId)} 안` : "최상위") : null,
      });
    };

    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      const st = dragRef.current;
      if (!st || st.canceled) return;
      st.lastX = ev.clientX;
      st.lastY = ev.clientY;
      if (!st.active) {
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < THRESHOLD) return;
        st.active = true;
        // 잡은 행이 선택 안에 있으면 선택 전체를 끈다. `reparent` 가 조상·자손이 섞인
        // 목록을 스스로 정리하므로(tree.ts `extract`) 여기서 더 거를 것은 없다.
        const sel = useImageEditorUi
          .getState()
          .selectedIds.filter(
            (id): id is ObjId => id !== "__base" && nodeOf(env.current.getObjects(), id) !== null,
          );
        st.ids = sel.includes(row.id as ObjId) ? sel : [row.id as ObjId];
        document.body.style.userSelect = "none";
      }
      apply();
    };

    const onUp = () => {
      const st = dragRef.current;
      if (!st) return;
      const { active, target, ids } = st;
      st.cleanup();
      if (!active) return;
      // 드래그로 끝난 pointerup 뒤의 click 이 행 선택을 바꾸지 않게 한 번 삼킨다.
      const suppress = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
        window.removeEventListener("click", suppress, true);
      };
      window.addEventListener("click", suppress, true);
      setTimeout(() => window.removeEventListener("click", suppress, true), 120);
      if (target) env.current.onDrop(target, ids);
    };

    // 터치·펜 제스처가 가로채면 pointerup 없이 pointercancel 만 온다. Alt+Tab 으로 포커스를
    // 잃은 뒤 돌아와도 마찬가지 — 남겨 두면 복귀 후 첫 pointerup 이 옛 드래그를 커밋한다.
    const onCancel = () => dragRef.current?.cleanup();

    const tick = () => {
      const st = dragRef.current;
      const cont = env.current.containerRef.current;
      if (!st || !cont) return;
      st.raf = requestAnimationFrame(tick);
      if (!st.active || st.canceled) return;
      const r = cont.getBoundingClientRect();
      const before = cont.scrollTop;
      if (st.lastY < r.top + EDGE) cont.scrollTop -= SCROLL_STEP;
      else if (st.lastY > r.bottom - EDGE) cont.scrollTop += SCROLL_STEP;
      // 내용이 움직였으면 포인터 아래 행이 바뀐 것이다 — 표시선을 다시 잡는다.
      if (cont.scrollTop !== before) apply();
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      const st = dragRef.current;
      if (st) cancelAnimationFrame(st.raf);
      st?.overEl?.classList.remove(...DROP_HL);
      if (indicatorRef.current) indicatorRef.current.style.display = "none";
      ghostRef.current?.update(null);
      document.body.style.userSelect = "";
      dragRef.current = null;
    };

    dragRef.current = {
      startX,
      startY,
      active: false,
      canceled: false,
      ids: [row.id as ObjId],
      label: row.name,
      lastX: startX,
      lastY: startY,
      target: null,
      overEl: null,
      raf: requestAnimationFrame(tick),
      cleanup,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  }, []);

  const cancelDrag = useCallback((): boolean => {
    const st = dragRef.current;
    if (!st) return false;
    if (!st.active) {
      // 임계값 전이면 아직 평범한 클릭이다 — 정리만 하고 Esc 는 원래 계층으로 흘려보낸다.
      st.cleanup();
      return false;
    }
    // 시각 요소만 즉시 걷고 리스너는 남긴다 — 여기서 통째로 걷으면 뒤따르는 pointerup 의
    // click 이 밑에 있던 행을 선택해 버린다(파일 트리와 같은 이유).
    st.canceled = true;
    st.target = null;
    st.overEl?.classList.remove(...DROP_HL);
    st.overEl = null;
    if (indicatorRef.current) indicatorRef.current.style.display = "none";
    ghostRef.current?.update(null);
    return true;
  }, []);

  return { onRowPointerDown, cancelDrag, ghostRef, indicatorRef };
}
