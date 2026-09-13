import { invoke } from "@tauri-apps/api/core";
import { isMod } from "./lib/platform";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Toasts } from "./components/common/Toast";
import { TranslateHost } from "./components/common/TranslateCard";
import { FloatTitleBar } from "./components/FloatTitleBar";
import { PaneTreeRoot } from "./components/workspace/PaneTree";
import { PromptHistoryButton } from "./components/workspace/TermSessionControls";
import { floatPoolReady } from "./lib/floating";
import { ipc } from "./lib/ipc";
import {
  createTerminal,
  detachTerminalKeepPty,
  disposeTerminal,
  refreshTerminalThemes,
} from "./lib/terminal";
import { useSettings } from "./queries";
import { collectPanes, sendTerminalsCmd, useTerminals } from "./stores/terminals";

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

  // tabId는 paneId 효과 안에서만 세팅되므로 둘은 함께 있거나 함께 없다 — 타입 좁히기용 동시 검사.
  if (!tabId || !paneId) return <div className="h-screen w-screen bg-base" />;
  return <FloatWorkspace tabId={tabId} projectId={projectId} ownPaneId={paneId} />;
}

function FloatWorkspace({
  tabId,
  projectId,
  ownPaneId,
}: {
  tabId: string;
  projectId: string;
  /** 이 창의 대표 pane(라벨 접미사 또는 풀 claim으로 받은 id) — Rust Destroyed 훅이 PTY를 죽일 때
   *  조회하는 유일한 id라, 되돌리기의 우회 등록도 이것 하나만 한다(redock 주석). */
  ownPaneId: string;
}) {
  const tab = useTerminals((s) => s.terminals.find((t) => t.id === tabId));
  const [title, setTitle] = useState("터미널");
  // 되돌리기 진행 중 — 연타하면 같은 pane에 openTerminal 명령이 두 번 나가 메인에 빈 탭이 생긴다.
  const redocking = useRef(false);

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
      if (!isMod(e) || !e.shiftKey) return;
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

  /** 이 창의 터미널을 PTY를 살린 채 메인 창으로 넘긴다(되돌리기). */
  const redock = async () => {
    if (redocking.current) return;
    redocking.current = true;
    const panes = collectPanes(tab.layout); // 이 창에서 분할로 늘린 pane까지 전부
    // **창을 닫기 전에 반드시 완료돼야 한다.** 이 호출이 Rust에 "이 세션은 창이 파괴돼도
    // 죽이지 말라"고 등록하는 일이라(Destroyed 훅의 PTY kill 우회), 등록 전에 창이 닫히면
    // 되돌릴 세션이 이미 없다. 실패하면 아무것도 건드리지 않고 멈춘다 — 진행하면 PTY가 죽는다.
    //
    // 등록은 **대표 pane 하나만.** Destroyed 훅이 조회하는 id는 창당 하나(풀 창 claim / 라벨
    // 접미사)고, 분할로 늘린 pane은 Rust가 한 번도 조회하지 않아 등록하면 skip 셋에 영구히 남는다
    // → 훗날 그 pane을 다시 분리했다 진짜로 닫을 때 PTY가 고아로 산다. 분할 pane의 PTY는 등록
    // 없이도 살아남는다 — 그것들을 죽이는 건 아래 언로드 정리뿐인데, 그 전에 목록을 비운다.
    try {
      await invoke("float_redock_begin", { termIds: [ownPaneId] });
    } catch (e) {
      redocking.current = false;
      console.error("되돌리기 중단 — PTY 보존 등록 실패:", e);
      return;
    }
    panes.forEach((p) => detachTerminalKeepPty(p)); // xterm만 정리, PTY는 살린다
    panes.forEach((p) =>
      sendTerminalsCmd({ op: "openTerminal", projectId, paneId: p }),
    );
    // 목록을 비우면 위 "탭 소멸 → 창 닫기" 효과가 창을 닫고, 언로드 정리 효과는 빈 목록을 돌아
    // disposeTerminal(=PTY kill)을 한 번도 부르지 않는다.
    useTerminals.setState({ terminals: [] });
  };

  return (
    <div className="flex h-screen flex-col bg-base">
      <FloatTitleBar
        title={title}
        actions={
          <>
            {/* 이 창의 pane 전체(분할로 늘린 것 포함) 프롬프트 컬럼 마스터 토글. useTerminals가
                창별 독립 스토어라(stores/terminals ROLE float) 대상은 저절로 이 창의 pane만이다 —
                메인·다른 플로팅 창의 컬럼 상태는 바뀌지 않는다. */}
            <PromptHistoryButton className="h-full shrink-0 px-2 text-[11px]" />
            <button
              onClick={() => void redock()}
              title="이 창의 터미널을 메인 창으로 되돌립니다 — 모아보기가 열려 있으면 거기 나타납니다"
              className="flex h-full shrink-0 items-center gap-1 px-2 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            >
              <Undo2 size={12} /> 메인으로 되돌리기
            </button>
          </>
        }
      />
      <div className="min-h-0 flex-1">
        <PaneTreeRoot tab={tab} projectId={projectId} fontSize={FONT} />
      </div>
      {/* 컬럼 항목 복사 토스트가 이 창에서만 무음이었다 — 스토어는 창마다 별개라(웹뷰 = 별도 JS
          컨텍스트) 메인 창의 호스트가 여기 대신 그려 주지 않는다(AggregateWindow와 같은 이유).
          확인 모달은 이 창에 askConfirm 경로가 없어 달지 않는다. */}
      <Toasts />
      {/* PaneMenu가 이 창에서도 열린다 — '선택 영역 번역' 카드는 그 창 안에 떠야 한다(태스크 61). */}
      <TranslateHost />
    </div>
  );
}
