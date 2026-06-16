import { useEffect, useRef } from "react";

import { usePushFlow, useRefreshAll, useSyncOp } from "../queries";
import { useTerminals } from "../stores/terminals";

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
        const ts = useTerminals.getState();
        const active = ts.activeTab[projectId] ?? "viewer";
        if (active !== "viewer") {
          ts.setActiveTab(projectId, "viewer");
          return;
        }
        const terms = ts.terminals.filter((t) => t.projectId === projectId);
        if (terms.length) ts.setActiveTab(projectId, terms[terms.length - 1].id);
        else ts.openTerminal(projectId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}
