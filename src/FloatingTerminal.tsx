import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { FloatTitleBar } from "./components/FloatTitleBar";
import { PaneTreeRoot } from "./components/workspace/PaneTree";
import { floatPoolReady } from "./lib/floating";
import { ipc } from "./lib/ipc";
import {
  createTerminal,
  disposeTerminal,
  refreshTerminalThemes,
} from "./lib/terminal";
import { useSettings } from "./queries";
import { collectPanes, useTerminals } from "./stores/terminals";

const FONT = 13;

/**
 * 별도 OS 창으로 분리된 터미널 워크스페이스. 메인 창이 만든 살아있는 PTY(paneId)에 term_attach로
 * 재연결한 뒤, 그 위에 자체 분할 트리(우클릭 분할 메뉴 + Ctrl+Shift+D/E 분할 + Ctrl+W 닫기)를
 * 올린다. 플로팅 창의 useTerminals 스토어는 메인과 독립이다(영속 안 함 — stores/terminals IS_FLOAT).
 *
 * paneId=null은 **프리워밍 풀 창**(라벨 float-pool-*) — 숨긴 채 부트를 끝내 두고 분리 클릭 시
 * claim 이벤트로 paneId를 배정받아 그때 attach한다(창 생성·번들 로드 시간이 0이 되는 경로).
 */
export function FloatingTerminal({ paneId: fixedPaneId }: { paneId: string | null }) {
  const [paneId, setPaneId] = useState(fixedPaneId);
  const [tabId, setTabId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const { data: settings } = useSettings();

  // 풀 모드 — claim(paneId 배정)을 기다린다. 리스너를 **먼저** 무장하고 ready를 신고해야
  // 이벤트가 유실되지 않는다(핸드셰이크). 브로드캐스트라 라벨로 내 것만 거른다.
  useEffect(() => {
    if (fixedPaneId) return;
    // 대기 중에 터미널 엔진 청크(xterm 포함)를 선로딩 — claim 후 첫 createTerminal이
    // dynamic import를 기다리지 않는다(분리 클릭 → 표시까지의 꼬리 비용 제거).
    void import("./lib/terminal-engine");
    const myLabel = getCurrentWebviewWindow().label;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ label: string; paneId: string }>("float://claim", (e) => {
      if (e.payload.label === myLabel) setPaneId(e.payload.paneId);
    }).then((un) => {
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
      floatPoolReady();
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fixedPaneId]);

  // 이 창에도 저장된 테마 적용 — 로드 전엔 main.tsx의 localStorage 선적용 값이 유지된다.
  // (창이 열린 뒤 메인 창에서 바꾼 테마의 실시간 브로드캐스트는 후속 — 창이 단명이라 저빈도)
  useEffect(() => {
    if (!settings?.theme) return;
    document.documentElement.dataset.theme = settings.theme;
    refreshTerminalThemes(); // attach된 xterm은 생성 시 테마가 박제 — 확정값으로 재적용
  }, [settings?.theme]);

  useEffect(() => {
    if (!paneId) return; // 풀 창 — claim 전엔 attach할 대상이 없다
    let cancelled = false;
    void (async () => {
      const pid = (await ipc.termProject(paneId).catch(() => null)) ?? "";
      // 선-attach: TerminalPane이 createTerminal({id})를 호출할 때 새 PTY를 열지 않고 이 살아있는
      // 세션을 재사용하도록 레지스트리에 먼저 등록한다(멱등). attachTerminal은 TerminalPane이 한다.
      await createTerminal({
        id: paneId,
        projectId: pid,
        fontSize: FONT,
        attach: true,
      });
      if (cancelled) return;
      const id = crypto.randomUUID();
      // 플로팅 창의 독립 스토어에 floated 패널 하나짜리 탭을 시드한다.
      useTerminals.setState({
        terminals: [
          {
            id,
            projectId: pid,
            title: "터미널",
            layout: { kind: "leaf", paneId, content: "terminal" },
            activePaneId: paneId,
            maximizedPaneId: null,
          },
        ],
        activeTab: { [pid]: id },
        paneStatus: { [paneId]: "live" },
      });
      setProjectId(pid);
      setTabId(id);
      void emit("float://ready", { paneId });
    })();
    return () => {
      cancelled = true;
    };
  }, [paneId]);

  if (!tabId) return <div className="h-screen w-screen bg-base" />;
  return <FloatWorkspace tabId={tabId} projectId={projectId} />;
}

function FloatWorkspace({
  tabId,
  projectId,
}: {
  tabId: string;
  projectId: string;
}) {
  const tab = useTerminals((s) => s.terminals.find((t) => t.id === tabId));
  const [title, setTitle] = useState("터미널");

  // 타이틀에 프로젝트명 표시
  useEffect(() => {
    void ipc
      .listProjects()
      .then((ps) => {
        const name = ps.find((p) => p.id === projectId)?.name;
        if (name) setTitle(name);
      })
      .catch(() => {});
  }, [projectId]);

  // 분할/닫기 단축키 (Ctrl+Shift+D 우분할 · E 하분할 · W 활성 패널 닫기).
  // Ctrl+W(셸 단어삭제 대체)는 엔진이 포커스 패널 닫기로 처리하고, 2/4/8 그리드는 우클릭 메뉴에 있다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== "d" && k !== "e" && k !== "w") return;
      const ts = useTerminals.getState();
      const t = ts.terminals.find((x) => x.id === tabId);
      if (!t) return;
      e.preventDefault();
      if (k === "d") ts.splitPane(t.id, t.activePaneId, "row", false);
      else if (k === "e") ts.splitPane(t.id, t.activePaneId, "col", false);
      else ts.closePane(t.id, t.activePaneId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId]);

  // 창이 닫힐 때(언로드) 이 창의 모든 패널 PTY를 정리한다(분할로 생긴 새 PTY 누수 방지 —
  // 베스트 에포트). onCloseRequested는 close를 막아버려서 beforeunload로 정리만 한다.
  useEffect(() => {
    const onUnload = () => {
      const ts = useTerminals.getState();
      ts.terminals.forEach((t) =>
        collectPanes(t.layout).forEach((p) => void disposeTerminal(p)),
      );
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // 마지막 패널까지 닫으면(탭 소멸) 창을 닫는다.
  useEffect(() => {
    if (!tab) void getCurrentWindow().close();
  }, [tab]);

  if (!tab) return null;
  return (
    <div className="flex h-screen flex-col bg-base">
      <FloatTitleBar title={title} />
      <div className="min-h-0 flex-1">
        <PaneTreeRoot tab={tab} projectId={projectId} fontSize={FONT} />
      </div>
    </div>
  );
}
