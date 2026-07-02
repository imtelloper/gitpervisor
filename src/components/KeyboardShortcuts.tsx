import { useEffect, useRef } from "react";

import { isMod } from "../lib/platform";
import { usePushFlow, useRefreshAll, useSyncOp } from "../queries";
import { useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";

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
        useUi.getState().toggleAggregate();
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
      if (!e.ctrlKey) return;
      const k = e.key.toLowerCase();
      // Ctrl+Shift+D/E/W: 터미널 패널 분할/닫기 — 어느 탭(Viewer/DB 등)을 보고 있어도 동작.
      // 대상 터미널 탭을 해석: 활성 터미널 → 이 프로젝트의 마지막 터미널 → 없으면 새로 연다.
      // (기존 버그: 활성 탭이 터미널이 아니면 그냥 무시돼서 단축키가 "안 먹는" 것처럼 보였다.)
      if (e.shiftKey && (k === "d" || k === "e" || k === "w")) {
        e.preventDefault();
        const pid = pidRef.current; // 현재 선택 프로젝트 (클로저 고착 방지)
        const ts = useTerminals.getState();
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
      if (k === "k") {
        e.preventDefault();
        if (e.shiftKey) actions.push();
        // Ctrl+K: 커밋 폼이 메시지를 들고 있으므로 이벤트로 위임
        else window.dispatchEvent(new CustomEvent("gitpervisor:commit"));
      } else if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        actions.pull.mutate(undefined);
      } else if (k === "`") {
        // Ctrl+`: 터미널 토글 — 터미널 보는 중이면 Viewer로, 아니면 마지막(없으면 새) 터미널로
        e.preventDefault();
        const pid = pidRef.current; // 현재 선택 프로젝트 (클로저 고착 방지)
        const ts = useTerminals.getState();
        const active = ts.activeTab[pid] ?? "viewer";
        if (active !== "viewer") {
          ts.setActiveTab(pid, "viewer");
          return;
        }
        const terms = ts.terminals.filter((t) => t.projectId === pid);
        if (terms.length) ts.setActiveTab(pid, terms[terms.length - 1].id);
        else ts.openTerminal(pid);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}
