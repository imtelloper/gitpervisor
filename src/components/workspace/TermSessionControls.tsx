// 터미널 세션 공용 컨트롤 — 컬러 테마(ThemeButton) · 프롬프트 기록(PromptLogButton +
// PromptSidePanel) · 전체 프롬프트 컬럼 마스터 토글(PromptHistoryButton). 원래 모아보기 셀
// 헤더(AggregateTerminals) 전용이었는데, 워크스페이스 터미널 패널에도 같은 기능을 붙이면서
// 여기로 뽑았다. 세션 단위 컨트롤의 상태는 전부 **세션(termId=paneId) 단위 스토어**
// (termThemes/promptHistory)라 어디서 그리든 같은 세션 = 같은 상태다. 마스터 토글만 창의
// 모든 세션을 대상으로 하며, 메인 타이틀바와 모아보기 별도 창 헤더가 함께 쓴다.
import { Check, History, Palette, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { copyText } from "../../lib/clipboard";
import { relativeTime } from "../../lib/format";
import { TERM_SCHEMES } from "../../lib/term-color-schemes";
import { useOccludesWebview } from "../../stores/occlusion";
import { usePromptHistory, type PromptEntry } from "../../stores/promptHistory";
import { useTermThemes } from "../../stores/termThemes";
import { collectByContent, useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";

/**
 * 이 세션의 컬러 스킴 선택 — 팔레트 버튼. 여러 세션을 색으로 구분하는 용도라, 선택은
 * **세션(termId) 단위**로 저장돼(termThemes 스토어) 그 세션이 닫히지 않는 한 유지된다
 * (모아보기를 닫거나 앱을 재시작해도 — dropPane에서만 지운다).
 * 메뉴는 버튼 rect 기준 fixed + 백드롭 — 부모가 overflow-hidden이라 안에 그리면 잘린다.
 */
export function ThemeButton({ termId }: { termId: string }) {
  const current = useTermThemes((s) => s.byTerminal[termId]);
  const setScheme = useTermThemes((s) => s.setScheme);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{
    right: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  // 열린 동안 네이티브 webview를 숨긴다 — 브라우저 셀/패널이 이 메뉴를 덮지 않게.
  useOccludesWebview(!!menu);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const close = () => setMenu(null);
  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // 버튼이 화면 우측일 수 있으니 우측 모서리 정렬. 메뉴 실높이(~290px)가 하단에서는
    // 아래 여유를 넘으므로, 부족하면 버튼 **위**로 뒤집는다(PromptLogButton과 같은 규칙).
    // 아주 낮은 창에서 양쪽 다 모자라는 극단은 maxHeight + 스크롤이 안전망.
    const right = Math.max(8, window.innerWidth - r.right);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    if (below >= 300 || below >= above)
      setMenu({ right, top: r.bottom + 4, maxHeight: Math.max(140, Math.min(below, 320)) });
    else
      setMenu({
        right,
        bottom: window.innerHeight - r.top + 4,
        maxHeight: Math.max(140, Math.min(above, 320)),
      });
  };
  const pick = (id: (typeof TERM_SCHEMES)[number]["id"] | null) => {
    setScheme(termId, id);
    close();
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (menu ? close() : open())}
        title="이 터미널의 컬러 테마 — 세션이 닫힐 때까지 유지됩니다"
        className={`shrink-0 rounded p-0.5 ${
          menu || current
            ? "bg-raised text-accent"
            : "text-fg-dim hover:bg-raised hover:text-fg"
        }`}
      >
        <Palette size={12} />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="fixed z-50 w-[210px] overflow-y-auto rounded-md border border-edge bg-panel py-1 text-[12px] shadow-xl"
            style={{
              right: menu.right,
              top: menu.top,
              bottom: menu.bottom,
              maxHeight: menu.maxHeight,
            }}
          >
            <button
              onClick={() => pick(null)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
            >
              <Palette size={12} className="shrink-0 text-fg-dim" />
              <span className="min-w-0 flex-1 truncate">앱 테마 (기본)</span>
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
                    <span
                      key={c}
                      className="size-[5px] rounded-full"
                      style={{ background: c }}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {current === s.id && (
                  <Check size={12} className="shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
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
  const count = usePromptHistory((s) => s.byTerminal[termId]?.length ?? 0);
  const open = usePromptHistory((s) => !!s.openPanels[termId]);
  const togglePanel = usePromptHistory((s) => s.togglePanel);
  return (
    <button
      onClick={() => togglePanel(termId)}
      title={`입력한 프롬프트 ${count}개 — 클릭하면 우측 목록을 ${open ? "닫습니다" : "엽니다"}`}
      className={`flex shrink-0 items-center gap-0.5 rounded p-0.5 ${
        open ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"
      }`}
    >
      <History size={12} />
      {count > 0 && (
        <span className="text-[9px] leading-none tabular-nums">{count}</span>
      )}
    </button>
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
          ? "전체 프롬프트 목록 접기 — 이 창의 모든 터미널 우측의 입력 목록을 닫습니다"
          : "전체 프롬프트 목록 펼치기 — 이 창의 모든 터미널 우측에 입력 목록을 엽니다"
      }
      className={`flex items-center gap-1 rounded ${
        allOpen
          ? "bg-raised text-accent"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      } ${className ?? "mr-2.5 px-1.5 py-0.5 text-[10px]"}`}
    >
      <History size={11} /> 히스토리
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
  const entries = usePromptHistory((s) => s.byTerminal[termId]);
  const clear = usePromptHistory((s) => s.clear);
  const togglePanel = usePromptHistory((s) => s.togglePanel);
  const pushToast = useUi((s) => s.pushToast);
  const list = entries ?? [];
  const copy = (text: string) => {
    void copyText(text).then((ok) =>
      pushToast(
        ok ? "success" : "error",
        ok ? "프롬프트를 복사했습니다" : "복사에 실패했습니다",
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
        <span className="min-w-0 flex-1 truncate">프롬프트 {list.length}</span>
        {list.length > 0 && (
          <button
            onClick={() => clear(termId)}
            title="이 터미널의 기록 지우기"
            className="shrink-0 rounded p-0.5 hover:bg-raised hover:text-danger"
          >
            <Trash2 size={11} />
          </button>
        )}
        <button
          onClick={() => togglePanel(termId)}
          title="프롬프트 목록 닫기"
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
            아직 입력한 프롬프트가 없습니다. Enter로 확정한 줄이 여기 쌓입니다.
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
        <span>{new Date(entry.at).toLocaleTimeString()}</span>
        <span>
          · {lines.length}줄 · {entry.text.length}자
        </span>
      </div>
      <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-5 text-fg">
        {lines.slice(0, CARD_MAX_LINES).join("\n")}
      </pre>
      {lines.length > CARD_MAX_LINES && (
        <div className="shrink-0 border-t border-edge px-2.5 py-1 text-[10px] text-fg-muted">
          … 외 {lines.length - CARD_MAX_LINES}줄
        </div>
      )}
      <div className="shrink-0 px-2.5 pb-1.5 text-[10px] text-fg-muted">클릭하면 복사</div>
    </div>
  );
}
