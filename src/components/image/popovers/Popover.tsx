// 앵커 팝오버 프리미티브 — 색 피커·그라디언트·블렌드·효과·아이드로퍼·폰트·색 스타일·레이어
// 타입 필터가 전부 이 껍데기 위에 콘텐츠만 얹는다.
//
// 세 가지가 이 파일 밖으로 새면 안 된다:
//
//   1) **열린 팝오버 스택.** `hasOpenPopover()` 를 42 키 스코프(`useEditorKeys` 의 `popoverOpen`)가
//      부르고, `closeTopPopover()` 를 `ImageEditor` 의 `escape()` 가 **가장 먼저** 부른다.
//      React 컨텍스트로는 그 둘 다 못 읽어서(훅 밖·이벤트 콜백 안) 모듈 레벨 배열이다.
//      등록 해제를 빠뜨리면 닫힌 팝오버가 영원히 "열림"으로 남아 **편집기 단축키가 통째로 죽는다** —
//      그래서 등록은 이펙트 하나에서만 하고 해제는 그 정리 함수가 반드시 한다.
//      스택인 이유: 그라디언트 편집기 위에 스톱 색 피커가 열린다. Esc 는 맨 위 하나만 닫아야 한다.
//
//   2) **좌표 클램프.** 인스펙터(오른쪽 끝 320)의 스와치에서 열면 기본 배치가 화면 밖이다.
//      크기를 재고(첫 렌더는 `visibility:hidden`) 안 들어가면 반대쪽으로 뒤집은 뒤 클램프한다.
//
//   3) **`useOccludesWebview`.** 네이티브 자식 webview 는 DOM 과 z-합성되지 않고 항상 위에
//      그려진다 — 등록하지 않으면 팝오버 아래 브라우저가 클릭을 가로챈다.
//
// z 는 `z-50` 이다. 편집기 루트(`fixed inset-0 z-50`)가 만든 스택 컨텍스트 안이라 확인창
// `z-[60]`·토스트 `z-[55]` 위로 못 올라간다. **`z-[60]` 을 쓰지 마라** — e2e 34 `A.overlay` 가
// 그 클래스로 확인창을 판별해서 팝오버가 확인창으로 잡힌다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.7

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import { useOccludesWebview } from "../../../stores/occlusion";

/** 열린 순서대로 쌓인 닫기 콜백. 마지막이 맨 위. */
const stack: { close: () => void }[] = [];

/** 42 Esc 계층 0단계 — 맨 위 팝오버만 닫는다. 열린 게 없으면 `false`(다음 단계로). */
export function closeTopPopover(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  // 여기서 스택을 건드리지 않는다. 실제 제거는 언마운트 정리가 한다 — 호출부가 `onClose` 를
  // 무시해 팝오버가 그대로 떠 있는 경우에도 "열려 있다"가 화면과 어긋나지 않아야 한다.
  top.close();
  return true;
}

/** 42 키 스코프 게이트 — 열려 있는 동안 Escape 외 편집기 단축키는 통과한다. */
export function hasOpenPopover(): boolean {
  return stack.length > 0;
}

type Placement = "bottom-start" | "left-start" | "right-start";

interface PopoverProps {
  anchor: DOMRect | HTMLElement;
  open: boolean;
  onClose(): void;
  placement?: Placement;
  width?: number;
  /** 기본 true. false = 백드롭 없음 — 바깥 클릭이 캔버스로 통과한다(그라디언트 핸들·아이드로퍼). */
  modal?: boolean;
  title?: ReactNode;
  children: ReactNode;
}

const GAP = 6;
const MARGIN = 8;

function anchorRect(a: DOMRect | HTMLElement): DOMRect {
  // `instanceof HTMLElement` 는 doc 창처럼 realm 이 다르면 거짓이 된다 — DOMRect 에 없는
  // 속성으로 가른다.
  return "nodeType" in a ? a.getBoundingClientRect() : a;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function place(a: DOMRect, box: DOMRect, placement: Placement): { left: number; top: number } {
  let left = a.left;
  let top = a.bottom + GAP;
  if (placement === "left-start") {
    left = a.left - box.width - GAP;
    top = a.top;
  } else if (placement === "right-start") {
    left = a.right + GAP;
    top = a.top;
  }

  // 뒤집기를 클램프보다 **먼저** 한다. 클램프만 하면 팝오버가 앵커를 덮어, 방금 누른
  // 스와치가 자기가 연 팝오버 밑으로 사라진다.
  const fitsAbove = a.top - box.height - GAP >= MARGIN;
  if (placement === "bottom-start" && top + box.height > window.innerHeight - MARGIN && fitsAbove) {
    top = a.top - box.height - GAP;
  }
  if (placement === "left-start" && left < MARGIN) {
    left = a.right + GAP;
  } else if (
    placement === "right-start" &&
    left + box.width > window.innerWidth - MARGIN &&
    a.left - box.width - GAP >= MARGIN
  ) {
    left = a.left - box.width - GAP;
  }

  return {
    left: clamp(left, MARGIN, window.innerWidth - box.width - MARGIN),
    top: clamp(top, MARGIN, window.innerHeight - box.height - MARGIN),
  };
}

export function Popover({
  anchor,
  open,
  onClose,
  placement = "bottom-start",
  width,
  modal = true,
  title,
  children,
}: PopoverProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useOccludesWebview(open);

  // 스택 등록은 최신 `onClose` 를 ref 로 본다 — 콜백이 매 렌더 새 함수라 의존성에 넣으면
  // 등록·해제가 렌더마다 돌고 그 사이에 온 Esc 가 아무것도 못 닫는다.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { close: () => closeRef.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null); // 다시 열릴 때 옛 좌표로 한 프레임 튀지 않게
      return;
    }
    const el = boxRef.current;
    if (!el) return;
    const apply = () => {
      const next = place(anchorRect(anchor), el.getBoundingClientRect(), placement);
      // 값이 같으면 새 객체를 넣지 않는다 — 호출부가 매 렌더 새 DOMRect 를 만들면
      // setState → 렌더 → 이펙트 재실행이 무한히 돈다.
      setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
    };
    apply();
    // 탭 전환·목록 필터로 내용 높이가 바뀌면 아래로 넘칠 수 있다 — 크기 변화도 본다.
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [open, anchor, placement, width]);

  const prevFocusRef = useRef<HTMLElement | null>(null);
  const didFocusRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    didFocusRef.current = false;
    return () => {
      // 닫히면 포커스를 원래 자리(앵커 = 편집기 루트 안)로 돌려준다. `body` 로 떨어지면
      // 편집기가 키 이벤트를 못 받는 게 아니라 — window 리스너라 받긴 한다 — 탭 이동이
      // 문서 맨 앞부터 다시 시작한다.
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev?.isConnected) prev.focus();
    };
  }, [open]);

  /**
   * 첫 입력에 포커스를 준다 — **위치가 정해진 뒤에**.
   *
   * 크기를 재기 전 한 프레임은 `visibility: hidden` 인데(아래 style), 브라우저는 보이지 않는
   * 요소에 `focus()` 를 **조용히 무시한다**. 예외도 로그도 없다. 그래서 `[open]` 에서 한 번만
   * 부르면 팝오버가 열려도 포커스가 편집기 루트에 그대로 남고, 키보드로는 색을 못 친다.
   * 2026-09-09 e2e (ins-7g) 가 이걸 잡았다.
   *
   * `didFocusRef` 로 한 번만 잡는다 — `pos` 는 리사이즈·스크롤로도 바뀌므로, 그때마다 다시
   * 부르면 사용자가 다른 칸을 치고 있는데 커서가 첫 입력으로 튕겨 간다.
   */
  useEffect(() => {
    if (!open || !pos || didFocusRef.current) return;
    didFocusRef.current = true;
    const el = boxRef.current;
    (el?.querySelector<HTMLElement>("input, textarea, select") ?? el)?.focus();
  }, [open, pos]);

  if (!open) return null;

  const body = (
    <div
      ref={boxRef}
      role="dialog"
      tabIndex={-1}
      onKeyDown={(e) => {
        // 안전망이다. 포커스가 팝오버 안 입력 요소에 있으면 42 캡처 리스너가
        // `inTextField()` 에서 먼저 빠져나가 Escape 가 `closeTopPopover()` 까지 못 간다.
        // 반대로 입력 밖이면 42 가 `stopImmediatePropagation` 으로 끊어 여기까지 오지 않는다 —
        // 두 경로가 겹쳐 두 번 닫히는 일은 없다.
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width,
        maxHeight: window.innerHeight - MARGIN * 2,
        // 크기를 재기 전 한 프레임은 (0,0)에 있다 — 그 자리에서 보이면 안 된다.
        visibility: pos ? undefined : "hidden",
      }}
      className="fixed z-50 flex flex-col overflow-y-auto rounded-md border border-edge bg-panel text-[12px] text-fg shadow-xl"
    >
      {title != null && (
        <div className="flex items-center justify-between gap-2 border-b border-edge px-2 py-1.5 text-fg-muted">
          <span className="truncate">{title}</span>
          <button
            onClick={onClose}
            title="닫기"
            className="shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="p-2">{children}</div>
    </div>
  );

  // 반환 **모양**은 `modal` 과 무관하게 고정이다(항상 프래그먼트 2칸). `!modal` 일 때 `body`
  // 하나만 돌려주면 React 가 프래그먼트↔단일 엘리먼트를 다른 트리로 보고 자식을 통째로
  // 언마운트한다. 색 피커의 스포이드는 켜지는 순간 `modal` 을 false 로 바꾸므로(백드롭이
  // 캔버스 클릭을 먼저 먹으면 색을 한 번도 못 뽑는다) 그 한 번의 언마운트가 **방금 시작한
  // 세션을 정리 함수로 죽이고** 도구까지 되돌린다 — 버튼을 눌러도 아무 일이 없고, 덤으로
  // 색 피커의 로컬 HSV 와 hex 초안이 초기화된다.
  return (
    <>
      {/* 백드롭이 바깥 클릭을 삼켜 닫는다. 이게 없으면 캔버스가 그 클릭을 받아 선택이
          바뀌거나 도형이 그려진다. 앵커 재클릭도 여기서 먹히므로 호출부는 토글을 짤 필요가
          없다 — 열기만 하면 된다. 팝오버 본체는 백드롭의 **형제**라 이벤트가 섞이지 않는다. */}
      {modal && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={onClose}
          onContextMenu={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
      )}
      {body}
    </>
  );
}
