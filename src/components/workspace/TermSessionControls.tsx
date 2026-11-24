// 터미널 세션 공용 컨트롤 — 컬러 테마(ThemeButton) · 프롬프트 기록(PromptLogButton +
// PromptSidePanel) · 전체 프롬프트 컬럼 마스터 토글(PromptHistoryButton). 원래 모아보기 셀
// 헤더(AggregateTerminals) 전용이었는데, 워크스페이스 터미널 패널에도 같은 기능을 붙이면서
// 여기로 뽑았다. 세션 단위 컨트롤의 상태는 전부 **세션(termId=paneId) 단위 스토어**
// (termThemes/promptHistory)라 어디서 그리든 같은 세션 = 같은 상태다. 마스터 토글만 창의
// 모든 세션을 대상으로 하며, 메인 타이틀바와 모아보기 별도 창 헤더가 함께 쓴다.
import {
  Bot,
  Check,
  CircleCheck,
  Code2,
  FolderTree,
  GitBranch,
  Globe,
  History,
  Loader2,
  MessagesSquare,
  Palette,
  Sparkles,
  Tag,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { fmtTime } from "../../i18n/format-locale";
import { currentMessages, useMessages } from "../../i18n/ui-language";
import { launchAgentInTerminal, type TerminalAgent } from "../../lib/agent-launch";
import { copyText } from "../../lib/clipboard";
import { openBrowserWindow, openDocWindow } from "../../lib/floating";
import { relativeTime } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import { classifyMode } from "../../stores/browser";
import { TERM_SCHEMES } from "../../lib/term-color-schemes";
import { prefetchGitDialog, useClaudeTermModels } from "../../queries";
import { GitDialogBody } from "../git/GitDialog";
import { prefetchSessionList, SessionHistoryBody } from "../sessions/SessionHistoryDialog";
import { FileTreePanel } from "../tree/FileTreePanel";
import { useOccludesWebview } from "../../stores/occlusion";
import { usePromptHistory, type PromptEntry } from "../../stores/promptHistory";
import { useTermThemes } from "../../stores/termThemes";
import { SESSION_TITLE_MAX, useTermTitles } from "../../stores/termTitles";
import { collectByContent, useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";

/**
 * 헤더 버튼 메뉴 닫기 — Esc, 그리고 버튼·메뉴 **밖**을 누를 때.
 *
 * 화면을 덮는 배경 막(`fixed inset-0`)을 깔지 않는다. 막은 바깥 클릭을 먹어 사용자가 누른 곳
 * (다른 셀·터미널)에 아무 일도 안 일어나게 했고, 셀 헤더의 쌓임 맥락 안에 갇혀 터미널을 덮지
 * 못하면 바깥을 눌러도 메뉴가 닫히지 않았다 — 메뉴 항목을 골라야만 풀렸다(2026-10-07 신고).
 * 창 전체의 pointerdown을 **캡처 단계**로 듣고 막지는 않는다: xterm 등이 전파를 끊어도 먼저 받고,
 * 클릭은 원래 대상에 그대로 간다.
 */
function useMenuDismiss(
  isOpen: boolean,
  setMenu: (v: null) => void,
  inside: React.RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      if (inside.some((r) => r.current?.contains(e.target as Node))) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
    // inside 는 호출부의 useRef 들이라 신원이 고정이다 — 배열 리터럴을 deps 에 넣으면 매 렌더 재구독한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, setMenu]);
}

/** 이만큼 머물러야 연다 — 헤더를 스치는 포인터마다 메뉴가 뜨면 열린 동안 숨는 브라우저 셀이 깜빡인다. */
const HOVER_OPEN_MS = 120;
/** 버튼·메뉴를 모두 벗어난 뒤 이만큼 지나야 닫는다 — 둘 사이 4px 틈을 건너는 동안 닫히지 않게. */
const HOVER_CLOSE_MS = 250;

type HoverMenuPos = { right: number; top?: number; bottom?: number; maxHeight: number; width?: number };

/**
 * 포인터를 올리면 열리는 헤더 버튼 메뉴 — 아이콘마다 설명 대신 **바로 누를 수 있는 항목**을 보여 준다(2026-11-24 요청).
 * 메뉴는 버튼 rect 기준 fixed(헤더가 overflow-hidden), 우측 모서리 정렬, 아래가 모자라면 위로 뒤집는다.
 * 터치는 탭 직후 pointerleave 가 와서 바로 닫혀 버리므로 호버 처리에서 뺀다(탭 = 클릭으로 연다).
 * 버튼의 title 은 e2e 셀렉터·접근성 이름이라 남기고, 호버 중 네이티브 툴팁은 `data-hover-menu` 로 막는다(lib/hover-tip.ts).
 */
function useHoverMenu(menuHeight: number, panel?: { width: number }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<HoverMenuPos | null>(null);
  useOccludesWebview(!!menu);
  useMenuDismiss(!!menu, setMenu, [btnRef, menuRef]);

  // 대기 중인 호버 동작(열기 또는 닫기) 하나 — 둘은 동시에 걸리지 않는다.
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const cancelHover = () => window.clearTimeout(hoverTimer.current);
  const closeSoon = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    cancelHover();
    hoverTimer.current = window.setTimeout(() => setMenu(null), HOVER_CLOSE_MS);
  };
  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // 내용 패널은 넓다 — 왼쪽 셀의 버튼이면 우측 정렬만으로는 창 왼쪽 밖으로 나가므로 창 안으로 민다.
    const width = panel ? Math.min(panel.width, window.innerWidth - 16) : undefined;
    const right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - (width ?? 0) - 8));
    const cap = panel ? menuHeight : 320;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // 아주 낮은 창에서 양쪽 다 모자라는 극단은 maxHeight + 스크롤이 안전망.
    if (below >= menuHeight || below >= above)
      setMenu({ right, width, top: r.bottom + 4, maxHeight: Math.max(120, Math.min(below, cap)) });
    else setMenu({ right, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.max(120, Math.min(above, cap)) });
  };
  const close = () => {
    cancelHover();
    setMenu(null);
  };
  return {
    btnRef,
    menuRef,
    menu,
    open,
    close,
    buttonHover: {
      "data-hover-menu": "",
      onPointerEnter: (e: React.PointerEvent) => {
        if (e.pointerType === "touch") return;
        cancelHover();
        if (!menu) hoverTimer.current = window.setTimeout(open, HOVER_OPEN_MS);
      },
      onPointerLeave: closeSoon,
    },
    menuHover: { onPointerEnter: cancelHover, onPointerLeave: closeSoon },
  };
}

function HoverMenuPanel({
  hm,
  width = "min-w-[180px] max-w-[320px]",
  children,
}: {
  hm: ReturnType<typeof useHoverMenu>;
  width?: string;
  children: React.ReactNode;
}) {
  if (!hm.menu) return null;
  return (
    <div
      ref={hm.menuRef}
      {...hm.menuHover}
      className={`fixed z-50 overflow-y-auto rounded-md border border-edge bg-panel py-1 text-[12px] shadow-xl ${width}`}
      style={{ right: hm.menu.right, top: hm.menu.top, bottom: hm.menu.bottom, maxHeight: hm.menu.maxHeight }}
    >
      {children}
    </div>
  );
}

function HoverMenuRow({
  icon,
  label,
  onClick,
  danger,
  disabled,
  trailing,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  trailing?: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raised disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent ${
        danger ? "text-fg-muted hover:text-danger" : "text-fg-muted hover:text-fg"
      }`}
    >
      <span className="shrink-0 text-fg-dim">{icon}</span>
      <span className="min-w-0 flex-1 break-words">{label}</span>
      {trailing}
    </button>
  );
}

/**
 * 동작이 하나뿐인 헤더 아이콘 — 호버하면 그 동작을 설명하는 한 줄 메뉴가 뜨고, 그 줄을 눌러도 아이콘을 누른 것과 같다.
 * 모아보기 셀 헤더의 숨기기·닫기(AggregateTerminals)도 이걸 쓴다.
 */
export function HoverActionButton({
  icon,
  label,
  onClick,
  onPointerEnter,
  danger,
  className = "flex shrink-0 items-center rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg",
  children,
}: {
  icon: React.ReactNode;
  /** 메뉴 줄 문구이자 버튼 title(e2e 셀렉터) — 같은 문구를 두 번 관리하지 않는다. */
  label: string;
  onClick: () => void;
  onPointerEnter?: () => void;
  danger?: boolean;
  className?: string;
  /** 아이콘 옆에 붙는 것(프롬프트 개수 등). */
  children?: React.ReactNode;
}) {
  const hm = useHoverMenu(40);
  const run = () => {
    hm.close();
    onClick();
  };
  return (
    <>
      <button
        ref={hm.btnRef}
        {...hm.buttonHover}
        onPointerEnter={(e) => {
          onPointerEnter?.();
          hm.buttonHover.onPointerEnter(e);
        }}
        onClick={run}
        title={label}
        className={className}
      >
        {icon}
        {children}
      </button>
      <HoverMenuPanel hm={hm}>
        <HoverMenuRow icon={icon} label={label} onClick={run} danger={danger} />
      </HoverMenuPanel>
    </>
  );
}

/**
 * 호버하면 **그 기능의 내용**(파일 트리·Git 변경·세션 목록·프롬프트)을 바로 띄우는 헤더 아이콘 — "○○ 보기" 한 줄을
 * 한 번 더 누르게 하지 말고 바로 보여 달라는 요청(2026-11-24). 클릭은 예전처럼 큰 대화상자를 연다.
 * 내용은 열려 있는 동안만 마운트한다 — 칸마다 트리·목록 조회가 미리 돌지 않게.
 */
function HoverPanelButton({
  icon,
  label,
  onClick,
  onPointerEnter,
  className = "flex shrink-0 items-center rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg",
  width,
  height,
  panel,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onPointerEnter?: () => void;
  className?: string;
  width: number;
  height: number;
  panel: (close: () => void) => React.ReactNode;
  children?: React.ReactNode;
}) {
  const hm = useHoverMenu(height, { width });
  return (
    <>
      <button
        ref={hm.btnRef}
        {...hm.buttonHover}
        onPointerEnter={(e) => {
          onPointerEnter?.();
          hm.buttonHover.onPointerEnter(e);
        }}
        onClick={() => {
          hm.close();
          onClick();
        }}
        title={label}
        className={className}
      >
        {icon}
        {children}
      </button>
      {hm.menu && (
        <div
          ref={hm.menuRef}
          {...hm.menuHover}
          className="fixed z-50 flex flex-col overflow-hidden rounded-md border border-edge bg-panel text-[12px] shadow-xl"
          style={{
            right: hm.menu.right,
            top: hm.menu.top,
            bottom: hm.menu.bottom,
            width: hm.menu.width,
            height: hm.menu.maxHeight,
          }}
        >
          {panel(hm.close)}
        </div>
      )}
    </>
  );
}

/**
 * 이 세션의 컬러 스킴 선택 — 팔레트 버튼. 여러 세션을 색으로 구분하는 용도라, 선택은
 * **세션(termId) 단위**로 저장돼(termThemes 스토어) 그 세션이 닫히지 않는 한 유지된다
 * (모아보기를 닫거나 앱을 재시작해도 — dropPane에서만 지운다).
 * 메뉴는 버튼 rect 기준 fixed — 부모가 overflow-hidden이라 안에 그리면 잘린다.
 */
export function ThemeButton({ termId }: { termId: string }) {
  const msg = useMessages();
  const current = useTermThemes((s) => s.byTerminal[termId]);
  const setScheme = useTermThemes((s) => s.setScheme);
  // 메뉴 실높이(~290px)가 하단에서는 아래 여유를 넘으므로 부족하면 버튼 **위**로 뒤집는다.
  const hm = useHoverMenu(300);
  const pick = (id: (typeof TERM_SCHEMES)[number]["id"] | null) => {
    setScheme(termId, id);
    hm.close();
  };

  return (
    <>
      <button
        ref={hm.btnRef}
        {...hm.buttonHover}
        onClick={() => !hm.menu && hm.open()}
        title={msg.git.termSession.themeTitle}
        className={`shrink-0 rounded p-0.5 ${
          hm.menu || current
            ? "bg-raised text-accent"
            : "text-fg-dim hover:bg-raised hover:text-fg"
        }`}
      >
        <Palette size={12} />
      </button>
      <HoverMenuPanel hm={hm} width="w-[210px]">
        <button
          onClick={() => pick(null)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
        >
          <Palette size={12} className="shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate">{msg.git.termSession.appThemeDefault}</span>
          {!current && <Check size={12} className="shrink-0 text-accent" />}
        </button>
        <div className="my-1 border-t border-edge/60" />
        {TERM_SCHEMES.map((s) => (
          <button
            key={s.id}
            onClick={() => pick(s.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
          >
            {/* 스와치 — 배경 칩 위에 팔레트 3색 점: 목록에서 색감을 한눈에 비교 */}
            <span
              className="flex h-[14px] w-[26px] shrink-0 items-center justify-center gap-[2px] rounded-[3px] border border-edge/60"
              style={{ background: s.swatch[0] }}
            >
              {s.swatch.slice(1).map((c) => (
                <span key={c} className="size-[5px] rounded-full" style={{ background: c }} />
              ))}
            </span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {current === s.id && <Check size={12} className="shrink-0 text-accent" />}
          </button>
        ))}
      </HoverMenuPanel>
    </>
  );
}


/**
 * 이 터미널에 AI 세션을 띄운다 — 지금 셸 프롬프트에 실행 줄을 입력한다
 * (lib/agent-launch.ts `launchAgentInTerminal`). 뭔가 돌고 있는 터미널이면 그 프로그램에 입력이 가니
 * 셸 프롬프트에서 누르는 버튼이다. 메뉴 배치는 ThemeButton과 같은 fixed(헤더가 overflow-hidden).
 *
 * 포인터를 올리기만 해도 열린다. 터치는 탭 직후
 * pointerleave가 와서 바로 닫혀 버리므로 호버 처리에서 뺀다(탭 = 클릭으로 연다).
 */
export function AgentLaunchButton({ termId }: { termId: string }) {
  const msg = useMessages();
  const hm = useHoverMenu(100);
  const pick = (agent: TerminalAgent) => {
    hm.close();
    void launchAgentInTerminal(termId, agent);
  };

  return (
    <>
      <button
        ref={hm.btnRef}
        {...hm.buttonHover}
        onClick={() => !hm.menu && hm.open()}
        // title 이 아니라 aria-label — 호버로 메뉴가 바로 뜨므로 툴팁이 필요 없다.
        aria-label={msg.git.termSession.agentLaunchTitle}
        className={`shrink-0 rounded p-0.5 ${
          hm.menu ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"
        }`}
      >
        <Bot size={12} />
      </button>
      <HoverMenuPanel hm={hm}>
        <HoverMenuRow icon={<Sparkles size={12} />} label={msg.git.termSession.agentLaunchClaude} onClick={() => pick("claude")} />
        <HoverMenuRow icon={<Code2 size={12} />} label={msg.git.termSession.agentLaunchCodex} onClick={() => pick("codex")} />
        <HoverMenuRow icon={<Bot size={12} />} label={msg.git.termSession.agentLaunchOpenCode} onClick={() => pick("opencode")} />
      </HoverMenuPanel>
    </>
  );
}

/**
 * 프롬프트 컬럼 토글 — 세션 **우측에 상주하는 실시간 목록**(PromptSidePanel)을 켜고 끈다.
 * 예전의 버튼-아래 드롭다운을 대체했다: 드롭다운은 열어야 보이는 스냅샷이라 "에이전트가
 * 지금 무슨 지시를 받고 도는지"를 곁눈질하는 용도에 안 맞았다. 열림 상태는 세션(termId)
 * 단위로 기억된다(promptHistory 스토어 — 세션이 닫힐 때 함께 정리).
 */
export function PromptLogButton({ termId }: { termId: string }) {
  const msg = useMessages();
  const count = usePromptHistory((s) => s.byTerminal[termId]?.length ?? 0);
  const open = usePromptHistory((s) => !!s.openPanels[termId]);
  const togglePanel = usePromptHistory((s) => s.togglePanel);
  return (
    <HoverPanelButton
      icon={<History size={12} />}
      label={msg.git.termSession.promptLogTitle(count, open)}
      onClick={() => togglePanel(termId)}
      className={`flex shrink-0 items-center gap-0.5 rounded p-0.5 ${
        open ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"
      }`}
      width={420}
      height={480}
      panel={() => <PromptLogPeek termId={termId} />}
    >
      {count > 0 && <span className="text-[9px] leading-none tabular-nums">{count}</span>}
    </HoverPanelButton>
  );
}

/** 프롬프트 아이콘 호버 패널 — 우측 컬럼(PromptSidePanel)을 켜지 않고 이 세션에서 친 줄을 훑는다. 클릭은 복사(컬럼과 같다). */
function PromptLogPeek({ termId }: { termId: string }) {
  const msg = useMessages();
  const entries = usePromptHistory((s) => s.byTerminal[termId]);
  const clear = usePromptHistory((s) => s.clear);
  const pushToast = useUi((s) => s.pushToast);
  const list = entries ?? [];
  const copy = (text: string) =>
    void copyText(text).then((ok) =>
      pushToast(ok ? "success" : "error", ok ? msg.git.termSession.promptCopied : msg.git.termSession.copyFailed),
    );
  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-1.5 text-[11px] text-fg-dim">
        <History size={12} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{msg.git.termSession.promptCount(list.length)}</span>
        <span className="shrink-0">{msg.git.termSession.clickToCopy}</span>
        {list.length > 0 && (
          <button
            onClick={() => clear(termId)}
            title={msg.git.termSession.clearHistoryTitle}
            className="shrink-0 rounded p-0.5 hover:bg-raised hover:text-danger"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list
          .slice()
          .reverse()
          .map((e) => (
            <button
              key={e.id}
              onClick={() => copy(e.text)}
              className="block w-full border-b border-edge/40 px-3 py-1.5 text-left last:border-b-0 hover:bg-raised"
            >
              <div className="line-clamp-6 whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-fg">
                {e.text}
              </div>
              <div className="mt-0.5 text-[10px] text-fg-dim">{relativeTime(e.at)}</div>
            </button>
          ))}
        {list.length === 0 && <div className="px-3 py-3 text-[11px] text-fg-dim">{msg.git.termSession.noPrompts}</div>}
      </div>
    </>
  );
}

/**
 * 세션 제목 — 셀 헤더 가운데. 시간이 지나면 "이게 뭐 하던 세션이었지?"를 잊는다(2026-11-05 요청).
 * 표시는 **글자 크기만 한 버튼**이다: 헤더 전체가 셀 이동 드래그 손잡이인데 그 드래그는 button·input 위에서는
 * 시작하지 않는다(AggregateTerminals startMove) — 가운데를 통째로 잡아먹지 않고 제목 자리만 클릭 편집이 된다.
 * 제목이 없으면 헤더에 마우스를 올렸을 때만 "+ 세션 제목"이 보인다.
 */
export function SessionTitle({ termId }: { termId: string }) {
  const msg = useMessages();
  const title = useTermTitles((s) => s.byTerminal[termId] ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) useTermTitles.getState().setTitle(termId, draft);
    setDraft(null);
  };
  // 감싼 칸은 남는 폭을 다 갖는 가운데 칸(드래그 손잡이로 남는다). 제목이 있거나 고치는 중이면 최소 폭을 잡아 둔다 —
  // 좁은 셀(~300px)에서는 왼쪽 "프로젝트 · 터미널 N" 과 오른쪽 아이콘이 자리를 다 먹어 제목이 0px 로 사라졌다. 이름표보다
  // 사용자가 붙인 제목이 그 세션을 더 잘 말하므로 왼쪽이 먼저 줄어든다.
  const wrap = `flex min-w-0 flex-1 justify-center ${title || draft !== null ? "min-w-[5rem]" : ""}`;
  if (draft !== null)
    return (
      <div className={wrap}>
        <input
          autoFocus
          value={draft}
          maxLength={SESSION_TITLE_MAX}
          placeholder={msg.git.termSession.sessionTitlePlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            // 창 단축키(Esc 로 모아보기 닫기 등)·터미널로 새지 않게.
            e.stopPropagation();
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setDraft(null);
          }}
          className="h-5 w-full max-w-[28rem] min-w-0 rounded border border-accent bg-base px-1.5 text-center text-[11px] text-fg outline-none placeholder:text-fg-dim"
        />
      </div>
    );
  return (
    <div className={wrap}>
      <button
        onClick={() => setDraft(title)}
        // 잘려 보일 수 있다 — 툴팁에 전체 제목을 둔다.
        title={title ? `${title}\n${msg.git.termSession.sessionTitleEditTitle}` : msg.git.termSession.sessionTitleEditTitle}
        className={
          title
            ? "min-w-0 max-w-full truncate rounded px-1.5 font-medium text-accent hover:bg-raised"
            : "min-w-0 max-w-full truncate rounded px-1.5 text-fg-dim opacity-0 hover:bg-raised hover:text-fg group-hover/cell:opacity-100 focus-visible:opacity-100"
        }
      >
        {title || msg.git.termSession.sessionTitleAdd}
      </button>
    </div>
  );
}

/** 세션 제목을 대화상자로 묻는다 — 헤더 줄이 없는 곳(작업 화면 터미널 패널·탭 메뉴)이 쓴다. 비우면 지운다. */
export function askSessionTitle(termId: string): void {
  const t = currentMessages().git.termSession;
  useUi.getState().askPrompt({
    title: t.sessionTitlePromptTitle,
    label: t.sessionTitlePromptLabel,
    placeholder: t.sessionTitlePlaceholder,
    defaultValue: useTermTitles.getState().byTerminal[termId] ?? "",
    confirmLabel: t.sessionTitleSave,
    allowEmpty: true,
    validate: (v) => (v.trim().length > SESSION_TITLE_MAX ? t.sessionTitleTooLong(SESSION_TITLE_MAX) : null),
    onConfirm: (v) => useTermTitles.getState().setTitle(termId, v),
  });
}

/**
 * 작업 화면 터미널 패널의 호버 버튼 줄에 붙는 세션 제목 칩 — 분할된 패널마다 자기 제목이 있어 패널 위에서 보이고
 * 고칠 수 있어야 한다(탭에는 활성 패널 것만 보인다). 제목이 없으면 아이콘만.
 */
export function SessionTitleChip({ termId }: { termId: string }) {
  const msg = useMessages();
  const title = useTermTitles((s) => s.byTerminal[termId] ?? "");
  return (
    <button
      onClick={() => askSessionTitle(termId)}
      title={title ? `${title}\n${msg.git.termSession.sessionTitleEditTitle}` : msg.git.termSession.sessionTitleEditTitle}
      className={`flex min-w-0 shrink items-center gap-1 rounded p-0.5 ${
        title ? "max-w-[16rem] text-accent hover:bg-raised" : "text-fg-dim hover:bg-raised hover:text-fg"
      }`}
    >
      <Tag size={12} className="shrink-0" />
      {title && <span className="truncate text-[11px] font-medium">{title}</span>}
    </button>
  );
}

/**
 * 이 세션의 프로젝트에 대한 Git 변경·로그 모달(GitDialog)을 여는 버튼 — 모아보기에는
 * Changes·Log 패널이 없으므로 여기가 유일한 동선이다(태스크 55).
 * 세션 단위가 아니라 **프로젝트 단위** 기능이라 termId가 아닌 projectId를 받는다.
 */
export function GitDialogButton({ projectId }: { projectId: string }) {
  const msg = useMessages();
  const open = useUi((s) => s.openGitDialog);
  const qc = useQueryClient();
  return (
    <HoverPanelButton
      icon={<GitBranch size={12} />}
      label={msg.git.termSession.gitDialogTitle}
      onPointerEnter={() => prefetchGitDialog(qc, projectId)}
      onClick={() => open(projectId)}
      width={1000}
      height={600}
      panel={(close) => <GitDialogBody projectId={projectId} initialTab="changes" onClose={close} />}
    />
  );
}

/**
 * Claude Code 세션 기록 대화상자(SessionHistoryDialog, 태스크 77)를 여는 버튼. 범위 "이 프로젝트"와
 * "이 터미널에서 이어서"가 버튼을 누른 세션을 기준으로 하므로 termId·projectId 를 둘 다 넘긴다.
 */
export function SessionHistoryButton({ termId, projectId }: { termId: string; projectId: string }) {
  const msg = useMessages();
  const open = useUi((s) => s.openSessionHistory);
  const isOpen = useUi((s) => s.sessionHistory?.termId === termId);
  const qc = useQueryClient();
  return (
    <HoverPanelButton
      icon={<MessagesSquare size={12} />}
      label={msg.sessions.buttonTitle}
      onPointerEnter={() => prefetchSessionList(qc)}
      onClick={() => open(termId, projectId)}
      className={`flex shrink-0 items-center rounded p-0.5 ${
        isOpen ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"
      }`}
      width={780}
      height={600}
      panel={(close) => <SessionHistoryBody opener={{ termId, projectId }} onClose={close} popover />}
    />
  );
}

/**
 * 이 세션의 프로젝트 파일 트리 모달(FileTreeDialog)을 여는 버튼 — 모아보기(특히 별도 창)에는
 * 사이드바 트리가 없으므로 여기가 유일한 동선이다(태스크 62).
 * GitDialogButton과 같은 이유로 termId가 아닌 projectId를 받는다(프로젝트 단위 기능).
 */
const staticPagesKey = (projectId: string) => ["static-pages", projectId] as const;
/** 걷기는 프로젝트 전체 디스크라 수 초가 걸릴 수 있다 — 같은 프로젝트를 잠깐 사이에 다시 누르면 다시 걷지 않는다. */
const STATIC_PAGES_STALE_MS = 60_000;

/** 프로젝트의 정적 `index.html` 을 브라우저 새 창으로 — 트리 우클릭 "브라우저로 열기"와 같은 미리보기 URL 이고, 창은
 *  브라우저 탭을 "새 창으로" 뺀 것과 같은 브라우저 창이다. */
async function openStaticPageWindow(projectId: string, relPath: string) {
  const url = await ipc.previewLocalUrl(projectId, relPath);
  openBrowserWindow({
    id: crypto.randomUUID(),
    projectId,
    title: relPath,
    url,
    mode: classifyMode(url),
    preview: { projectId, relPath },
  });
}

/**
 * 칸 헤더·툴바의 브라우저 버튼(사용자 요청 2026-11-17) — 이 프로젝트에서 **정적으로 열 수 있는** `index.html`
 * (빌드 결과 `dist/`·`web/static/` 같은 것, 백엔드 `preview_static_pages`)을 새 브라우저 창으로 연다. 하나면 바로, 여럿이면
 * 고르는 목록, 없으면 알린다. 목록은 포인터를 올릴 때 미리 받아, 없으면 버튼을 흐리게 둔다.
 * `icon`: 메인·플로팅 칸 툴바엔 이미 지구본("이 칸을 웹으로 전환", PaneControls)이 있어 거기선 창 아이콘을 넘긴다.
 */
export function StaticPageButton({ projectId, icon: Icon = Globe }: { projectId: string; icon?: LucideIcon }) {
  const msg = useMessages();
  const qc = useQueryClient();
  const hm = useHoverMenu(160);
  const options = {
    queryKey: staticPagesKey(projectId),
    queryFn: () => ipc.previewStaticPages(projectId),
    staleTime: STATIC_PAGES_STALE_MS,
  };
  // 메뉴가 열렸을 때만 받는다 — 칸마다 마운트하자마자 디스크를 걷지 않게(호버 때 미리 받기는 그대로).
  const { data: known, isError, error } = useQuery({ ...options, enabled: !!hm.menu });
  const none = known?.length === 0;
  const fail = (e: unknown) => useUi.getState().pushToast("error", errorMessage(e));
  const openPage = (p: string) => {
    hm.close();
    void openStaticPageWindow(projectId, p).catch(fail);
  };

  const click = async () => {
    let pages: string[];
    try {
      pages = await qc.fetchQuery(options);
    } catch (e) {
      return fail(e);
    }
    if (pages.length === 0) return useUi.getState().pushToast("info", msg.git.termSession.staticPageNone);
    if (pages.length === 1) return openPage(pages[0]);
    if (!hm.menu) hm.open();
  };

  return (
    <>
      <button
        ref={hm.btnRef}
        {...hm.buttonHover}
        onPointerEnter={(e) => {
          void qc.prefetchQuery(options);
          hm.buttonHover.onPointerEnter(e);
        }}
        onClick={() => void click()}
        title={none ? msg.git.termSession.staticPageNoneTitle : msg.git.termSession.staticPageTitle}
        className={`flex shrink-0 items-center rounded p-0.5 ${
          hm.menu ? "bg-raised text-accent" : none ? "text-fg-dim/40 hover:bg-raised" : "text-fg-dim hover:bg-raised hover:text-fg"
        }`}
      >
        <Icon size={12} />
      </button>
      <HoverMenuPanel hm={hm} width="min-w-[200px] max-w-[420px]">
        <div className="px-3 pb-1 pt-0.5 text-[11px] text-fg-dim">
          {isError ? errorMessage(error) : none ? msg.git.termSession.staticPageNoneTitle : msg.git.termSession.staticPageTitle}
        </div>
        {!known && !isError && (
          <div className="flex items-center px-3 py-1.5 text-fg-dim">
            <Loader2 size={12} className="animate-spin" />
          </div>
        )}
        {known?.map((p) => (
          <HoverMenuRow key={p} icon={<Icon size={12} />} label={p} title={p} onClick={() => openPage(p)} />
        ))}
      </HoverMenuPanel>
    </>
  );
}

/** 칸 헤더 맨 앞 AI 활동 표시 — 모아보기 셀과 플로팅 창 분할 칸 헤더가 함께 쓴다. */
export function StatusIcon({ status }: { status: "working" | "done" | undefined }) {
  if (status === "working")
    return <Loader2 size={11} className="shrink-0 animate-spin text-accent" />;
  if (status === "done")
    return <CircleCheck size={11} className="shrink-0 text-add" />;
  return <span className="size-[7px] shrink-0 rounded-full bg-fg-dim/50" />;
}

// 상태줄(statusline.js)과 같은 색 순서 — 사용자가 이미 그 색으로 읽는다.
const EFFORT_COLOR: Record<string, string> = {
  low: "text-fg-dim",
  medium: "text-add",
  high: "text-warn",
  xhigh: "text-orange-400",
  max: "text-red-400",
};

/** 이 터미널에서 도는 Claude 의 모델·effort. Claude 가 없거나 첫 응답 전이면 안 그린다. */
export function ClaudeModelChip({ termId }: { termId: string }) {
  const msg = useMessages();
  const m = useClaudeTermModels().data?.[termId];
  if (!m) return null;
  return (
    <span
      title={msg.git.termSession.claudeModelTitle(m.modelId, m.effort)}
      className="flex shrink-0 items-center gap-1 rounded bg-black/20 px-1 font-mono text-[10px] leading-4"
    >
      <span className="text-fg">{m.model}</span>
      {m.effort && <span className={EFFORT_COLOR[m.effort] ?? "text-fg-dim"}>{m.effort}</span>}
      {m.ultracode && <span className="text-fuchsia-400">ultracode</span>}
    </span>
  );
}

export function FileTreeButton({ projectId }: { projectId: string }) {
  const msg = useMessages();
  const open = useUi((s) => s.openFileTreeDialog);
  return (
    <HoverPanelButton
      icon={<FolderTree size={12} />}
      label={msg.git.termSession.fileTreeTitle}
      onClick={() => open(projectId)}
      width={420}
      height={640}
      panel={(close) => (
        <FileTreePanel
          projectId={projectId}
          variant="modal"
          onActivate={(path) => {
            close();
            openDocWindow(projectId, path);
          }}
          onClose={close}
        />
      )}
    />
  );
}

/**
 * 전체 프롬프트 히스토리 펼치기/접기 — **모든 터미널 셀 우측 프롬프트 컬럼**의 마스터 토글.
 * 켜면 모든 세션 셀에 컬럼이 펼쳐지고(메인·별도 창·플로팅 — 그 창의 스토어에 있는 pane),
 * 다시 누르면 전부 접힌다.
 * 셀마다 개별 토글(헤더 버튼·패널 X)은 그대로 살아 있다 — 일부만 닫힌 상태에서 누르면
 * "전부 펼치기"부터 한다(반쯤 섞인 상태에서 마스터의 의도는 언제나 '다 보이게'가 먼저다).
 * 열린 터미널이 있을 때만 표시(모아보기 버튼과 같은 규칙).
 * className은 두는 자리의 버튼 크기에 맞추는 용도 — 생략하면 타이틀바 치수다.
 */
export function PromptHistoryButton({ className }: { className?: string }) {
  const msg = useMessages();
  const terminals = useTerminals((s) => s.terminals);
  const openPanels = usePromptHistory((s) => s.openPanels);
  const setPanels = usePromptHistory((s) => s.setPanels);
  // 살아있는 모든 터미널 pane — 마스터 토글의 대상 집합.
  const paneIds = useMemo(
    () => terminals.flatMap((t) => collectByContent(t.layout, "terminal")),
    [terminals],
  );
  if (paneIds.length === 0) return null;
  const allOpen = paneIds.every((id) => openPanels[id]);
  return (
    <button
      onClick={() => setPanels(paneIds, !allOpen)}
      title={
        // 사용처가 셋(메인 타이틀바·별도 모아보기 창 헤더·플로팅 창 타이틀바)이고 대상 집합은
        // 언제나 "그 창의 스토어에 있는 pane"이라, 세 곳에서 모두 참인 문장으로 쓴다.
        allOpen
          ? msg.git.termSession.collapseAllPromptListsTitle
          : msg.git.termSession.expandAllPromptListsTitle
      }
      className={`flex items-center gap-1 rounded ${
        allOpen
          ? "bg-raised text-accent"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      } ${className ?? "mr-2.5 px-1.5 py-0.5 text-[10px]"}`}
    >
      <History size={11} /> {msg.git.termSession.history}
    </button>
  );
}

/**
 * 세션 우측 프롬프트 컬럼 — 이 터미널에 **입력해 Enter로 확정한 줄**을 실시간으로 쌓아 보여준다
 * (수집은 lib/prompt-capture, PTY 송신 경로). 폭은 컨테이너의 15%(가독 하한 110px) — 터미널을
 * 크게 줄이지 않으면서 곁눈질이 되는 선. 패널이 여닫힐 때 xterm은 host ResizeObserver가
 * refit하고, PTY 크기는 리사이즈 체인이 따라간다(별도 배선 불필요).
 *
 * 항목 클릭은 **클립보드 복사**만 한다 — 되돌려 보내면 그 터미널이 지금 무엇을 하고 있는지
 * 모른 채 Enter를 대신 눌러 주는 셈이라, 실행은 사용자가 붙여넣고 직접 결정하게 둔다.
 */
export function PromptSidePanel({ termId }: { termId: string }) {
  const msg = useMessages();
  const entries = usePromptHistory((s) => s.byTerminal[termId]);
  const clear = usePromptHistory((s) => s.clear);
  const togglePanel = usePromptHistory((s) => s.togglePanel);
  const pushToast = useUi((s) => s.pushToast);
  const list = entries ?? [];
  const copy = (text: string) => {
    void copyText(text).then((ok) =>
      pushToast(
        ok ? "success" : "error",
        ok ? msg.git.termSession.promptCopied : msg.git.termSession.copyFailed,
      ),
    );
  };

  // 호버 카드 — **리스트 단위** 상태. 카드가 pointer-events-none이라 "항목→카드" 이동 자체가
  // 없고, 상태 전이는 항목 enter / 컨테이너 leave·scroll / 언마운트 넷뿐이다. 항목 단위로
  // 열고 닫으면 카드가 항목을 덮는 좁은 셀에서 leave→숨김→enter→표시의 깜빡임 루프가 된다.
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverRef = useRef<Hover | null>(null); // 핸들러가 클로저 갱신 없이 최신 열림 여부를 읽는 동기 미러
  const showTimer = useRef<number | undefined>(undefined);
  const show = (h: Hover | null) => {
    hoverRef.current = h;
    setHover(h);
  };
  const cancelTimer = () => window.clearTimeout(showTimer.current);
  const hide = () => {
    cancelTimer();
    show(null);
  };
  const onItemEnter = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect(); // 동기 캡처 — 타이머 콜백 시점엔 currentTarget이 null
    cancelTimer();
    if (hoverRef.current) show({ id, rect }); // 이미 떠 있으면 목록을 훑는 중 — 즉시 전환
    else showTimer.current = window.setTimeout(() => show({ id, rect }), 150); // 최초 1회만 지연
  };
  // 다른 창의 기록 지우기(clear는 openPanels까지 지운다)로 hover 중에 컬럼이 통째로 사라질 수
  // 있다 — 대기 중 타이머가 언마운트 뒤 setState를 부르지 않게.
  useEffect(() => cancelTimer, []);
  // 기록 지우기·트림·다른 창의 storage 교체로 항목이 사라지면 카드도 사라진다(list는 최신 스냅샷).
  const entry = hover ? list.find((e) => e.id === hover.id) : undefined;
  // 카드가 이웃 pane(브라우저 셀일 수 있다) 위로 나간다 — 그려지는 동안만 네이티브 webview를 숨긴다.
  // hover가 아니라 entry 기준: 항목이 사라져 카드가 없는데 webview만 숨는 구간을 없앤다.
  useOccludesWebview(!!entry);

  return (
    <div className="flex w-[15%] min-w-[110px] shrink-0 flex-col border-l border-edge bg-panel text-[11px]">
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1 text-[10px] text-fg-dim">
        <History size={11} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">
          {msg.git.termSession.promptCount(list.length)}
        </span>
        {list.length > 0 && (
          <button
            onClick={() => clear(termId)}
            title={msg.git.termSession.clearHistoryTitle}
            className="shrink-0 rounded p-0.5 hover:bg-raised hover:text-danger"
          >
            <Trash2 size={11} />
          </button>
        )}
        <button
          onClick={() => togglePanel(termId)}
          title={msg.git.paneMenu.closePromptList}
          className="shrink-0 rounded p-0.5 hover:bg-raised hover:text-fg"
        >
          <X size={11} />
        </button>
      </div>
      {/* 스크롤은 캡처해 둔 rect를 스테일하게 만든다 — 숨기고 다음 enter에서 새로 잰다.
          onScroll은 React 17+에서 버블하지 않으므로 스크롤 컨테이너에 직접 단다. */}
      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={hide} onScroll={hide}>
        {/* 최신이 위 — 스크롤 없이도 방금 친 것이 바로 보인다(실시간 곁눈질이 이 패널의 존재 이유). */}
        {list
          .slice()
          .reverse()
          .map((e) => (
            <button
              key={e.id}
              onClick={() => copy(e.text)}
              onMouseEnter={(ev) => onItemEnter(e.id, ev.currentTarget)}
              // native title 없음 — 호버 카드와 이중 표시가 된다(헤더 버튼 title은 유지).
              className="block w-full border-b border-edge/40 px-2 py-1 text-left last:border-b-0 hover:bg-raised"
            >
              <div className="line-clamp-3 break-words text-[11px] leading-4 text-fg">
                {e.text}
              </div>
              <div className="mt-0.5 text-[9px] text-fg-dim">{relativeTime(e.at)}</div>
            </button>
          ))}
        {list.length === 0 && (
          <div className="px-2 py-3 text-[10px] leading-4 text-fg-dim">
            {msg.git.termSession.noPrompts}
          </div>
        )}
      </div>
      {entry && hover && <PromptHoverCard entry={entry} rect={hover.rect} />}
    </div>
  );
}

/** 카드 본문 줄 상한 — 더 긴 전문은 클릭 복사로 얻는다(곁눈질 패널이라 스크롤을 두지 않는다). */
const CARD_MAX_LINES = 30;

/** 호버 중인 항목 — rect는 enter 시점의 정적 스냅샷(left/top/bottom만 쓴다). */
type Hover = { id: string; rect: DOMRect };

/**
 * 항목 왼쪽에 뜨는 비상호작용 카드(DragGhost와 같은 계열). 셀 래퍼가 overflow-hidden이라 fixed로
 * 뷰포트에 붙이고, pointer-events-none이라 좁은 셀에서 항목을 덮어도 hover가 끊기지 않는다.
 * 스크롤·Escape 없음 — Escape 핸들러를 달면 hover 중 Esc가 xterm을 지나 PTY로 들어가 TUI의
 * 진행 중 턴을 끊는다(terminal-engine이 Escape를 가로채지 않는다).
 */
function PromptHoverCard({ entry, rect }: { entry: PromptEntry; rect: DOMRect }) {
  const msg = useMessages();
  const lines = entry.text.split("\n");
  // 항목 왼쪽 여유에서 좌우 8px씩 뺀 폭. 하한 240이 발동하면 카드가 항목을 덮지만 hit-test에서
  // 빠져 있어 무해하고, 덮은 그 항목의 전문을 카드가 보여주므로 정보 손실도 없다.
  const W = Math.max(240, Math.min(480, rect.left - 16));
  const left = Math.max(8, rect.left - 8 - W);
  const below = rect.top < window.innerHeight / 2; // ChangesPanel의 세로 뒤집기 규칙
  // 30줄 카드는 ≈676px라 720px 창에서는 60vh(432px)로도 넘친다 — 앵커 쪽 여유로 직접 조인다.
  // 헤더·푸터는 shrink-0이라 항상 보이고 본문만 잘린다.
  const space = (below ? window.innerHeight - rect.top : rect.bottom) - 8;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 flex flex-col overflow-hidden rounded-md border border-edge bg-panel shadow-xl"
      style={{
        left,
        width: W,
        maxHeight: Math.max(120, space),
        ...(below ? { top: rect.top } : { bottom: window.innerHeight - rect.bottom }),
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2.5 py-1 text-[10px] text-fg-muted">
        <History size={11} className="shrink-0 text-accent" />
        <span>{fmtTime(new Date(entry.at))}</span>
        <span>{msg.git.termSession.cardStats(lines.length, entry.text.length)}</span>
      </div>
      <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-5 text-fg">
        {lines.slice(0, CARD_MAX_LINES).join("\n")}
      </pre>
      {lines.length > CARD_MAX_LINES && (
        <div className="shrink-0 border-t border-edge px-2.5 py-1 text-[10px] text-fg-muted">
          {msg.git.termSession.cardMoreLines(lines.length - CARD_MAX_LINES)}
        </div>
      )}
      <div className="shrink-0 px-2.5 pb-1.5 text-[10px] text-fg-muted">
        {msg.git.termSession.clickToCopy}
      </div>
    </div>
  );
}
