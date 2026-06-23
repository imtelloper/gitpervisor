import { useCallback, useEffect, useRef } from "react";

import { mergeVars, resolveRequest } from "../../lib/apiclient";
import { useApiClient } from "../../stores/apiclient";
import { useUi } from "../../stores/ui";
import { CollectionSidebar } from "./CollectionSidebar";
import { EnvDialog } from "./EnvDialog";
import { RequestBuilder } from "./RequestBuilder";
import { RequestTabs } from "./RequestTabs";
import { ResponsePanel } from "./ResponsePanel";

/** 요청 노드를 루트까지 거슬러 최상위 폴더(컬렉션) id 반환(저장 위치 결정용). */
function topCollectionOf(
  nodes: ReturnType<typeof useApiClient.getState>["nodes"],
  nodeId: string | null,
): string | null {
  let cur = nodeId;
  let top: string | null = null;
  while (cur) {
    const n = nodes[cur];
    if (!n) break;
    if (n.parentId) top = n.parentId;
    cur = n.parentId;
  }
  return top;
}

/**
 * API 클라이언트 탭 루트(§8.1) — 3컬럼(사이드바/빌더/응답) + 탭 스코프 단축키.
 * - lazy 대상(named export). monaco는 탭을 처음 열 때만 끌려온다.
 * - 패널 폭은 CollectionSidebar / ResponsePanel이 각각 usePanelWidth로 영속(×2).
 */
export function ApiClientTab({
  tabId,
  projectId,
}: {
  tabId: string;
  projectId: string;
}) {
  const urlRef = useRef<HTMLInputElement>(null);
  const pushToast = useUi((s) => s.pushToast);

  // 탭 스코프 단축키(§8.6) — 탭 활성 시에만 마운트되므로 전역 충돌 없음.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const st = useApiClient.getState();

      // Esc — 열린 EnvDialog 닫기
      if (e.key === "Escape" && st.envDialogOpen) {
        e.preventDefault();
        st.closeEnvDialog();
        return;
      }

      if (!ctrl) return;

      // Ctrl+Enter — Send
      if (e.key === "Enter") {
        e.preventDefault();
        const draft = st.draftById[tabId];
        if (draft) {
          const { unresolved } = resolveRequest(
            draft,
            mergeVars(st, st.items[tabId]?.requestNodeId ?? null).vars,
            [],
            { kind: "none" },
          );
          if (unresolved.length > 0)
            pushToast(
              "info",
              `정의되지 않은 변수: ${unresolved.map((u) => `{{${u}}}`).join(", ")}`,
            );
        }
        void st.send(tabId);
        return;
      }

      // Ctrl+S — 현재 요청을 컬렉션에 저장
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        const item = st.items[tabId];
        const collId = topCollectionOf(st.nodes, item?.requestNodeId ?? null);
        st.saveDraft(tabId, collId);
        pushToast("success", "요청을 저장했습니다");
        return;
      }

      // Ctrl+L — URL 입력 포커스
      if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        urlRef.current?.focus();
        urlRef.current?.select();
        return;
      }
    },
    [tabId, pushToast],
  );

  // 탭 언마운트 시 in-flight 요청 정리(§9.1.4) — closeTab과 별개로 안전망.
  useEffect(() => {
    return () => {
      const st = useApiClient.getState();
      if (st.sending[tabId]) st.abort(tabId);
    };
  }, [tabId]);

  return (
    <div className="flex h-full min-w-0 outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <CollectionSidebar tabId={tabId} projectId={projectId} />
      <div className="flex min-w-0 flex-1 flex-col bg-base">
        <RequestBuilder ref={urlRef} tabId={tabId} />
        <RequestTabs tabId={tabId} />
      </div>
      <ResponsePanel tabId={tabId} />
      <EnvDialog />
    </div>
  );
}
