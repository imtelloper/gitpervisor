import { useEffect, useRef } from "react";

import { openAggregateWindow } from "../lib/aggregate-window";
import { isMod } from "../lib/platform";
import { usePushFlow, useRefreshAll, useSyncOp } from "../queries";
import { useSearch } from "../stores/search";
import { useTerminals } from "../stores/terminals";
import { selectActiveDiff, useUi, viewerTabKey } from "../stores/ui";

/**
 * 항상-마운트 전역 단축키 — KeyboardShortcuts는 모아보기가 열리거나 프로젝트 미선택이면
 * 언마운트되므로(App), 그 상태에서도 동작해야 하는 키는 여기 등록한다.
 * mod+Shift+A: 터미널 모아보기 토글(mac=Cmd, 그 외=Ctrl). 최신 상태는 getState()로 참조.
 */
export function GlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMod(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // 별도 창으로 나가 있으면 메인 안에서 또 열지 않는다 — 같은 터미널을 두 곳에서
        // 그리면 attach를 서로 뺏어 한쪽이 멈춘다. 대신 그 창을 앞으로 가져온다.
        if (useUi.getState().aggregateWindowOpen) openAggregateWindow();
        else useUi.getState().toggleAggregate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}

/**
 * 전역 키보드 단축키 (설계 §5.3):
 * F5 새로고침 · Ctrl+K 커밋 · Ctrl+Shift+K 푸시 · Ctrl+T pull · Ctrl+` 터미널 토글.
 * 선택된 프로젝트가 있을 때만 마운트되므로 projectId는 항상 유효하다.
 * 핸들러는 ref로 최신 액션을 참조해 리스너를 한 번만 등록한다.
 */
export function KeyboardShortcuts({ projectId }: { projectId: string }) {
  const refreshAll = useRefreshAll();
  const pull = useSyncOp(projectId, "pull");
  const push = usePushFlow(projectId);

  const ref = useRef({ refreshAll, pull, push });
  ref.current = { refreshAll, pull, push };
  // projectId는 prop으로 매 렌더 바뀌지만 onKey는 []로 1회만 등록돼 클로저가 첫 projectId에
  // 고착된다 → 프로젝트 전환 후 단축키가 "엉뚱한(예전) 프로젝트"를 대상으로 동작(=안 먹는 것처럼
  // 보임). ref로 최신 projectId를 참조해 항상 현재 선택 프로젝트에 적용한다.
  const pidRef = useRef(projectId);
  pidRef.current = projectId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const actions = ref.current;
      if (e.key === "F5") {
        e.preventDefault();
        actions.refreshAll();
        return;
      }
      // mod+P: Quick Open 토글 — ctrlKey 게이트 앞에서 isMod로 검사(mac Cmd 통과).
      // 마운트 조건(프로젝트 선택+모아보기 아님)이 곧 활성 조건이라 별도 가드 불필요.
      // preventDefault로 WebView2 인쇄 액셀러레이터 억제(Chromium 관례).
      if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        const ui = useUi.getState();
        ui.setQuickOpenOpen(!ui.quickOpenOpen);
        return;
      }
      // mod+Alt+N: Go to Symbol 토글 (전역 심볼 검색). ctrlKey 게이트 앞 — isMod로 mac 통과.
      if (isMod(e) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const ui = useUi.getState();
        ui.setSymbolSearchOpen(!ui.symbolSearchOpen);
        return;
      }
      // mod+Shift+F: Find in Files 패널 토글/재포커스.
      if (isMod(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        useSearch.getState().setOpen(true);
        return;
      }
      // 터미널 토글만 **세 플랫폼 모두 Ctrl+`** 로 남긴다. macOS 의 ⌘` 는 시스템이 "같은 앱의
      // 창 순환"에 이미 쓰고 있어 가로챌 수 없고, VS Code 도 mac 에서 ⌃` 를 쓴다.
      // mod 게이트 **앞**이어야 한다 — 그 게이트는 mac 에서 metaKey 만 통과시킨다.
      // Shift 는 보지 않는다 — JIS 배열은 ` 자체가 Shift+@ 라 Ctrl+` 가 shiftKey=true 로 온다.
      if (e.ctrlKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        const pid = pidRef.current;
        const ts = useTerminals.getState();
        const active = ts.activeTab[pid] ?? "viewer";
        if (active !== "viewer") {
          ts.setActiveTab(pid, "viewer");
          return;
        }
        const terms = ts.terminals.filter((t) => t.projectId === pid);
        if (terms.length) ts.setActiveTab(pid, terms[terms.length - 1].id);
        else ts.openTerminal(pid);
        return;
      }
      // 아래 분기들은 전부 **mod(+Shift) 전용**이다 — Alt가 눌린 조합은 여기서 통째로 막는다.
      // **Windows의 AltGr은 ctrlKey=true + altKey=true로 온다**: 국제 키보드로 `@`·`\`·`|`·`€`를
      // 치면 커밋·push·pull이 사용자 의도 없이 나갔다(Ctrl+Alt+Shift+K → 업스트림 설정 확인창
      // 실측 재현). 분기마다 !altKey를 붙이면 나중에 추가되는 분기가 또 빠뜨리므로 게이트로 막는다.
      // Alt를 **쓰는** 단축키(mod+Alt+N = Go to Symbol)는 이 위에서 이미 처리하고 return 한다.
      // mac 에서는 ⌘ 다. Ctrl 로 고정해 두면 ⌘W·⌘K 처럼 mac 사용자가 반사적으로 누르는 조합이
      // 죽고, 반대로 ⌃C(SIGINT)·⌃W(단어 삭제) 같은 **터미널 제어문자**를 앱이 가로챈다.
      if (!isMod(e) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Ctrl+Shift+D/E/W: 패널 분할/닫기. Viewer 탭이면 뷰어 패널, 그 밖(DB·브라우저 등)이면 터미널.
      // 대상 터미널 탭을 해석: 활성 터미널 → 이 프로젝트의 마지막 터미널 → 없으면 새로 연다.
      // (기존 버그: 활성 탭이 터미널이 아니면 그냥 무시돼서 단축키가 "안 먹는" 것처럼 보였다.)
      if (e.shiftKey && (k === "d" || k === "e" || k === "w")) {
        e.preventDefault();
        const pid = pidRef.current; // 현재 선택 프로젝트 (클로저 고착 방지)
        const ts = useTerminals.getState();
        // Viewer를 보고 있으면 **뷰어 패널**을 나눈다(태스크 64 §3.6). 터미널 탭에서는 불변.
        if ((ts.activeTab[pid] ?? "viewer") === "viewer") {
          const ui = useUi.getState();
          const pane = ui.viewerActivePaneId;
          if (k === "d") ui.splitViewerPane(pane, "row", false);
          else if (k === "e") ui.splitViewerPane(pane, "col", false);
          else ui.closeViewerPane(pane);
          return;
        }
        let tab = ts.terminals.find((t) => t.id === ts.activeTab[pid]);
        if (!tab) {
          const terms = ts.terminals.filter((t) => t.projectId === pid);
          tab = terms[terms.length - 1];
          if (tab) ts.setActiveTab(pid, tab.id); // 분할이 보이도록 터미널 탭으로 전환
        }
        if (!tab) {
          // 터미널이 하나도 없으면: d/e는 새 터미널을 열어준다(닫기는 대상 없음 → 무시).
          if (k !== "w") ts.openTerminal(pid);
          return;
        }
        if (k === "d") ts.splitPane(tab.id, tab.activePaneId, "row", false);
        else if (k === "e") ts.splitPane(tab.id, tab.activePaneId, "col", false);
        else ts.closePane(tab.id, tab.activePaneId);
        return;
      }
      // Ctrl+W(Shift 없음): 뷰어에서 현재 보고 있는 파일 탭 닫기. 터미널을 보고 있을 때는
      // activeTab이 viewer가 아니므로 건너뛴다(터미널 포커스의 Ctrl+W는 xterm 엔진이
      // 직접 소비해 패널을 닫는다 — terminal-engine.ts).
      if (k === "w" && !e.shiftKey) {
        const pid = pidRef.current;
        const ts = useTerminals.getState();
        if ((ts.activeTab[pid] ?? "viewer") !== "viewer") return;
        const ui = useUi.getState();
        const cur = selectActiveDiff(ui); // 활성 패널이 보고 있는 파일
        if (!cur) return; // 열린 파일 없음 — 조용히 무시
        e.preventDefault();
        const key = viewerTabKey(cur.target, cur.repoId, pid);
        if (ui.viewerTabs.some((t) => t.key === key)) ui.closeViewerTab(key);
        else ui.selectDiff(null); // 탭 없이 열린 선택(엣지) — 선택만 해제
        return;
      }
      // 터미널 포커스의 커밋·pull 은 무시한다. Windows/Linux 의 Ctrl+K/T 는 xterm 이 제어문자로
      // 소비해 여기 오지 않지만, mac 의 ⌘K(화면 지우기 습관)·⌘T(새 탭 습관)는 xterm 이 흘려보내
      // 확인 없이 커밋·pull 이 나갔다. Shift 조합(push)은 xterm 이 어느 플랫폼에서도 소비하지 않아
      // Windows 에서도 터미널에서 동작해 왔으므로 그대로 둔다.
      if (
        !e.shiftKey && (k === "k" || k === "t") &&
        (e.target as Element | null)?.closest?.(".xterm")
      ) return;
      if (k === "k") {
        e.preventDefault();
        if (e.shiftKey) actions.push();
        // Ctrl+K: 커밋 폼이 메시지를 들고 있으므로 이벤트로 위임
        else window.dispatchEvent(new CustomEvent("gitpervisor:commit"));
      } else if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        actions.pull.mutate(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}
