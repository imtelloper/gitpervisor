import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  History,
  Languages,
  LayoutGrid,
  Maximize2,
  Minimize2,
  RotateCw,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  attachTerminal,
  copyTerminalText,
  createTerminal,
  disposeTerminal,
  fitTerminal,
  getTerminal,
  pasteIntoTerminal,
} from "../../lib/terminal";
import { translateRequest } from "../../lib/translate";
import { useOccludesWebview } from "../../stores/occlusion";
import { usePromptHistory } from "../../stores/promptHistory";
import { useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { PromptSidePanel } from "./TermSessionControls";

/**
 * 단일 터미널 패널 — xterm 인스턴스(레지스트리 소유)를 이 컨테이너에 붙인다.
 * 우클릭 → 분할/최대화/닫기 메뉴 (Windows Terminal 스타일).
 */
export function TerminalPane({
  tabId,
  projectId,
  paneId,
  active,
  fontSize,
  controls,
}: {
  tabId: string;
  projectId: string;
  paneId: string;
  active: boolean;
  fontSize: number;
  /** 우상단 hover 오버레이의 내용(세션 컨트롤 + PaneControls) — 렌더 위치는 아래 주석 참고. */
  controls?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useTerminals((s) => s.paneStatus[paneId]) ?? "live";
  const maximized = useTerminals(
    (s) => s.terminals.find((t) => t.id === tabId)?.maximizedPaneId === paneId,
  );
  const setActivePane = useTerminals((s) => s.setActivePane);
  // 프롬프트 컬럼 열림 — 세션 단위 스토어(모아보기와 공유: 어디서 켜든 같은 세션 = 같은 상태).
  const promptOpen = usePromptHistory((s) => !!s.openPanels[paneId]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 분할 배치에서 이웃 브라우저 pane의 네이티브 webview가 이 메뉴를 덮는다 — 열린 동안 숨긴다.
  useOccludesWebview(!!menu);
  // 모아보기 별도 창이 이 PTY의 출력을 가져간 상태 — 여기 xterm은 갱신되지 않으므로 "멈춘 화면"을
  // 보여주는 대신 어디서 보고 있는지 알린다(창을 닫으면 자동으로 되돌아온다).
  const takenByWindow = useUi((s) => s.aggregateWindowOpen);

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    // 모아보기 별도 창이 이 PTY를 보고 있는 동안엔 손대지 않는다 — createTerminal이
    // "세션 있으면 attach"라서, 여기서 부르면 아직 안 열어본 탭을 클릭하는 순간 출력을
    // **도로 뺏어와** 저쪽 창의 셀이 죽는다. 창이 닫히면 이 효과가 다시 돌며 이어받는다.
    if (takenByWindow) return;
    // createTerminal은 무거운 xterm 엔진(~441kB)을 동적 import하므로 async — 로드 후 attach.
    // 첫 터미널 탭에서만 엔진 청크가 로드되고, 이후 생성은 즉시 반환된다.
    void createTerminal({ id: paneId, projectId, fontSize }).then(() => {
      if (!cancelled && el) attachTerminal(paneId, el);
    });
    const ro = new ResizeObserver(() => fitTerminal(paneId));
    if (el) ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
    // fontSize는 생성 시점에만 쓰인다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, takenByWindow]);

  return (
    <div
      className={`relative flex h-full w-full ${
        active ? "outline outline-1 -outline-offset-1 outline-accent" : ""
      }`}
      onMouseDown={() => setActivePane(tabId, paneId)}
      onContextMenu={(e) => {
        e.preventDefault();
        setActivePane(tabId, paneId);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="relative h-full min-w-0 flex-1">
        <div ref={ref} className="h-full w-full" />
        {/* 세션 컨트롤(테마·프롬프트 기록)과 PaneControls를 **이 오버레이 하나에** 담는다 — 예전엔
            둘이 같은 자리에 따로 떠 있어서 z-30 쪽이 z-10 쪽을 완전히 덮어 클릭이 닿지 않았다.
            앵커가 pane 루트가 아니라 **xterm 호스트 래퍼**인 이유: pane 루트 기준이면 프롬프트
            컬럼이 열렸을 때 pane 우상단 = 컬럼 헤더 우측이라, 오버레이가 컬럼 헤더의 X(프롬프트
            목록 닫기)를 정확히 덮어 컬럼 대신 pane이 닫혔다(맨 오른쪽 버튼이 '패널 닫기').
            호스트 래퍼는 컬럼 왼쪽 영역이라 겹칠 수가 없다. group/pane은 LeafView 래퍼(조상)에
            있으므로 hover 조건은 그대로다.
            focus-within은 팔레트 메뉴가 pane 밖으로 나갔을 때(포인터가 pane을 벗어나도) 오버레이가
            투명해지지 않게 하는 대비책이다 — 메뉴는 버튼의 형제라 부모 opacity를 그대로 받는다. */}
        <div className="absolute right-1 top-1 z-30 flex items-center gap-0.5 rounded-md border border-edge bg-panel/95 p-0.5 opacity-0 shadow-lg transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100">
          {controls}
        </div>
      </div>
      {/* 프롬프트 컬럼 — 여닫힘은 host ResizeObserver가 xterm을 refit해 따라온다. */}
      {promptOpen && <PromptSidePanel termId={paneId} />}
      {takenByWindow && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 bg-base/90 text-xs text-fg-muted">
          <LayoutGrid size={18} className="text-accent" />
          <span>모아보기 창에서 표시 중</span>
          <span className="text-[11px] text-fg-dim">
            그 창을 닫으면 여기로 돌아옵니다
          </span>
        </div>
      )}

      {status === "exited" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-base/70 text-sm text-fg-muted">
          <span>프로세스가 종료되었습니다</span>
          <button
            onClick={async () => {
              // 옛 PTY가 backend에서 완전히 닫힌 뒤 새로 연다 — term_close↔term_open 레이스 방지.
              await disposeTerminal(paneId);
              await createTerminal({ id: paneId, projectId, fontSize });
              if (ref.current) attachTerminal(paneId, ref.current);
              useTerminals.getState().setPaneStatus(paneId, "live");
            }}
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <RotateCw size={13} /> 재시작
          </button>
        </div>
      )}

      {menu && (
        <PaneMenu
          tabId={tabId}
          paneId={paneId}
          maximized={!!maximized}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function PaneMenu({
  tabId,
  paneId,
  maximized,
  x,
  y,
  onClose,
}: {
  tabId: string;
  paneId: string;
  maximized: boolean;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ts = useTerminals();
  // 프롬프트 컬럼 열림 — 여기서 직접 구독해야 라벨이 상태를 따라간다(다른 창이 같은 세션을
  // 토글하면 storage 이벤트로 즉시 반영). TerminalPane의 promptOpen과는 스코프가 다르다.
  const promptOpen = usePromptHistory((s) => !!s.openPanels[paneId]);
  const togglePanel = usePromptHistory((s) => s.togglePanel);
  const openTranslate = useUi((s) => s.openTranslate);
  // 메뉴가 **열린 순간**의 선택(태스크 61) — 선택이 없으면 비활성이 아니라 항목 자체가 없다.
  const [selection] = useState(() => {
    const term = getTerminal(paneId)?.term;
    return term?.hasSelection() ? term.getSelection() : "";
  });

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed z-50 min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        // 하단 클램프 = 메뉴 실높이. 항목 13 × 31.5 + 구분선 3 × 8.67 + 패딩·테두리 9.3 ≈ 445 → 8 단위 올림.
        // 240은 분할·그리드 항목이 붙기 전 값이 그대로 남아 창 아래 절반에서 메뉴가 잘리고 있었다.
        // max(0, …)은 창이 메뉴보다 낮을 때 — 플로팅 창은 min_inner_size 360×240이라 448px보다
        // 낮을 수 있고, 그러면 top이 음수가 되어 위쪽 항목(복사·붙여넣기)이 화면 밖으로 잘린다.
        // ponytail: 상수 클램프 — 항목이 또 늘면 ref 실측(useLayoutEffect)으로 바꾼다.
        // 번역 항목(선택이 있을 때만)이 한 줄 더 붙으므로 그때는 32px을 더 잡는다.
        top: Math.max(0, Math.min(y, window.innerHeight - (selection ? 480 : 448))),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <TermClipboardItems termId={paneId} selection={selection} run={run} />
      {selection && (
        <MenuItem
          icon={<Languages size={14} />}
          label="선택 영역 번역"
          onClick={run(() => openTranslate(translateRequest(selection, x, y)))}
        />
      )}
      <div className="my-1 border-t border-edge" />
      <MenuItem
        icon={<SplitSquareHorizontal size={14} />}
        label="오른쪽으로 분할"
        hint="Ctrl+Shift+D"
        onClick={run(() => ts.splitPane(tabId, paneId, "row", false))}
      />
      <MenuItem
        icon={<SplitSquareHorizontal size={14} />}
        label="왼쪽으로 분할"
        onClick={run(() => ts.splitPane(tabId, paneId, "row", true))}
      />
      <MenuItem
        icon={<SplitSquareVertical size={14} />}
        label="아래로 분할"
        hint="Ctrl+Shift+E"
        onClick={run(() => ts.splitPane(tabId, paneId, "col", false))}
      />
      <MenuItem
        icon={<SplitSquareVertical size={14} />}
        label="위로 분할"
        onClick={run(() => ts.splitPane(tabId, paneId, "col", true))}
      />
      <div className="my-1 border-t border-edge" />
      <MenuItem
        icon={<LayoutGrid size={14} />}
        label="2분할 (좌우)"
        onClick={run(() => ts.splitGrid(tabId, paneId, 2))}
      />
      <MenuItem
        icon={<LayoutGrid size={14} />}
        label="4분할 (2×2)"
        onClick={run(() => ts.splitGrid(tabId, paneId, 4))}
      />
      <MenuItem
        icon={<LayoutGrid size={14} />}
        label="8분할 (2×4)"
        onClick={run(() => ts.splitGrid(tabId, paneId, 8))}
      />
      <div className="my-1 border-t border-edge" />
      <MenuItem
        icon={maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        label={maximized ? "패널 최대화 해제" : "패널 최대화"}
        onClick={run(() => ts.toggleMaximize(tabId, paneId))}
      />
      <MenuItem
        icon={<History size={14} />}
        label={promptOpen ? "프롬프트 목록 닫기" : "프롬프트 목록 열기"}
        onClick={run(() => togglePanel(paneId))}
      />
      <MenuItem
        icon={<ExternalLink size={14} />}
        label="새 창으로 분리 (Float)"
        onClick={run(() => ts.floatPane(tabId, paneId))}
      />
      <MenuItem
        icon={<X size={14} />}
        label="패널 닫기"
        hint="Ctrl+Shift+W"
        danger
        onClick={run(() => ts.closePane(tabId, paneId))}
      />
    </div>
  );
}

/** 터미널 우클릭 메뉴의 **복사·붙여넣기 두 줄** — pane 메뉴와 모아보기 칩 메뉴가 같은 것을 쓴다.
 *
 *  같은 파일에 둔 이유: `MenuItem`이 여기 있고 `AggregateTerminals`가 이미 이 모듈에서 그것을
 *  가져간다. 별도 파일로 빼면 TerminalPane ↔ 새 파일 순환 import가 생긴다.
 *
 *  모아보기 셀에는 이 두 줄이 **아예 없었다**(태스크 65 §2 #1) — Claude 세션을 모아보기로 읽다
 *  우클릭하면 복사가 없어서 "이 PC에서는 복사가 안 된다"로 체감됐다. */
export function TermClipboardItems({
  termId,
  selection,
  run,
}: {
  termId: string;
  /** 메뉴가 **열린 순간**의 선택 스냅샷 — 여기서 다시 읽지 않는다(`copyTerminalText` 주석). */
  selection: string;
  run: (fn: () => void) => () => void;
}) {
  return (
    <>
      {selection ? (
        <MenuItem
          icon={<Copy size={14} />}
          label="복사"
          hint="Ctrl+Shift+C"
          onClick={run(() => copyTerminalText(termId, selection))}
        />
      ) : (
        // 죽은 [복사] 버튼을 그리지 않는다 — 눌러도 아무 일이 없으면 클립보드가 고장 난 것으로
        // 보인다. 왜 없는지를 대신 말한다.
        <div className="px-3 py-1.5 text-[11px] text-fg-dim">
          {noSelectionHint(termId)}
        </div>
      )}
      <MenuItem
        icon={<ClipboardPaste size={14} />}
        label="붙여넣기"
        hint="Ctrl+V"
        onClick={run(() => void pasteIntoTerminal(termId))}
      />
    </>
  );
}

/** 마우스 추적 모드(vim·lazygit·htop·tmux)에서는 드래그가 앱으로 가서 **선택이 생기지 않는다**.
 *  정답은 Shift+드래그인데, 안내가 없으면 "복사가 안 되는 앱"으로 오해한다. */
function noSelectionHint(termId: string): string {
  const mouse = getTerminal(termId)?.term.modes.mouseTrackingMode;
  return mouse && mouse !== "none"
    ? "앱이 마우스를 쓰는 중 — Shift+드래그로 선택하세요"
    : "선택한 텍스트가 없습니다";
}

/** 컨텍스트 메뉴 한 줄 — 모아보기 칩 메뉴(AggregateTerminals)도 같은 모양을 쓴다. */
export function MenuItem({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raised ${
        danger ? "text-danger" : "text-fg-muted hover:text-fg"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      {/* 줄바꿈 금지 — 세 메뉴(PaneMenu·ChipMenu·묶음 드롭다운)의 하단 클램프가 한 줄 31.5px를
          전제로 계산돼 있다. flex-1은 min-width:auto라 min-w-0이 있어야 실제로 줄어든다. */}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-fg-dim">{hint}</span>}
    </button>
  );
}
