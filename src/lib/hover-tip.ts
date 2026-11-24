// 모아보기 셀 헤더의 툴팁(로고·세션 제목 등 메뉴가 없는 것) — 네이티브 title 툴팁은 늦게 뜨고 무슨 버튼인지 알아보기 어렵다는 요청(2026-11-24)으로
// 호버 즉시 문구 전체를 보여 준다. title 속성은 그대로 둔다: e2e 가 `button[title="…"]` 로 버튼을 찾고, 접근성 이름도 된다.
// 호버하는 동안만 title 을 떼어 두어 네이티브 툴팁이 겹쳐 뜨지 않게 한다.
//
// 툴팁은 셀 본문이 아니라 **헤더 줄 위에** 겹친다 — 본문 쪽은 브라우저 셀의 네이티브 웹뷰가 DOM 을 덮고,
// 확대·에이전트 아이콘의 호버 메뉴도 그 아래로 열린다.
// 호버 메뉴가 뜨는 버튼(`data-hover-menu`, TermSessionControls useHoverMenu)은 메뉴가 곧 설명이라 툴팁은 안 띄우고,
// 네이티브 툴팁이 메뉴 위에 겹치지 않게 title 만 떼어 둔다 — 모아보기 밖(작업 화면 패널)에서도.
const TIP_SCOPE = "[data-agg-cell-header] [title], [data-hover-menu][title]";
const SHOW_DELAY_MS = 150;
const GAP_PX = 4;

let installed = false;

export function installHoverTips(): void {
  if (installed) return;
  installed = true;

  let tip: HTMLDivElement | null = null;
  let timer: number | undefined;
  let held: { el: Element; title: string } | null = null;

  const hide = () => {
    window.clearTimeout(timer);
    tip?.remove();
    tip = null;
    if (held) {
      // 호버 중에 React 가 title 을 새 값으로 다시 썼으면 그게 최신이다 — 옛 값으로 덮지 않는다.
      if (!held.el.hasAttribute("title")) held.el.setAttribute("title", held.title);
      held = null;
    }
  };

  const show = (el: Element, text: string) => {
    const header = el.closest("[data-agg-cell-header]");
    if (!el.isConnected || !header) return;
    const r = el.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    tip = document.createElement("div");
    tip.className =
      "pointer-events-none fixed z-[70] flex items-center rounded border border-edge bg-panel px-2 py-0.5 text-[11px] leading-snug text-fg shadow-xl";
    tip.textContent = text.replace(/\n+/g, " · ");
    tip.style.top = `${h.top}px`;
    tip.style.minHeight = `${h.height}px`;
    // 아이콘 왼쪽으로 펼친다(아이콘들이 헤더 오른쪽 끝에 모여 있다). 왼쪽 자리가 너무 좁으면 오른쪽으로.
    const leftRoom = r.left - GAP_PX * 2;
    if (leftRoom >= 200) {
      tip.style.right = `${window.innerWidth - r.left + GAP_PX}px`;
      tip.style.maxWidth = `${leftRoom}px`;
    } else {
      tip.style.left = `${r.right + GAP_PX}px`;
      tip.style.maxWidth = `${window.innerWidth - r.right - GAP_PX * 2}px`;
    }
    document.body.appendChild(tip);
  };

  document.addEventListener("pointerover", (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest(TIP_SCOPE) ?? (held?.el.contains(e.target) ? held.el : null);
    if (el === held?.el) return;
    hide();
    const text = el?.getAttribute("title");
    if (!el || !text) return;
    el.removeAttribute("title");
    held = { el, title: text };
    if (!el.hasAttribute("data-hover-menu")) timer = window.setTimeout(() => show(el, text), SHOW_DELAY_MS);
  });
  document.addEventListener("pointerout", (e) => {
    if (held && !(e.relatedTarget instanceof Node && held.el.contains(e.relatedTarget))) hide();
  });
  // 누르면(메뉴·대화상자가 열린다) 툴팁은 걸리적거린다.
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("wheel", hide, { capture: true, passive: true });
  window.addEventListener("blur", hide);
}
