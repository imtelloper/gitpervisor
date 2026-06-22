import {
  Globe,
  Maximize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import { useBrowsers } from "../../stores/browser";
import { type PaneKind, useTerminals } from "../../stores/terminals";

/**
 * 패널 컨트롤 버튼들 — 웹↔터미널 전환 / 우·하 분할 / 최대화 / 닫기.
 * 터미널 패널은 떠다니는 호버 오버레이로, 브라우저 패널은 주소창 바 안에 넣어 재사용한다.
 */
export function PaneControls({
  tabId,
  paneId,
  content,
}: {
  tabId: string;
  paneId: string;
  content: PaneKind;
}) {
  const splitPane = useTerminals((s) => s.splitPane);
  const setPaneContent = useTerminals((s) => s.setPaneContent);
  const closePane = useTerminals((s) => s.closePane);
  const toggleMaximize = useTerminals((s) => s.toggleMaximize);
  const ensurePane = useBrowsers((s) => s.ensurePane);
  const projectId = useTerminals(
    (s) => s.terminals.find((t) => t.id === tabId)?.projectId ?? "",
  );

  const toggleType = () => {
    if (content === "terminal") {
      ensurePane(paneId, projectId);
      setPaneContent(tabId, paneId, "browser");
    } else {
      // 웹→터미널: 웹뷰 정리는 BrowserPane 언마운트가 처리(참조 사라짐→dispose)
      setPaneContent(tabId, paneId, "terminal");
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <TBtn
        title={content === "terminal" ? "웹으로 전환" : "터미널로 전환"}
        onClick={toggleType}
      >
        {content === "terminal" ? <Globe size={13} /> : <TerminalIcon size={13} />}
      </TBtn>
      <TBtn title="오른쪽으로 분할" onClick={() => splitPane(tabId, paneId, "row", false)}>
        <SplitSquareHorizontal size={13} />
      </TBtn>
      <TBtn title="아래로 분할" onClick={() => splitPane(tabId, paneId, "col", false)}>
        <SplitSquareVertical size={13} />
      </TBtn>
      <TBtn title="최대화/복원" onClick={() => toggleMaximize(tabId, paneId)}>
        <Maximize2 size={13} />
      </TBtn>
      <TBtn title="패널 닫기" danger onClick={() => closePane(tabId, paneId)}>
        <X size={13} />
      </TBtn>
    </div>
  );
}

function TBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded p-1 text-fg-dim hover:bg-raised ${
        danger ? "hover:text-danger" : "hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
