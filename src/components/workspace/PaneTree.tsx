import { AppWindow } from "lucide-react";
import { useEffect } from "react";

import { useMessages } from "../../i18n/ui-language";
import { useProjectColors } from "../../lib/project-color";
import { useProjects } from "../../queries";
import { useAgentActivity } from "../../stores/agentActivity";
import { useBrowsers } from "../../stores/browser";
import {
  collectPanes,
  useTerminals,
  type Pane,
  type TermLeaf,
  type TermTab,
} from "../../stores/terminals";
import { ProjectLogo } from "../common/ProjectLogo";
import { BrowserPane } from "./BrowserPane";
import { PaneControls } from "./PaneControls";
import { SplitView } from "./SplitView";
import {
  AgentLaunchButton,
  ClaudeModelChip,
  FileTreeButton,
  GitDialogButton,
  PromptLogButton,
  SessionHistoryButton,
  SessionTitle,
  SessionTitleChip,
  StaticPageButton,
  StatusIcon,
  ThemeButton,
} from "./TermSessionControls";
import { TerminalPane } from "./TerminalPane";

interface ViewProps {
  node: Pane;
  tab: TermTab;
  projectId: string;
  fontSize: number;
  multi: boolean;
  /** 터미널 칸마다 헤더(모아보기 셀과 같은 꼴)를 단다 — `PaneTreeRoot` 의 `paneHeaders` 주석. */
  headers: boolean;
}

/** 활성 탭의 루트 — 최대화 패널이 있으면 그것만, 아니면 분할 트리 전체.
 *  `paneHeaders`: 분할돼 있으면 터미널 칸마다 헤더를 단다(플로팅 창). 그 창의 타이틀바는 창 하나에 하나라
 *  분할하면 어느 칸이 무엇인지 말해 주지 못한다 — 모아보기 셀처럼 칸이 스스로 말하게 한다(사용자 요청 2026-11-17). */
export function PaneTreeRoot({
  tab,
  projectId,
  fontSize,
  paneHeaders = false,
}: {
  tab: TermTab;
  projectId: string;
  fontSize: number;
  paneHeaders?: boolean;
}) {
  const multi = collectPanes(tab.layout).length > 1;
  // 최대화 중에도 단다 — 헤더의 최대화 버튼이 되돌리는 손잡이이고, 어느 칸을 키웠는지도 말해 준다.
  const headers = paneHeaders && multi;
  if (tab.maximizedPaneId) {
    // 최대화된 리프를 트리에서 찾아 그 content 그대로 렌더
    const leaf = findLeaf(tab.layout, tab.maximizedPaneId);
    if (leaf)
      return (
        <LeafView
          leaf={leaf}
          tab={tab}
          projectId={projectId}
          fontSize={fontSize}
          active={false}
          headers={headers}
        />
      );
  }
  return (
    <PaneView
      node={tab.layout}
      tab={tab}
      projectId={projectId}
      fontSize={fontSize}
      multi={multi}
      headers={headers}
    />
  );
}

function findLeaf(node: Pane, paneId: string): Extract<Pane, { kind: "leaf" }> | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

// 순수 분기 — 훅 없음 (리프↔분할 전환 시 훅 개수 변동 방지)
function PaneView(props: ViewProps) {
  if (props.node.kind === "leaf") {
    return (
      <LeafView
        leaf={props.node}
        tab={props.tab}
        projectId={props.projectId}
        fontSize={props.fontSize}
        active={props.multi && props.tab.activePaneId === props.node.paneId}
        headers={props.headers}
      />
    );
  }
  return <TermSplitView {...props} node={props.node} />;
}

/** 분할 노드 — 공용 SplitView에 터미널 스토어의 비율/드래그 액션을 물린다. */
function TermSplitView({
  node,
  tab,
  ...rest
}: ViewProps & { node: Extract<Pane, { kind: "split" }> }) {
  const setRatio = useTerminals((s) => s.setRatio);
  const setDraggingSplit = useTerminals((s) => s.setDraggingSplit);
  return (
    <SplitView<TermLeaf>
      node={node}
      setRatio={(splitId, ratio) => setRatio(tab.id, splitId, ratio)}
      setDraggingSplit={setDraggingSplit}
      render={(child) => <PaneView node={child} tab={tab} {...rest} />}
    />
  );
}

/** 리프 한 칸 — content에 따라 터미널/브라우저를 렌더하고, 위에 패널 툴바를 띄운다. */
function LeafView({
  leaf,
  tab,
  projectId,
  fontSize,
  active,
  headers,
}: {
  leaf: Extract<Pane, { kind: "leaf" }>;
  tab: TermTab;
  projectId: string;
  fontSize: number;
  active: boolean;
  headers: boolean;
}) {
  const draggingSplit = useTerminals((s) => s.draggingSplit);
  const ensurePane = useBrowsers((s) => s.ensurePane);

  // 브라우저 리프면 패널 브라우저 상태를 보장(멱등)
  useEffect(() => {
    if (leaf.content === "browser") ensurePane(leaf.paneId, projectId);
  }, [leaf.content, leaf.paneId, projectId, ensurePane]);

  const controls = (
    <PaneControls tabId={tab.id} paneId={leaf.paneId} content={leaf.content} />
  );

  // 브라우저 패널은 컨트롤을 주소창 바 안에 넣어 자체 버튼과 겹치지 않게 한다.
  if (leaf.content === "browser") {
    return (
      <div className="group/pane relative h-full w-full">
        <BrowserPane id={leaf.paneId} active={!draggingSplit} paneControls={controls} />
      </div>
    );
  }

  const sessionButtons = (
    <>
      <AgentLaunchButton termId={leaf.paneId} />
      <ThemeButton termId={leaf.paneId} />
      <PromptLogButton termId={leaf.paneId} />
      <SessionHistoryButton termId={leaf.paneId} projectId={tab.projectId} />
      <GitDialogButton projectId={tab.projectId} />
      <FileTreeButton projectId={tab.projectId} />
      {/* 지구본은 바로 옆 PaneControls 의 "이 칸을 웹으로 전환"이 쓴다 — 새 창은 창 아이콘으로 가른다. */}
      <StaticPageButton projectId={tab.projectId} icon={AppWindow} />
      <span className="mx-0.5 h-3 w-px bg-edge" />
      {controls}
    </>
  );

  // 헤더가 있으면 컨트롤은 거기 늘 보이게 두고 호버 오버레이는 끈다(같은 버튼이 두 벌 뜨지 않게).
  if (headers) {
    return (
      <div className="group/pane relative flex h-full w-full flex-col">
        <PaneHeader tab={tab} paneId={leaf.paneId}>
          {sessionButtons}
        </PaneHeader>
        <div className="min-h-0 flex-1">
          <TerminalPane tabId={tab.id} projectId={projectId} paneId={leaf.paneId} active={active} fontSize={fontSize} />
        </div>
      </div>
    );
  }

  // 터미널 패널은 바가 없으므로 우상단 호버 오버레이로 띄운다 — 오버레이 자체는 TerminalPane이
  // xterm 호스트 안에 그린다(프롬프트 컬럼 헤더의 X를 덮지 않게 — TerminalPane의 주석 참고).
  return (
    <div className="group/pane relative h-full w-full">
      <TerminalPane
        tabId={tab.id}
        projectId={projectId}
        paneId={leaf.paneId}
        active={active}
        fontSize={fontSize}
        controls={
          <>
            <SessionTitleChip termId={leaf.paneId} />
            {sessionButtons}
          </>
        }
      />
    </div>
  );
}

/** 칸 헤더 — 모아보기 셀 헤더(AggregateTerminals `AggregateCell`)와 같은 꼴: 활동 표시 · 로고 · 프로젝트 · 모델 칩
 *  · 가운데 세션 제목(클릭 편집) · 세션 버튼과 칸 버튼. 바탕은 모아보기와 같은 프로젝트 색이다. */
function PaneHeader({ tab, paneId, children }: { tab: TermTab; paneId: string; children: React.ReactNode }) {
  const msg = useMessages();
  const { data: projects } = useProjects();
  const colors = useProjectColors();
  const status = useAgentActivity((s) => s.byTerminal[paneId]);
  const projName = projects?.find((p) => p.id === tab.projectId)?.name ?? msg.app.aggregate.fallbackProjectName;
  return (
    <div
      style={{ backgroundColor: colors.get(projName)?.bg }}
      className="flex h-6 shrink-0 items-center gap-1.5 border-b border-edge px-2 text-[11px] text-fg-muted"
    >
      {status && <StatusIcon status={status} />}
      <ProjectLogo projectId={tab.projectId} size={14} />
      <span className="min-w-0 shrink truncate font-medium text-fg">{projName}</span>
      <ClaudeModelChip termId={paneId} />
      <SessionTitle termId={paneId} />
      {children}
    </div>
  );
}

