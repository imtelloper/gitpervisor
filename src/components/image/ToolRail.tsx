// 툴 레일(시안 좌측 56px) — `.pen` 순서 23항목 + 하단 색 스와치.
//
// 표(`TOOLS`)가 하나뿐인 이유: 라벨·단축키·아이콘·플라이아웃·소유 태스크가 흩어지면 툴팁과
// 실제 키가 조용히 어긋난다. 버튼 `title` 은 **반드시 `"<라벨> (<키>)"`** 다 — e2e 30 의
// `activeTool` 헬퍼가 이 문자열을 정규식으로 읽어 활성 도구를 판정하고, 활성 여부는
// `text-accent` **클래스**로 읽는다. 그래서 비활성 버튼에 `hover:text-accent` 를 쓰면 안 된다:
// 클래스 문자열만 보므로 호버 색 하나로 모든 버튼이 "활성"이 되어 스위트가 통째로 빨개진다.
//
// **`ready` 가 아닌 항목은 렌더하지 않는다**(INDEX §10.4 "없는 기능은 안 보인다"). 표에는
// 23행이 다 있고 소유 태스크가 도착하면 그 행의 `ready` 만 true 로 바꾼다 — 순서·아이콘·키를
// 그때 다시 정하지 않게 하려고 미리 적어 둔다. 플라이아웃 항목에도 같은 규칙을 건다:
// 아무것도 안 하는 도구로 가는 캐럿은 고장으로 읽힌다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.5

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowUpRight,
  Circle,
  Crop,
  Droplet,
  Eraser,
  Frame,
  Grid3x3,
  Hand,
  Hash,
  Highlighter,
  ImageIcon,
  MessageSquare,
  Minus,
  MousePointer2,
  Move,
  Pencil,
  Pentagon,
  PenTool,
  Pipette,
  Ruler,
  Slice,
  Spline,
  Square,
  Type,
  type LucideIcon,
} from "lucide-react";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import type { DefaultPaint } from "../../lib/annotate/types";
import { useImageEditorUi, type Mode, type Tool } from "../../stores/imageEditor";
import { useOccludesWebview } from "../../stores/occlusion";

export interface RailItem {
  /** 레일 항목은 도구가 아닐 수도 있다 — 크롭은 모드, 곡률은 토글이다(§3.2). */
  id: Tool | "crop" | "curvature";
  /** 툴팁에 그대로 박히는 단축키 표기. 대안 키는 적지 않는다(e2e 정규식이 한 토큰만 읽는다). */
  key: string | null;
  icon: LucideIcon;
  /** 캐럿(▾) 항목의 하위 도구. 우클릭·300ms 길게 누름으로 열린다. */
  flyout?: readonly Tool[];
  /** 이 항목의 **동작**을 구현하는 태스크. */
  owner: number;
  ready: boolean;
}

/** `.pen` 레일 순서 그대로. 형광펜은 레일에 없고 펜 플라이아웃에만 있다(§3.5). */
export const TOOLS: readonly RailItem[] = [
  { id: "select", key: "V", icon: MousePointer2, owner: 42, ready: true },
  { id: "scale", key: "K", icon: Move, owner: 42, ready: true },
  { id: "frame", key: "F", icon: Frame, flyout: ["slice"], owner: 42, ready: true },
  { id: "vpen", key: "P", icon: PenTool, flyout: ["pen", "highlight"], owner: 47, ready: true },
  { id: "curvature", key: null, icon: Spline, owner: 47, ready: true },
  { id: "pen", key: "Shift+P", icon: Pencil, owner: 42, ready: true },
  { id: "eraser", key: "E", icon: Eraser, owner: 42, ready: true },
  { id: "rect", key: "R", icon: Square, flyout: ["polygon", "line", "arrow"], owner: 42, ready: true },
  { id: "ellipse", key: "O", icon: Circle, owner: 42, ready: true },
  { id: "polygon", key: null, icon: Pentagon, owner: 46, ready: true },
  { id: "line", key: "L", icon: Minus, owner: 42, ready: true },
  { id: "arrow", key: "A", icon: ArrowUpRight, owner: 42, ready: true },
  { id: "text", key: "T", icon: Type, owner: 42, ready: true },
  { id: "image", key: null, icon: ImageIcon, owner: 42, ready: true },
  { id: "badge", key: "N", icon: Hash, owner: 42, ready: true },
  { id: "callout", key: null, icon: MessageSquare, owner: 46, ready: true },
  { id: "mosaic", key: "M", icon: Grid3x3, flyout: ["blur"], owner: 42, ready: true },
  { id: "blur", key: null, icon: Droplet, owner: 42, ready: true },
  { id: "eyedropper", key: "I", icon: Pipette, owner: 45, ready: false },
  { id: "measure", key: null, icon: Ruler, owner: 43, ready: false },
  { id: "crop", key: "C", icon: Crop, owner: 42, ready: true },
  { id: "slice", key: "S", icon: Slice, owner: 52, ready: false },
  { id: "hand", key: "Space", icon: Hand, owner: 42, ready: true },
];

/** 레일에는 없고 플라이아웃에만 있는 항목 — 지금은 형광펜 하나다. */
const FLYOUT_ONLY: readonly RailItem[] = [
  { id: "highlight", key: "H", icon: Highlighter, owner: 42, ready: true },
];

/** 라벨은 표 밖에서 UI 언어로 고른다 — 표는 모듈 최상위라 언어가 바뀌어도 다시 계산되지 않는다. */
function toolLabel(msg: Messages, id: RailItem["id"]): string {
  const t = msg.imageEditor.toolRail;
  const labels: Record<RailItem["id"], string> = {
    select: t.select,
    scale: t.scale,
    frame: t.frame,
    vpen: t.vpen,
    curvature: t.curvature,
    pen: t.pen,
    eraser: t.eraser,
    rect: t.rect,
    ellipse: t.ellipse,
    polygon: t.polygon,
    line: t.line,
    arrow: t.arrow,
    text: t.text,
    image: t.image,
    badge: t.badge,
    callout: t.callout,
    mosaic: t.mosaic,
    blur: t.blur,
    eyedropper: t.eyedropper,
    measure: t.measure,
    crop: t.crop,
    slice: t.slice,
    hand: t.hand,
    highlight: t.highlight,
  };
  return labels[id];
}

const BY_ID = new Map<string, RailItem>(
  [...TOOLS, ...FLYOUT_ONLY].map((t) => [t.id, t]),
);

export interface ToolRailHandle {
  /** 플라이아웃이 열려 있었으면 닫고 `true`. Esc 계층 0 — `useEditorKeys` 의 `popoverOpen` 짝. */
  closeFlyout(): boolean;
  isFlyoutOpen(): boolean;
}

export interface ToolRailProps {
  /**
   * 클릭 뒤 편집기 루트로 포커스를 되돌린다. 안 하면 포커스가 방금 누른 버튼에 남아
   * **Space 가 손 도구 대신 그 버튼을 다시 누른다**(§3.3 루트 포커스).
   */
  onFocusRoot: () => void;
  /** 하단 스와치가 보여 줄 "다음에 만들 객체"의 페인트 — Front=선 · Back=채우기. */
  paint: DefaultPaint;
  /**
   * '이미지' 항목의 동작. 도구 상태로 남지 않는 **한 번의 동작**이라 여기서 setTool 하지
   * 않는다 — `tool==='image'` 로 두면 캔버스가 드래프트를 못 만들어 클릭·드래그가 전부
   * 조용한 no-op 이 된다. 파일 선택·에셋 등록·커밋은 편집기가 한다(§3.5).
   */
  onPlaceImage: () => void;
  /**
   * 플라이아웃 제어 핸들. `useEditorKeys` 의 window capture 리스너가 Escape 를 먼저 먹으므로
   * 이 컴포넌트 안에서는 Esc 를 볼 수 없다 — 편집기가 이 핸들로 계층 0을 처리한다.
   */
  handleRef?: RefObject<ToolRailHandle | null>;
  /**
   * 레일에 둘 항목과 순서(PDF 주석 모드). 주면 **정확히 이 목록**만(ready 인 것) 이 순서로 놓고
   * 플라이아웃은 비운다 — 플라이아웃 전용 형광펜도 레일로 올라오고, 사각형 캐럿의 직선·화살표가
   * 레일 버튼과 겹치지 않는다. 없으면 종전 레일 그대로다(e2e 30·53 이 title·클래스를 읽는다).
   */
  tools?: readonly RailItem["id"][];
}

/** 표시할 플라이아웃 항목 — 소유 태스크가 없는 도구는 뺀다(캐럿 자체가 사라진다). */
function flyoutItems(item: RailItem, tools?: readonly RailItem["id"][]): RailItem[] {
  if (tools) return [];
  const out: RailItem[] = [];
  for (const id of item.flyout ?? []) {
    const meta = BY_ID.get(id);
    if (meta?.ready) out.push(meta);
  }
  return out;
}

function isActive(item: RailItem, tool: Tool, mode: Mode, curvature: boolean): boolean {
  if (item.id === "crop") return mode.kind === "crop";
  if (item.id === "curvature") return curvature;
  // 크롭 중에는 도구 키가 무시되므로(§3.2) 직전 도구까지 같이 강조하면 둘 다 켜진 것처럼 보인다.
  return mode.kind !== "crop" && tool === item.id;
}

function titleOf(msg: Messages, item: RailItem): string {
  const label = toolLabel(msg, item.id);
  return item.key ? `${label} (${item.key})` : label;
}

const BTN = "relative flex h-9 w-9 shrink-0 items-center justify-center rounded";
const ON = "bg-accent/20 text-accent";
const OFF = "text-fg-muted hover:bg-raised hover:text-fg";

export default function ToolRail({
  onFocusRoot,
  paint,
  handleRef,
  onPlaceImage,
  tools,
}: ToolRailProps) {
  const msg = useMessages();
  const tool = useImageEditorUi((s) => s.tool);
  const mode = useImageEditorUi((s) => s.mode);
  const curvature = useImageEditorUi((s) => s.toggles.curvature);
  const setTool = useImageEditorUi((s) => s.setTool);
  const setMode = useImageEditorUi((s) => s.setMode);
  const setToggle = useImageEditorUi((s) => s.setToggle);
  const setTab = useImageEditorUi((s) => s.setTab);

  const [flyout, setFlyout] = useState<{ items: RailItem[]; x: number; y: number } | null>(null);
  // 네이티브 자식 webview(내장 브라우저)는 항상 DOM 위에 그려진다 — 열려 있는 동안 점유를
  // 등록해 숨긴다(ViewerFileTabs 우클릭 메뉴와 같은 계약).
  useOccludesWebview(!!flyout);

  const openRef = useRef(false);
  openRef.current = !!flyout;
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      isFlyoutOpen: () => openRef.current,
      closeFlyout: () => {
        if (!openRef.current) return false;
        setFlyout(null);
        return true;
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  // 길게 누름 타이머와 "이번 클릭은 플라이아웃이 먹었다" 표시. 후자가 없으면 손을 뗄 때
  // click 이 이어서 발화해 플라이아웃을 연 그 버튼의 도구가 함께 선택된다.
  const holdRef = useRef<number | null>(null);
  const heldRef = useRef(false);

  const cancelHold = () => {
    if (holdRef.current !== null) window.clearTimeout(holdRef.current);
    holdRef.current = null;
  };
  useEffect(() => cancelHold, []);

  const openFlyout = (item: RailItem, el: HTMLElement) => {
    const items = flyoutItems(item, tools);
    if (items.length === 0) return;
    const r = el.getBoundingClientRect();
    setFlyout({ items, x: r.right + 4, y: r.top });
  };

  // 레일 항목이 전부 도구인 것은 아니다 — 크롭은 모드, 곡률은 토글, 이미지는 그 자리에서
  // 끝나는 동작이다(§3.2·§3.5).
  const activate = (item: RailItem) => {
    if (item.id === "crop") setMode({ kind: "crop" });
    else if (item.id === "curvature") setToggle("curvature", !curvature);
    else if (item.id === "image") onPlaceImage();
    else {
      // 크롭은 **모드**라 도구를 고르는 것만으로는 안 빠져나온다. 안 빠져나오면
      // `onPointerDown` 첫 줄의 크롭 분기가 모든 클릭을 삼켜(`pointer.ts`) 무슨 도구를
      // 골라도 아무 일이 안 일어난다 — 배너는 떠 있지만 방금 도구를 고른 사람에게는
      // "도구가 고장났다"로 보인다. 도구를 고른 것 = 크롭을 그만두겠다는 뜻으로 읽는다.
      if (mode.kind === "crop") setMode({ kind: "design" });
      setTool(item.id);
    }
    onFocusRoot();
  };

  const rail = tools
    ? tools.flatMap((id) => {
        const t = BY_ID.get(id);
        return t?.ready ? [t] : [];
      })
    : TOOLS.filter((t) => t.ready);
  const stroke = paint.strokes.find((f) => f.visible);
  const strokeColor = stroke && stroke.type === "solid" ? stroke.color : null;
  const fill = paint.fills.find((f) => f.visible);
  const fillColor = fill && fill.type === "solid" ? fill.color : null;

  return (
    <>
      {/*
        방향키 이동(roving tabindex)을 달지 않는다 — 편집기에서 방향키는 선택 객체의 1px
        미세 이동이고, 레일에 포커스가 남은 채로 누르면 그 이동이 조용히 죽는다.
      */}
      <div
        role="toolbar"
        aria-label={msg.imageEditor.toolRail.ariaLabel}
        aria-orientation="vertical"
        className="flex w-14 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-edge bg-panel py-1.5"
      >
        {rail.map((item) => {
          const on = isActive(item, tool, mode, curvature);
          const hasFlyout = flyoutItems(item, tools).length > 0;
          return (
            <button
              key={item.id}
              title={titleOf(msg, item)}
              aria-pressed={on}
              onClick={() => {
                if (heldRef.current) {
                  heldRef.current = false;
                  return;
                }
                activate(item);
              }}
              onContextMenu={(e) => {
                if (!hasFlyout) return;
                e.preventDefault();
                e.stopPropagation();
                openFlyout(item, e.currentTarget);
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || !hasFlyout) return;
                const el = e.currentTarget;
                heldRef.current = false;
                holdRef.current = window.setTimeout(() => {
                  holdRef.current = null;
                  heldRef.current = true;
                  openFlyout(item, el);
                }, 300);
              }}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
              className={`${BTN} ${on ? ON : OFF}`}
            >
              <item.icon size={17} />
              {hasFlyout && (
                <span className="pointer-events-none absolute bottom-0 right-0.5 text-[8px] leading-none">
                  ▾
                </span>
              )}
            </button>
          );
        })}

        {/*
          색 스와치 — Front(선)가 Back(채우기) 위에 겹친다. 여기서 색을 고르지는 않는다:
          피커 팝오버는 45 가 붙이고, 지금은 속성 탭으로 보내는 것이 전부다.
        */}
        <button
          title={msg.imageEditor.toolRail.swatchTitle}
          onClick={() => {
            setTab("inspector", "props");
            onFocusRoot();
          }}
          className="relative mt-auto h-9 w-9 shrink-0 rounded hover:bg-raised"
        >
          <span
            style={fillColor ? { background: fillColor } : undefined}
            className={`absolute bottom-1 right-1 h-4 w-4 rounded-[2px] border ${
              fillColor ? "border-edge" : "border-dashed border-fg-dim"
            }`}
          />
          <span
            style={strokeColor ? { background: strokeColor } : undefined}
            className={`absolute left-1 top-1 h-4 w-4 rounded-[2px] border ${
              strokeColor ? "border-edge" : "border-dashed border-fg-dim"
            }`}
          />
        </button>
      </div>

      {flyout && (
        // 백드롭이 바깥 클릭·우클릭을 삼켜 닫는다(브라우저 기본 메뉴도 막는다).
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => {
            setFlyout(null);
            onFocusRoot();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setFlyout(null);
            onFocusRoot();
          }}
        >
          <div
            className="fixed min-w-36 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
            style={{
              left: Math.min(flyout.x, window.innerWidth - 160),
              top: Math.min(flyout.y, window.innerHeight - (flyout.items.length * 28 + 8)),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {flyout.items.map((sub) => (
              <button
                key={sub.id}
                title={titleOf(msg, sub)}
                onClick={() => {
                  setFlyout(null);
                  activate(sub);
                }}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-fg-muted hover:bg-raised hover:text-fg"
              >
                <sub.icon size={14} className="shrink-0" />
                <span className="flex-1">{toolLabel(msg, sub.id)}</span>
                {sub.key && <span className="text-[11px] text-fg-dim">{sub.key}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
