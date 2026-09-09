// 편집기 키 스코프 — 편집기가 열려 있는 동안 window **capture** 단계 리스너 하나가 먼저 본다.
//
// 이 훅이 존재하는 이유는 하나다: 앱에는 이미 `window` keydown 리스너가 25곳 있고, 그것들은
// 편집기가 열렸는지 모른다. 실제로 부딪히는 것들:
//   - `KeyboardShortcuts.tsx:122` 가 `k==='k'` 에서 `altKey` 를 안 봐서 `Ctrl+Alt+Shift+K`
//     (시안 ⑧ 간격 정리)가 **git push** 를 쏜다.
//   - `Ctrl+W` 가 편집기 뒤의 뷰어 탭을 닫는다.
//   - `DiffViewer` 의 mod+Shift+O 가 Monaco 로 포커스를 뺏어 간다.
//   - `terminal.ts` 의 Ctrl+C 폴백이 터미널 선택을 대신 복사하고 `preventDefault` 한다.
//
// 버블 단계로는 못 막는다 — App 마운트 리스너가 lazy 편집기 리스너보다 **먼저 등록**되므로
// 먼저 실행된다. capture 는 등록 순서와 무관하게 버블보다 앞서고, `window.dispatchEvent` 로
// 오는 at-target 이벤트에서도 capture 리스너가 먼저다(DOM 규격, Chromium 89+). 그래서
// 25곳을 한 줄도 고치지 않고 편집기가 필요한 키만 가로챈다 — 나머지는 그대로 흘러
// F5·Ctrl+P·mod+Shift+F 가 편집기 안에서도 산다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.3

import { useEffect, useRef } from "react";

import {
  EDITOR_SHORTCUTS,
  matchShortcut,
  type ShortcutId,
} from "../../lib/annotate/shortcuts";
import type { Node } from "../../lib/annotate/types";
import type { Mode } from "../../stores/imageEditor";

export interface EditorKeyContext {
  mode: Mode;
  sel: number;
  selKinds: Set<Node["kind"]>;
  textEditing: boolean;
}

export interface EditorKeyOpts {
  /** 팝오버·플라이아웃이 열려 있는가 — 열려 있으면 Escape 만 받는다(계층 0). */
  popoverOpen: () => boolean;
  /** 위 컨텍스트를 **호출 시점에** 읽는다. 스토어 값이 리스너 재등록 없이 최신이어야 한다. */
  context: () => EditorKeyContext;
  /** 앱 전역 확인창·프롬프트가 떠 있는가 — 떠 있으면 전부 통과시킨다(그쪽 리스너가 처리). */
  blocked: () => boolean;
}

/**
 * 소비 여부는 **표가 정한다** — 액션이 있는지가 아니다.
 *
 * 처음엔 "주인 없는 행은 소비하지 않는다"(먹통 키 방지)로 짰는데, 그러면 `Ctrl+Alt+Shift+K`
 * (간격 정리, 주인은 45)가 앱 전역으로 새어 나가 **`git push` 확인창이 뜬다** — e2e 40 (c-8)이
 * 실제로 그걸 잡았다(`KeyboardShortcuts.tsx:122` 가 `altKey` 를 안 본다). 아직 아무 일도 안
 * 하는 키가 되는 쪽이, 그림을 그리다 누른 키가 원격 저장소로 나가는 것보다 낫다.
 */
const CONSUME = new Set(
  EDITOR_SHORTCUTS.filter((s) => s.consume).map((s) => s.id),
);

/** 포커스가 글자 입력 요소에 있는가 — 있으면 편집기 키를 잡지 않는다. */
function inTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable === true
  );
}

/**
 * 단축키 표를 액션 맵에 잇는다. 다른 태스크는 **표에 행을 추가하고 이 맵에 핸들러를 넣는다** —
 * `window` 리스너를 새로 달지 않는다. 리스너가 둘이 되는 순간 어느 쪽이 먼저 먹는지가
 * 등록 순서에 달리고, 그건 lazy 로딩 타이밍에 따라 실행마다 달라진다.
 */
export function useEditorKeys(
  actions: Partial<Record<ShortcutId, (e: KeyboardEvent) => void>>,
  opts: EditorKeyOpts,
): void {
  // 리스너는 한 번만 달고 최신 값은 ref 로 본다 — 액션 맵이 매 렌더 새 객체라
  // 의존성에 넣으면 초당 수십 번 재등록된다(그 사이에 들어온 키가 샌다).
  const a = useRef(actions);
  a.current = actions;
  const o = useRef(opts);
  o.current = opts;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const g = o.current;
      // ① 확인창·프롬프트가 위에 있으면 전부 그쪽 것이다.
      if (g.blocked()) return;

      const ctx = g.context();
      const isEscape = e.key === "Escape";

      // ② 팝오버·플라이아웃이 열려 있으면 Escape 로 그것만 닫는다(Esc 계층 0).
      if (g.popoverOpen() && !isEscape) return;

      // ③ 텍스트 편집 중에는 글자가 그대로 들어가야 한다 — 표 판정(when:'textEdit')에 맡기고
      //    여기서는 Escape 만 예외로 통과시킨다(계층 2, 텍스트 확정).
      // ④ NumField·검색창처럼 **편집기 안의 입력 요소**에 포커스가 있으면 전부 통과시킨다.
      //    Esc 도 그 필드가 처리해야 한다(e2e 30 (p-4) 가 이 동작을 잡고 있다).
      if (!ctx.textEditing && inTextField()) return;

      const id = matchShortcut(e, ctx);
      if (!id) return;
      // 홀드 도구(Space=손)는 auto-repeat 를 무시한다 — 반복 keydown 마다 `temporary` 로
      // 다시 들어가면 `prevTool` 이 'hand' 로 덮여 손을 뗐을 때 돌아갈 도구가 사라진다.
      if (id === "hand" && e.repeat) {
        e.preventDefault();
        return;
      }
      if (!CONSUME.has(id)) return;
      e.preventDefault();
      // stopImmediatePropagation 까지 해야 같은 window 의 다른 capture 리스너도 멈춘다.
      e.stopImmediatePropagation();
      // 주인이 아직 없는 행은 여기서 끝난다 — 막기만 하고 아무 일도 하지 않는다.
      a.current[id]?.(e);
    };

    // Space 홀드(손 도구)는 떼는 순간 원래 도구로 돌아가야 한다 — keydown 만으로는
    // "누르고 있는 동안"을 표현할 수 없다. 액션은 `e.type` 으로 누름/뗌을 가른다
    // (`hand: (e) => e.type === "keyup" ? restoreTool() : setTool("hand", {temporary:true})`).
    //
    // 홀드는 `code` 로 직접 가른다 — `matchShortcut` 은 못 쓴다. 실제 브라우저의 Alt keyup 은
    // `altKey === false` 로 오므로 표의 `Alt` 행(`k.alt === !!e.altKey`)에 절대 안 맞는다.
    // AltRight(한/영)는 뺀다(43 §3.7 위험표). 이 줄이 Space 만 보면 Alt 를 떼도 측정 크롬이
    // 화면에 굳는다 — 포인터가 멈춰 있으면 지울 다른 경로가 없다(pointermove 안에만 있다).
    const HOLD: Record<string, ShortcutId> = {
      Space: "hand",
      AltLeft: "measure.hold",
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const g = o.current;
      if (g.blocked()) return;
      const id = HOLD[e.code];
      const release = id ? a.current[id] : null;
      if (!release) return;
      e.preventDefault();
      release(e);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, []);
}
