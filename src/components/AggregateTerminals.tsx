import {
  CircleCheck,
  Columns3,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Grid2x2,
  History,
  Languages,
  Layers,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Sparkles,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Project } from "../lib/ipc";
import { isMac, modLabel } from "../lib/platform";
import { NO_COLOR, useProjectColors, type ProjColor } from "../lib/project-color";
import {
  attachTerminal,
  CLAUDE_LAUNCH,
  createTerminal,
  detachTerminalKeepPty,
  fitTerminal,
  getTerminal,
  queueInitialInput,
} from "../lib/terminal";
import { translateRequest } from "../lib/translate";
import { useProjects, useSettings } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
import { useBrowsers } from "../stores/browser";
import { usePromptHistory } from "../stores/promptHistory";
import {
  collectByContent,
  IS_AGGREGATE_WINDOW,
  type PaneKind,
  useTerminals,
} from "../stores/terminals";
import { useOccludesWebview } from "../stores/occlusion";
import { type AggregateLayout, useUi } from "../stores/ui";
import { EmptyState } from "./common/EmptyState";
import { ProjectLogo } from "./common/ProjectLogo";
import { BrowserPane } from "./workspace/BrowserPane";
import {
  GitDialogButton,
  PromptHistoryButton,
  PromptLogButton,
  PromptSidePanel,
  ThemeButton,
} from "./workspace/TermSessionControls";
import { MenuItem } from "./workspace/TerminalPane";

// 모아보기 토글 단축키 라벨 — mac은 심볼 관례(⌘⇧A), 그 외는 Ctrl+Shift+A
const hotkeyLabel = isMac ? `${modLabel}⇧A` : `${modLabel}+Shift+A`;

/** 그리드 한 칸의 원본 메타 — 터미널 pane 또는 브라우저(분할 pane·독립 탭)를 한 목록으로 다룬다. */
type CellSource =
  | {
      kind: "terminal";
      id: string; // paneId
      tabId: string;
      projectId: string;
      projName: string;
      title: string;
      status: "working" | "done" | undefined;
    }
  | {
      kind: "browser";
      id: string; // 분할 pane의 paneId 또는 독립 브라우저 탭 id
      tabId: string | null; // 소속 터미널 탭 — 독립 브라우저 탭이면 null
      projectId: string;
      projName: string;
      title: string;
      status?: undefined;
    };

/**
 * 렌더에 쓰는 셀 메타 = 원본 + 프로젝트 색.
 *
 * 색을 여기 실어 두는 이유: 배정은 **화면 전체의 프로젝트 집합**을 봐야 결정되는데(충돌 회피),
 * 칩과 셀 헤더는 서로 다른 컴포넌트다. 메타에 실으면 프롭 배관 없이 같은 색이 따라간다.
 */
type CellMeta = CellSource & { color: ProjColor };

type TermMeta = Extract<CellMeta, { kind: "terminal" }>;
type BrowserMeta = Extract<CellMeta, { kind: "browser" }>;

// 트랙(열/행) 최소 크기(px) — 이보다 작으면 터미널이 못 읽힐 정도라 드래그 하한으로 막는다.
const MIN_W = 240;
const MIN_H = 160;
// 그리드 간격/패딩(px) — Tailwind gap-1.5 / p-1.5 = 6px와 맞춘다(트랙 px 환산용).
const GAP = 6;

// 호버 강조 없음 — 참조가 고정이라 매 leave마다 새 Set으로 리렌더를 만들지 않는다.
const NO_HOVER: ReadonlySet<string> = new Set();

/** 그리드 모드의 열 수 — 기존 동작 그대로(정사각에 가깝게). */
const gridCols = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
/**
 * 세로 컬럼은 좌우 한 줄, **4열 상한** — 1100px 창(별도 창 기본 폭 = 메인 최소 폭)에서
 * 5열부터 셀 폭이 MIN_W(240) 아래로 떨어진다(4열 ≈ 267px, 5열 ≈ 213px).
 * 하한 1: n=0에서 min(0,4)=0이면 rows = ceil(0/0) = NaN → 아래 `Array(rows)`가 RangeError를
 * 던진다(트랙 계산은 n===0 EmptyState 분기보다 먼저 돈다). gridCols(0)=1과 같은 하한을 둔다.
 */
const colsFor = (mode: AggregateLayout, n: number) =>
  mode === "columns" ? Math.max(1, Math.min(n, 4)) : gridCols(n);
/**
 * 모드·셀 수 → 열 수·행 수·행별 셀 수. 렌더와 `evenTracks(mode)`가 **같은 함수**를 본다 —
 * 어긋나면 균등값이 저장 검증(길이 대조)에 걸려 렌더만 조용히 균등 폴백하고 스토어엔
 * 엉뚱한 길이가 남는다(화면은 멀쩡해 보이는 유형).
 */
function shapeFor(mode: AggregateLayout, n: number) {
  const cols = colsFor(mode, n);
  const rows = Math.max(1, Math.ceil(n / cols));
  const rowLens = Array.from({ length: rows }, (_, r) =>
    Math.max(0, Math.min(cols, n - r * cols)),
  );
  return { cols, rows, rowLens };
}

/** hover 팝오버 지연 닫기 — 트리거→팝오버로 건너뛰는 4px 공백에서 닫히지 않게 ms 유예.
 *  묶음 칩 드롭다운과 자동배치 팝오버가 같은 로직을 쓴다. 언마운트 시 타이머 정리. */
function useDelayedClose(close: () => void, ms = 150) {
  const timer = useRef<number | undefined>(undefined);
  const hold = () => window.clearTimeout(timer.current);
  const schedule = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { hold, schedule };
}

// 자동배치 모드 선택 팝오버의 항목 — 아이콘은 lucide, 클래스(lucide-grid-2x2 / lucide-columns-3)가
// e2e의 "현재 모드 아이콘" 단언 표식이다.
const LAYOUT_MODES: { mode: AggregateLayout; Icon: typeof Grid2x2; title: string }[] = [
  { mode: "grid", Icon: Grid2x2, title: "그리드 — 2×2·3×3 균등 배치" },
  {
    mode: "columns",
    Icon: Columns3,
    title: "세로 컬럼 — 셀을 좌우로 한 줄에 나열(최대 4열, 넘치면 줄바꿈)",
  },
];

/**
 * 터미널 모아보기 — 여러 프로젝트/탭에 흩어진 터미널·브라우저를 한 화면에 분할해 동시에 본다.
 * 클로드(AI) 작업 중인 터미널을 기본 선택하고, 상단 칩으로 보고 싶은 것만 골라 그리드로 배치한다.
 * 이 뷰가 열리면 메인 워크스페이스(WorkspaceTabs)는 언마운트되고(App), 선택된 터미널의 xterm
 * 호스트를 이 그리드 셀로 옮겨 붙인다. 닫으면 워크스페이스가 다시 마운트되며 호스트를 되찾는다.
 * 브라우저 셀은 BrowserPane 재사용 — 같은 id의 네이티브 webview/iframe이 셀 위치로 따라온다.
 */
export function AggregateTerminals() {
  const setAggregateOpen = useUi((s) => s.setAggregateOpen);
  const { data: projects } = useProjects();
  // 색은 **등록된 전체 프로젝트** 이름순 배정을 그대로 쓴다 — 사이드바 행과 같은 맵이라야
  // 같은 프로젝트가 어디서든 같은 색이다(화면에 보이는 셀만으로 배정하면 색이 이동한다).
  const colors = useProjectColors();
  const { data: settings } = useSettings();
  const fontSize = settings?.terminalFontSize ?? 13;
  const terminals = useTerminals((s) => s.terminals);
  const openTerminal = useTerminals((s) => s.openTerminal);
  const closePane = useTerminals((s) => s.closePane);
  const floatPane = useTerminals((s) => s.floatPane);
  const askConfirm = useUi((s) => s.askConfirm);
  const openTranslate = useUi((s) => s.openTranslate);
  const byTerminal = useAgentActivity((s) => s.byTerminal);
  const browserItems = useBrowsers((s) => s.items);
  const browserTabIds = useBrowsers((s) => s.tabIds);
  const openBrowserTab = useBrowsers((s) => s.openBrowser);
  const closeBrowserTab = useBrowsers((s) => s.closeBrowser);
  // 드래그로 조절한 그리드 트랙(shape별 fr 배열) — ui 스토어에 영속돼 여닫아도 유지된다.
  const aggregateTracks = useUi((s) => s.aggregateTracks);
  const setAggregateTracks = useUi((s) => s.setAggregateTracks);
  // 자동배치 모드(그리드 / 세로 컬럼) — localStorage 영속이라 재시작·별도 창에도 따라온다.
  const layout = useUi((s) => s.aggregateLayout);
  const setAggregateLayout = useUi((s) => s.setAggregateLayout);

  // 모든 셀 메타 (스토어 기준 — 반응형): 탭별 터미널·브라우저 pane + 독립 브라우저 탭.
  const all = useMemo<CellMeta[]>(() => {
    const projName = (id: string) =>
      projects?.find((p) => p.id === id)?.name ?? "프로젝트";
    const out: CellSource[] = [];
    for (const tab of terminals) {
      for (const paneId of collectByContent(tab.layout, "terminal")) {
        out.push({
          kind: "terminal",
          id: paneId,
          tabId: tab.id,
          projectId: tab.projectId,
          projName: projName(tab.projectId),
          title: tab.title,
          status: byTerminal[paneId],
        });
      }
      for (const paneId of collectByContent(tab.layout, "browser")) {
        out.push({
          kind: "browser",
          id: paneId,
          tabId: tab.id,
          projectId: tab.projectId,
          projName: projName(tab.projectId),
          title: browserItems[paneId]?.title ?? "브라우저",
        });
      }
    }
    for (const id of browserTabIds) {
      const item = browserItems[id];
      if (!item) continue;
      out.push({
        kind: "browser",
        id,
        tabId: null,
        projectId: item.projectId,
        projName: projName(item.projectId),
        title: item.title,
      });
    }
    // 같은 프로젝트끼리 붙인다 — 탭 생성 순서 그대로면 프로젝트가 뒤섞여 칩 바에서 무엇이
    // 어디 소속인지 읽히지 않는다(색 막대와 짝이 되는 그룹핑의 나머지 절반).
    // 이름 오름차순, 같은 프로젝트 안에서는 원래 순서 유지 — Array#sort는 stable이다.
    out.sort((a, b) => a.projName.localeCompare(b.projName, "ko"));
    return out.map((c) => ({ ...c, color: colors.get(c.projName) ?? NO_COLOR }));
  }, [terminals, projects, byTerminal, browserItems, browserTabIds, colors]);

  // 선택 집합 — 최초엔 클로드 활동(working/done) 있는 터미널만. 없으면 전부(브라우저 포함).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // 확대(줌) 중인 터미널 셀 — 그리드 전면을 혼자 덮는다. 나머지 셀은 언마운트하지 않고
  // invisible로만 숨긴다: 언마운트하면 터미널 재부착·브라우저 리로드가 일어나고, 크기를
  // 바꾸면 xterm 리핏이 연쇄된다. 크기 불변이면 둘 다 없다.
  const [zoomed, setZoomed] = useState<string | null>(null);
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current || all.length === 0) return;
    initedRef.current = true;
    const active = all.filter((t) => t.status).map((t) => t.id);
    setSelected(new Set(active.length ? active : all.map((t) => t.id)));
  }, [all]);

  // 모아보기가 열린 동안 밖에서 새로 생긴 항목(파일트리 ".html → 브라우저로 열기" 등)은
  // 자동으로 그리드에 편입한다 — 안 그러면 방금 연 것이 모아보기에 가려 보이지 않는다.
  // 초기 자동선택(위 효과)이 같은 커밋에서 먼저 실행되므로 첫 목록은 여기서 건너뛴다.
  const prevIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(all.map((t) => t.id));
    const prev = prevIdsRef.current;
    prevIdsRef.current = ids;
    // 사라진 셀(닫힘·분리)의 xterm 인스턴스를 버린다 — 별도 창에선 이 정리를 아무도 하지 않아
    // WebGL 컨텍스트가 창에 계속 쌓인다(보조 모니터에 종일 켜 두는 창이다). PTY는 이미 메인이
    // 처리했으므로 detach만 한다. 메인 창에선 closePane/floatPane이 먼저 정리해 no-op이다.
    if (prev) [...prev].filter((id) => !ids.has(id)).forEach((id) => detachTerminalKeepPty(id));
    if (!prev || !initedRef.current) return;
    const added = [...ids].filter((id) => !prev.has(id));
    if (added.length === 0) return;
    setSelected((sel) => {
      const next = new Set(sel);
      added.forEach((id) => next.add(id));
      return next;
    });
    // 확대 중이면 해제 — 새 셀이 invisible 뒤에 숨어 "가려 보이지 않는" 문제가
    // 확대 상태에서 그대로 재발하기 때문(이 효과가 존재하는 이유와 동일).
    setZoomed(null);
  }, [all]);

  // 사라진 터미널/브라우저는 선택에서 제거
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(all.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [all]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 묶음 칩 클릭 — 전부 선택돼 있으면 전부 해제, 하나라도 빠져 있으면 전부 선택. */
  const toggleAll = (cells: CellMeta[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = cells.every((c) => next.has(c.id));
      cells.forEach((c) => (allOn ? next.delete(c.id) : next.add(c.id)));
      return next;
    });

  // 새 터미널 생성 + 즉시 그리드 편입. initedRef 선행 — 터미널 0개에서 첫 생성 시
  // 초기 자동선택 효과가 뒤늦게 selected를 덮어쓰는 경합 차단. 스토어 갱신은 동기라
  // 신규 paneId만 selected에 넣으면 셀 마운트→PTY spawn→attach는 기존 경로로 완결된다.
  const addTerminal = (projectId: string, claude?: boolean) => {
    initedRef.current = true;
    const { paneId } = openTerminal(projectId);
    // 셸이 뜨면 `claude`를 넣어 Claude Code 세션으로 들어간다. 별도 창에서도 paneId는 이 창이
    // 만들므로(위임은 id를 그대로 싣는다) 예약 키가 맞고, 실제 소비는 term_open을 잡은 창이 한다.
    if (claude) queueInitialInput(paneId, CLAUDE_LAUNCH);
    setSelected((prev) => new Set(prev).add(paneId));
    setZoomed(null); // 확대 중이었다면 해제 — 새 셀이 보이지 않으면 생성 실패로 오인한다
  };

  // 새 브라우저(독립 탭) 생성 + 즉시 그리드 편입 — URL은 셀 안 주소창에서 입력한다.
  const addBrowser = (projectId: string) => {
    initedRef.current = true;
    const id = openBrowserTab(projectId);
    setSelected((prev) => new Set(prev).add(id));
    setZoomed(null); // 확대 중이었다면 해제 — 새 셀이 보이지 않으면 생성 실패로 오인한다
  };

  const gridRef = useRef<HTMLDivElement>(null);
  // 트랙 드래그 중 — 네이티브 webview를 숨기고 iframe 포인터를 차단해야 드래그가 안 끊긴다.
  const [resizing, setResizing] = useState(false);

  // 칩 우클릭 메뉴 — fixed 메뉴가 브라우저 셀의 네이티브 webview에 가려지지 않게 점유 등록.
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number; cell: CellMeta } | null>(null);
  const togglePanel = usePromptHistory((s) => s.togglePanel);
  // 열린 메뉴의 셀 하나만 구독한다 — openPanels 전체를 구독하면 어느 셀을 토글하든
  // 그리드 컨테이너가 통째로 리렌더된다(셀마다 이미 자기 상태를 구독한다).
  const chipPromptOpen = usePromptHistory((s) =>
    chipMenu ? !!s.openPanels[chipMenu.cell.id] : false,
  );

  // 칩 호버 중 강조할 셀 — 칩과 그리드 셀은 위치가 떨어져 있어 어느 칩이 어느 셀인지
  // 눈으로 짝을 못 짓는다. 호버한 칩의 셀(묶음 칩이면 프로젝트 전체)에 ring을 띄운다.
  const [hovered, setHovered] = useState<ReadonlySet<string>>(NO_HOVER);

  // 탭 모으기 — 같은 프로젝트의 칩을 하나로 묶고, 호버 시 아래 드롭다운으로 개별 탭을 편다.
  const groupTabs = useUi((s) => s.aggregateGroupTabs);
  const toggleGroupTabs = useUi((s) => s.toggleAggregateGroupTabs);
  const [groupMenu, setGroupMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  // 칩 → 드롭다운으로 마우스가 건너가는 짧은 공백에 닫히지 않게 지연 닫기(타이머) 사용.
  const { hold: holdGroupOpen, schedule: scheduleGroupClose } = useDelayedClose(() =>
    setGroupMenu(null),
  );
  // 자동배치 모드 선택 팝오버 — 헤더 우측 끝 버튼이라 우측 모서리 정렬(left면 창 밖으로 잘린다).
  const [layoutMenu, setLayoutMenu] = useState<{ right: number; top: number } | null>(null);
  const { hold: holdLayoutOpen, schedule: scheduleLayoutClose } = useDelayedClose(() =>
    setLayoutMenu(null),
  );
  useOccludesWebview(!!chipMenu || !!groupMenu || !!layoutMenu);

  const shown = all.filter((t) => selected.has(t.id));
  // 렌더 기준 확대 대상 — 상태가 스테일해도(대상이 방금 닫힘·칩 해제) 이번 프레임부터 무시.
  const zoomedId = zoomed && shown.some((t) => t.id === zoomed) ? zoomed : null;
  // 스테일 상태 정리 — 안 지우면 같은 id가 칩으로 되돌아올 때 예고 없이 다시 확대된다.
  useEffect(() => {
    if (zoomed && !all.some((t) => t.id === zoomed && selected.has(t.id)))
      setZoomed(null);
  }, [zoomed, all, selected]);
  const n = shown.length;
  const { cols, rows, rowLens } = shapeFor(layout, n);

  // 버튼이 사라져도(n ≤ 1로 언마운트) React는 mouseleave를 주지 않는다 — 스테일 팝오버를
  // 안 지우면 셀이 다시 늘 때 호버도 없이 팝오버가 나타난다(확대 스테일 정리와 같은 이유).
  useEffect(() => {
    if (n <= 1) setLayoutMenu(null);
  }, [n]);

  // 행 단위로 자른 셀 목록 — 폭은 "행마다 독립"이라 행이 레이아웃의 기본 단위다.
  const rowsOfCells: CellMeta[][] = [];
  for (let i = 0; i < shown.length; i += cols)
    rowsOfCells.push(shown.slice(i, i + cols));

  // 현재 배치의 트랙 크기 — 행 높이(rowFr[r])와 행별 셀 폭(cellFr[r][c], fr 배열).
  // 가로 드래그는 같은 행의 이웃과만 재분배하므로 위/아래 행 폭에 영향이 없다.
  // 재분배(총합 불변)라 그리드가 항상 컨테이너를 정확히 채운다 → 셀이 밖으로 밀려나
  // 사라질 수 없다. 키는 n — 모드를 키에 넣지 않는다: 모드 전환은 항상 evenTracks(mode)를
  // 수반해 균등으로 덮으므로 모드별 비율 기억이 정의상 없고, 스토어 setter를 직접 부른 경우
  // (e2e·별도 창 시작 동기)의 길이 불일치는 아래 검증이 균등 폴백으로 흡수한다.
  const shape = `n${n}`;
  const saved = aggregateTracks[shape];
  const rowFr: number[] =
    saved && Array.isArray(saved.rows) && saved.rows.length === rows
      ? saved.rows
      : Array(rows).fill(1);
  const cellFr: number[][] =
    saved &&
    Array.isArray(saved.cols) &&
    saved.cols.length === rows &&
    saved.cols.every((a, r) => Array.isArray(a) && a.length === rowLens[r])
      ? saved.cols
      : rowLens.map((len) => Array(len).fill(1));

  // 지금 배치가 균등한가 — fr은 상대값이라 "한 줄 안에서 값이 전부 같으면" 균등이다.
  // 확대 중인 셀도 균등이 아닌 상태로 친다(그 셀만 화면을 덮고 있으니 눈에는 그게 불균등이다).
  const uneven =
    rowFr.some((v) => v !== rowFr[0]) ||
    cellFr.some((row) => row.some((v) => v !== row[0]));
  const canEven = uneven || !!zoomedId;

  /** 셀 크기를 전부 1fr로 되돌린다(+확대 해제). 저장된 트랙을 지우는 게 아니라 균등값으로 덮는다
   *  — 지우는 API가 따로 없고, 균등값을 써 두면 다음에 열어도 균등으로 복원된다.
   *  인자는 **대상 모드** — 모드 아이콘 클릭은 새 모드의 모양으로 균등화해야 하는데, 그 순간
   *  `layout`은 아직 이전 값이다(같은 이벤트 안에서 setState가 반영되기 전). */
  const evenTracks = (mode: AggregateLayout = layout) => {
    const s = shapeFor(mode, n);
    setAggregateTracks(shape, {
      rows: Array(s.rows).fill(1),
      cols: s.rowLens.map((len) => Array(len).fill(1)),
    });
    setZoomed(null);
  };
  /** 팝오버의 모드 아이콘 클릭 — 모드 저장 + 그 모드로 즉시 균등 + 팝오버 닫힘. */
  const pickLayout = (m: AggregateLayout) => {
    setAggregateLayout(m);
    evenTracks(m);
    holdLayoutOpen(); // 예약된 지연 닫기가 뒤늦게 발화해 다음 hover를 지우지 않게
    setLayoutMenu(null);
  };

  // 경계 드래그 — 가로는 r행 안에서 셀 c↔c+1, 세로는 행 r↔r+1 사이 공간 재분배.
  // 드래그 시작 시 fr을 px로 환산해 기준으로 삼고, 매 이동마다 두 트랙 합을 유지한 채 나눈다.
  const startResize = (
    e: React.PointerEvent,
    r: number,
    c: number,
    axis: "x" | "y" | "both",
  ) => {
    const el = gridRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    const rowLen = rowLens[r];
    const availW = el.clientWidth - GAP * 2 - (rowLen - 1) * GAP;
    const availH = el.clientHeight - GAP * 2 - (rows - 1) * GAP;
    const sumC = cellFr[r].reduce((a, b) => a + b, 0);
    const sumR = rowFr.reduce((a, b) => a + b, 0);
    const colPx = cellFr[r].map((f) => (f / sumC) * availW);
    const rowPx = rowFr.map((f) => (f / sumR) * availH);
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const nextRowCells = [...colPx];
      const nextRows = [...rowPx];
      if (axis !== "y" && c < rowLen - 1) {
        const pair = colPx[c] + colPx[c + 1];
        const lo = Math.min(MIN_W, pair / 2); // 둘 다 최소 미만이면 중앙까지만
        const w = Math.min(Math.max(colPx[c] + (ev.clientX - sx), lo), pair - lo);
        nextRowCells[c] = w;
        nextRowCells[c + 1] = pair - w;
      }
      if (axis !== "x" && r < rows - 1) {
        const pair = rowPx[r] + rowPx[r + 1];
        const lo = Math.min(MIN_H, pair / 2);
        const h = Math.min(Math.max(rowPx[r] + (ev.clientY - sy), lo), pair - lo);
        nextRows[r] = h;
        nextRows[r + 1] = pair - h;
      }
      // r행의 폭만 교체, 다른 행 배열은 그대로 — 행별 fr은 독립 정규화라 단위가 섞여도 무관.
      // px 값을 fr로 그대로 저장 — fr은 상대값이라 창 크기가 바뀌어도 비율이 유지된다.
      setAggregateTracks(shape, {
        rows: nextRows,
        cols: cellFr.map((arr, i) => (i === r ? nextRowCells : arr)),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setResizing(false);
    };
    document.body.style.userSelect = "none"; // 드래그 중 텍스트 선택 방지
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-base">
      {/* 헤더: 제목 + 선택 칩 + 닫기 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <LayoutGrid size={15} className="shrink-0 text-accent" />
        {/* 별도 창에선 창 타이틀바가 이미 "터미널 모아보기"라 중복이다 — 칩에 폭을 넘긴다 */}
        {!IS_AGGREGATE_WINDOW && (
          <span className="shrink-0 text-sm font-semibold">터미널 모아보기</span>
        )}
        <span className="shrink-0 text-[11px] text-fg-dim">
          {n}/{all.length} 선택
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pl-2">
          {groupTabs
            ? groupByProject(all).map((cells) => {
                const name = cells[0].projName;
                const selCount = cells.filter((c) => selected.has(c.id)).length;
                // 묶음 상태 = 구성원 요약 — 하나라도 작업 중이면 working이 우선.
                const status = cells.some((c) => c.status === "working")
                  ? ("working" as const)
                  : cells.some((c) => c.status === "done")
                    ? ("done" as const)
                    : undefined;
                const openDropdown = (el: HTMLElement) => {
                  holdGroupOpen();
                  const r = el.getBoundingClientRect();
                  setGroupMenu({ name, x: r.left, y: r.bottom + 4 });
                  setHovered(new Set(cells.map((c) => c.id)));
                };
                return (
                  <button
                    key={name}
                    onClick={() => toggleAll(cells)}
                    onMouseEnter={(e) => openDropdown(e.currentTarget)}
                    // 우클릭도 드롭다운 — 개별 칩의 우클릭 메뉴(새 터미널 등)가 묶음 모드에선
                    // 드롭다운 안에 있으므로, 우클릭을 죽은 입력으로 두지 않는다.
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openDropdown(e.currentTarget);
                    }}
                    onMouseLeave={() => {
                      scheduleGroupClose();
                      setHovered(NO_HOVER);
                    }}
                    title={`${name} — 탭 ${cells.length}개 (클릭: 전체 표시/숨김, 호버: 목록)`}
                    style={{
                      backgroundColor: cells[0].color.bg,
                    }}
                    className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-fg ${
                      selCount === cells.length ? "ring-1 ring-accent" : ""
                    } ${status === "working" ? "ai-working" : status === "done" ? "ai-done" : ""}`}
                  >
                    <StatusIcon status={status} />
                    <span className="max-w-[140px] truncate">{name}</span>
                    <span className="text-fg-dim">
                      {selCount}/{cells.length}
                    </span>
                  </button>
                );
              })
            : all.map((t) => (
                <Chip
                  key={t.id}
                  t={t}
                  on={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onMenu={(x, y) => setChipMenu({ x, y, cell: t })}
                  onHover={(over) => setHovered(over ? new Set([t.id]) : NO_HOVER)}
                />
              ))}
        </div>
        {/* 별도 창에서도 만들 수 있다 — 이 창의 스토어는 변경을 메인에 위임하므로
            (stores/terminals.ts terminals://cmd) 메인이 만들고 결과가 storage로 돌아온다.
            브라우저만 제외: 브라우저 스토어에는 storage 따라가기가 없어 위임해도 이 창 그리드에
            안 뜬다 → onCreateBrowser를 안 넘겨 터미널 두 종류(일반·Claude)만 남는다. */}
        <NewCellButton
          projects={projects}
          onCreateTerminal={addTerminal}
          onCreateBrowser={IS_AGGREGATE_WINDOW ? undefined : addBrowser}
        />
        {/* 셀 크기 균등 복구 + 모드 선택. 클릭은 지금 모드로 균등 정렬(드래그로 흐트러진 fr 비율과
            확대 상태를 함께 되돌린다 — 확대를 안 풀면 눌러도 화면이 그대로라 고장으로 보인다),
            호버는 모드 팝오버.
            hover를 **래퍼 span이 받는** 이유 두 가지: ① React는 `disabled` 버튼의 onMouseEnter를
            아예 등록하지 않는다(getListener) — 균등 상태에서 모드를 바꾸는 것이 이 기능의 주 동선인데
            버튼에 달면 그때 팝오버가 절대 안 열린다. 그래서 `disabled` 대신 `aria-disabled` + 핸들러
            제거로 바꿨다. ② 버튼→팝오버로 건너가는 4px 공백의 leave를 유예해야 해서 어차피
            hold/schedule을 양쪽에 달아야 한다 — 래퍼 하나가 자연스러운 앵커다. */}
        {n > 1 && (
          <span
            className="shrink-0"
            onMouseEnter={(e) => {
              holdLayoutOpen();
              const r = e.currentTarget.getBoundingClientRect();
              setLayoutMenu({ right: window.innerWidth - r.right, top: r.bottom + 4 });
            }}
            onMouseLeave={scheduleLayoutClose}
          >
            <button
              onClick={canEven ? () => evenTracks() : undefined}
              aria-disabled={!canEven}
              title="셀 자동배치 — 클릭: 지금 모드로 균등 정렬 · 호버: 모드 선택(그리드 / 세로 컬럼)"
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted ${
                canEven ? "hover:bg-raised hover:text-fg" : "opacity-40"
              }`}
            >
              {layout === "columns" ? <Columns3 size={14} /> : <Grid2x2 size={14} />} 자동배치
            </button>
          </span>
        )}
        {/* 전체 프롬프트 컬럼 마스터 토글 — 별도 창에만 둔다. 메인 안 모아보기는 바로 위
            TitleBar에 같은 버튼이 있어 한 화면에 두 개가 보이면 안 된다. */}
        {IS_AGGREGATE_WINDOW && (
          <PromptHistoryButton className="shrink-0 px-2 py-1 text-xs" />
        )}
        {/* 탭 모으기 ON/OFF — 프로젝트·탭이 늘면 칩 바가 스크롤로 밀린다. 묶으면 프로젝트당
            칩 하나로 줄고, 개별 탭은 묶음 칩 호버 시 드롭다운으로 편다. */}
        <button
          onClick={() => {
            toggleGroupTabs();
            setGroupMenu(null);
            setHovered(NO_HOVER);
          }}
          title={
            groupTabs
              ? "탭 모으기 끄기 — 탭을 개별 칩으로 펼칩니다"
              : "탭 모으기 켜기 — 같은 프로젝트의 탭을 칩 하나로 묶습니다"
          }
          className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ${
            groupTabs
              ? "bg-raised text-accent"
              : "text-fg-muted hover:bg-raised hover:text-fg"
          }`}
        >
          <Layers size={14} /> 탭 모으기
        </button>
        <button
          onClick={() => {
            if (IS_AGGREGATE_WINDOW) void getCurrentWindow().close();
            else setAggregateOpen(false);
          }}
          title={
            IS_AGGREGATE_WINDOW
              ? "창 닫기 — 터미널은 메인 창으로 돌아갑니다"
              : `모아보기 닫기 (${hotkeyLabel})`
          }
          className="ml-1 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg"
        >
          <X size={14} /> 닫기
        </button>
      </div>

      {/* 그리드 */}
      {n === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title={
            all.length
              ? "표시할 터미널·브라우저를 선택하세요"
              : "열린 터미널·브라우저가 없습니다"
          }
          desc={
            all.length
              ? "위 칩에서 보고 싶은 것을 고르면 여기에 분할로 표시됩니다"
              : "위의 새 터미널 · 새 브라우저 버튼으로 바로 열 수 있습니다"
          }
        />
      ) : (
        <div
          ref={gridRef}
          className="relative min-h-0 flex-1"
          // 실제 배치는 아래 absolute+calc — 셀을 전부 이 한 부모의 형제(key=셀 id)로
          // 평탄화해, 행 재청킹 때 React가 셀을 리마운트(=브라우저 리로드·터미널 재부착)
          // 하지 않게 한다(행 래퍼가 있으면 행을 넘나드는 셀은 무조건 리마운트된다).
          // grid-template-columns 인라인 스타일은 e2e가 이 그리드를 찾는 표식이라 유지.
          style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
        >
          {(() => {
            // fr → calc 좌표. 트랙 영역 = 100% - (양끝 여백 12px + 트랙 사이 gap 6px들).
            // startResize의 px 환산식(clientWidth - GAP*2 - (len-1)*GAP)과 같은 기하학.
            const sumR = rowFr.reduce((a, b) => a + b, 0);
            const fixedV = GAP * 2 + (rows - 1) * GAP;
            return rowsOfCells.flatMap((rowCells, r) => {
              const topFrac = rowFr.slice(0, r).reduce((a, b) => a + b, 0) / sumR;
              const top = `calc(${GAP + r * GAP}px + ${topFrac} * (100% - ${fixedV}px))`;
              const height = `calc(${rowFr[r] / sumR} * (100% - ${fixedV}px))`;
              const len = rowCells.length;
              const sumC = cellFr[r].reduce((a, b) => a + b, 0);
              const fixedH = GAP * 2 + (len - 1) * GAP;
              return rowCells.map((t, c) => {
                const leftFrac =
                  cellFr[r].slice(0, c).reduce((a, b) => a + b, 0) / sumC;
                const isZoomed = zoomedId === t.id;
                // 확대 중: 대상은 그리드 전면(z-30), 나머지는 invisible — 슬롯 크기를
                // 그대로 두어 xterm 리핏·webview 재배치를 일으키지 않는다. 네이티브
                // webview는 CSS로 안 숨으므로 브라우저 셀은 suspended로 별도 숨김.
                const style = isZoomed
                  ? {
                      top: GAP,
                      left: GAP,
                      width: `calc(100% - ${GAP * 2}px)`,
                      height: `calc(100% - ${GAP * 2}px)`,
                    }
                  : {
                      top,
                      height,
                      left: `calc(${GAP + c * GAP}px + ${leftFrac} * (100% - ${fixedH}px))`,
                      width: `calc(${cellFr[r][c] / sumC} * (100% - ${fixedH}px))`,
                    };
                return (
                  <div
                    key={t.id}
                    // 칩 호버 강조 — 어느 칩이 이 셀인지 짝을 보여준다(ring은 셀 밖으로 그려져
                    // xterm 크기를 건드리지 않는다 = 리핏 없음).
                    className={`absolute${isZoomed ? " z-30" : ""}${
                      zoomedId && !isZoomed ? " invisible" : ""
                    }${hovered.has(t.id) ? " rounded ring-2 ring-accent" : ""}`}
                    style={style}
                    // 세션 셀 위 우클릭 = 칩 우클릭과 같은 메뉴(숨기기·확대·Float·닫기).
                    // 브라우저 셀의 주소창 등 입력 요소는 네이티브 편집 메뉴를 유지한다.
                    onContextMenu={(e) => {
                      const tag = (e.target as HTMLElement).tagName;
                      if (tag === "INPUT" || tag === "TEXTAREA") return;
                      e.preventDefault();
                      setChipMenu({ x: e.clientX, y: e.clientY, cell: t });
                    }}
                  >
                    {t.kind === "browser" ? (
                      <BrowserCell
                        meta={t}
                        // 드래그 중엔 네이티브 webview 숨김+iframe 포인터 차단, 드롭다운
                        // 열림 중엔 fixed 메뉴가 webview에 가려지지 않게 숨긴다.
                        // 다른 셀 확대 중에도 숨긴다 — 네이티브 webview는 DOM 위에 떠서
                        // invisible로는 확대된 터미널을 가리는 것을 못 막는다.
                        suspended={resizing || (zoomedId !== null && !isZoomed)}
                        // 칩 토글로 셀이 "크기 그대로 위치만" 밀리면 ResizeObserver가 못
                        // 잡는다 — 슬롯 좌표가 바뀔 때 bounds를 재동기화하게 한다.
                        layoutKey={`${n}:${r}:${c}`}
                        canRight={c < len - 1}
                        canBottom={r < rowsOfCells.length - 1}
                        onResizeStart={(e, axis) => startResize(e, r, c, axis)}
                        // 숨기기 = 상단 칩 선택 해제와 같다 — 브라우저는 그대로 살아 있다.
                        onHide={() => toggle(t.id)}
                        // 프로세스가 없으니 확인 없이 닫는다(워크스페이스 패널 X와 동일).
                        onClose={() =>
                          t.tabId ? closePane(t.tabId, t.id) : closeBrowserTab(t.id)
                        }
                      />
                    ) : (
                      <AggregateCell
                        meta={t}
                        fontSize={fontSize}
                        zoomed={isZoomed}
                        onZoom={() => setZoomed(isZoomed ? null : t.id)}
                        // 경계가 컨테이너 가장자리면 재분배할 이웃이 없다 — 핸들 생략.
                        // 확대 중엔 트랙 경계가 화면에 없으므로 핸들도 없다.
                        canRight={!isZoomed && c < len - 1}
                        canBottom={!isZoomed && r < rowsOfCells.length - 1}
                        onResizeStart={(e, axis) => startResize(e, r, c, axis)}
                        // 숨기기 = 상단 칩 선택 해제와 같다 — 셸은 계속 돌아간다.
                        onHide={() => toggle(t.id)}
                        onClose={() =>
                          askConfirm({
                            title: "터미널 닫기",
                            message: `'${t.projName} · ${t.title}' 터미널을 닫을까요? 실행 중인 프로세스가 종료됩니다.`,
                            confirmLabel: "닫기",
                            danger: true,
                            onConfirm: () => closePane(t.tabId, t.id),
                          })
                        }
                      />
                    )}
                  </div>
                );
              });
            });
          })()}
        </div>
      )}

      {/* 묶음 칩 호버 드롭다운 — 그 프로젝트의 탭을 개별 칩으로 편다. 칩 바가 overflow-x라
          absolute면 잘리므로 fixed. 마우스가 칩→드롭다운으로 건너올 수 있게 지연 닫기와 짝. */}
      {groupMenu &&
        (() => {
          const cells = all.filter((c) => c.projName === groupMenu.name);
          if (cells.length === 0) return null;
          // 닫을 수 있는 셀 = ChipMenu의 단일 닫기 조건을 셀마다 그대로 적용한 것 —
          // 별도 창의 독립 브라우저 탭(tabId null)만 빠진다(closeBrowserTab에 위임 경로 없음).
          const closable = cells.filter(
            (c) => !(IS_AGGREGATE_WINDOW && c.tabId == null),
          );
          const closeAll = () => {
            // 확인창이 뜨는 동안 hover 지연 닫기 타이머와 경합하지 않게 드롭다운을 먼저 닫는다.
            // 강조도 같이 지운다 — 드롭다운이 사라지면 mouseleave가 안 와서 ring이 박제된다
            // (확인창을 취소해도 다음 칩을 호버할 때까지 남는다).
            setGroupMenu(null);
            setHovered(NO_HOVER);
            const procs = closable.filter((c) => c.kind === "terminal").length;
            askConfirm({
              title: "탭 모두 닫기",
              // 단일 브라우저 닫기는 확인이 없지만 묶음은 여러 개를 한 번에 없애므로 항상 확인한다.
              message:
                `'${groupMenu.name}' 탭 ${closable.length}개를 닫을까요?` +
                (procs ? ` 터미널 ${procs}개의 실행 중인 프로세스가 종료됩니다.` : ""),
              confirmLabel: "모두 닫기",
              danger: true,
              onConfirm: () =>
                closable.forEach((c) =>
                  c.tabId != null ? closePane(c.tabId, c.id) : closeBrowserTab(c.id),
                ),
            });
          };
          return (
            <div
              className="fixed z-50 flex max-h-[60vh] min-w-44 max-w-80 flex-col gap-1 overflow-y-auto rounded-md border border-edge bg-panel p-1.5 shadow-xl"
              style={{
                left: Math.min(groupMenu.x, window.innerWidth - 328),
                top: groupMenu.y,
              }}
              onMouseEnter={() => {
                holdGroupOpen();
                // 칩→드롭다운 이동 중 칩 mouseleave가 지운 묶음 강조를 복원한다.
                setHovered(new Set(cells.map((c) => c.id)));
              }}
              onMouseLeave={() => {
                scheduleGroupClose();
                setHovered(NO_HOVER);
              }}
            >
              {cells.map((t) => (
                <Chip
                  key={t.id}
                  t={t}
                  full
                  on={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onMenu={(x, y) => setChipMenu({ x, y, cell: t })}
                  // 항목을 떠나도 드롭다운 안이면 묶음 전체 강조로 되돌린다(드롭다운을
                  // 아예 떠나면 위 onMouseLeave가 마지막에 실행돼 전부 지운다).
                  onHover={(over) =>
                    setHovered(
                      over ? new Set([t.id]) : new Set(cells.map((c) => c.id)),
                    )
                  }
                />
              ))}
              {/* 개별 칩 우클릭 메뉴의 '새 터미널'과 같은 동작 — 묶음 모드에선 프로젝트 단위
                  동선이 이 드롭다운뿐이라 여기에도 둔다. */}
              <div className="border-t border-edge" />
              <MenuRow
                icon={<TerminalIcon size={13} />}
                label={`'${groupMenu.name}'에 새 터미널 열기`}
                onClick={() => addTerminal(cells[0].projectId)}
              />
              {/* 묶음 단위 닫기 — 종류가 섞이므로 "터미널/브라우저"가 아니라 "탭"으로 부른다.
                  닫을 수 있는 셀이 없으면(별도 창 + 독립 브라우저 탭뿐) 항목 자체를 뺀다. */}
              {closable.length > 0 && (
                <MenuItem
                  icon={<X size={13} />}
                  label={`'${groupMenu.name}' 탭 ${closable.length}개 모두 닫기`}
                  danger
                  onClick={closeAll}
                />
              )}
            </div>
          );
        })()}

      {/* 자동배치 모드 팝오버 — 아이콘 클릭 = 그 모드로 저장 + 즉시 균등. 현재 모드는 탭 모으기
          ON과 같은 상태색(bg-raised text-accent). 헤더 우측 끝이라 우측 모서리 정렬(NewCellButton
          관례) — left 기준이면 창 밖으로 잘린다. */}
      {layoutMenu && n > 1 && (
        <div
          className="fixed z-50 flex items-center gap-1 rounded-md border border-edge bg-panel p-1 shadow-xl"
          style={{ right: layoutMenu.right, top: layoutMenu.top }}
          onMouseEnter={holdLayoutOpen}
          onMouseLeave={scheduleLayoutClose}
        >
          {LAYOUT_MODES.map(({ mode, Icon, title }) => (
            <button
              key={mode}
              title={title}
              onClick={() => pickLayout(mode)}
              className={`rounded p-1 ${
                layout === mode
                  ? "bg-raised text-accent"
                  : "text-fg-muted hover:bg-raised hover:text-fg"
              }`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      )}

      {chipMenu && (
        <ChipMenu
          cell={chipMenu.cell}
          x={chipMenu.x}
          y={chipMenu.y}
          shown={selected.has(chipMenu.cell.id)}
          zoomed={zoomedId === chipMenu.cell.id}
          promptOpen={chipPromptOpen}
          onClose={() => setChipMenu(null)}
          onToggle={() => toggle(chipMenu.cell.id)}
          onZoom={() => {
            const id = chipMenu.cell.id;
            initedRef.current = true;
            setSelected((prev) => new Set(prev).add(id)); // 숨김 상태에서도 확대가 바로 보이게
            setZoomed((z) => (z === id ? null : id));
          }}
          // 프롬프트 컬럼은 **표시 중인 터미널 셀**에만 — 숨김 셀은 켜도 모아보기 안에서 보이는
          // 변화가 없고(컬럼은 셀 본문 안), 브라우저 셀엔 프롬프트 기록이 없다.
          // 조건은 컨테이너가, 렌더는 메뉴가(onFloat/onCloseCell과 같은 관례).
          onTogglePrompt={
            selected.has(chipMenu.cell.id) && chipMenu.cell.kind === "terminal"
              ? () => togglePanel(chipMenu.cell.id)
              : undefined
          }
          // 번역(태스크 61)도 같은 판정 + **선택이 있을 때만** — 없으면 항목 자체를 그리지 않는다.
          onTranslate={
            selected.has(chipMenu.cell.id) &&
            chipMenu.cell.kind === "terminal" &&
            getTerminal(chipMenu.cell.id)?.term.hasSelection()
              ? () =>
                  openTranslate(
                    translateRequest(
                      getTerminal(chipMenu.cell.id)?.term.getSelection() ?? "",
                      chipMenu.x,
                      chipMenu.y,
                    ),
                  )
              : undefined
          }
          // 별도 창의 변경은 스토어가 메인에 위임한다(stores/terminals.ts terminals://cmd) —
          // 새 터미널·Float·닫기가 여기서도 그대로 동작한다. 예외는 **독립 브라우저 탭 닫기**뿐:
          // closeBrowserTab은 위임 경로가 없는 메인 전용이라 별도 창에선 항목을 빼 둔다.
          onNewTerminal={() => addTerminal(chipMenu.cell.projectId)}
          onFloat={
            chipMenu.cell.kind === "terminal" && chipMenu.cell.tabId != null
              ? () => floatPane(chipMenu.cell.tabId!, chipMenu.cell.id)
              : undefined
          }
          onCloseCell={
            IS_AGGREGATE_WINDOW && chipMenu.cell.tabId == null
              ? undefined
              : () => {
                  const c = chipMenu.cell;
                  if (c.kind === "terminal" && c.tabId != null) {
                    askConfirm({
                      title: "터미널 닫기",
                      message: `'${c.projName} · ${c.title}' 터미널을 닫을까요? 실행 중인 프로세스가 종료됩니다.`,
                      confirmLabel: "닫기",
                      danger: true,
                      onConfirm: () => closePane(c.tabId!, c.id),
                    });
                  } else if (c.tabId != null) {
                    // 브라우저 pane — 프로세스가 없으니 확인 없이(그리드 셀 X와 동일).
                    closePane(c.tabId, c.id);
                  } else {
                    closeBrowserTab(c.id);
                  }
                }
          }
        />
      )}
    </div>
  );
}

/**
 * 칩 우클릭 메뉴 — 그리드 표시 토글·확대·Float 분리·닫기.
 * 모양·닫힘 규칙은 TerminalPane의 PaneMenu와 동일(창 클릭·Esc로 닫힘, MenuItem 재사용).
 */
function ChipMenu({
  cell,
  x,
  y,
  shown,
  zoomed,
  promptOpen,
  onClose,
  onToggle,
  onZoom,
  onTogglePrompt,
  onTranslate,
  onNewTerminal,
  onFloat,
  onCloseCell,
}: {
  cell: CellMeta;
  x: number;
  y: number;
  shown: boolean;
  zoomed: boolean;
  /** onTogglePrompt가 있을 때만 의미 있다(라벨의 상태). */
  promptOpen?: boolean;
  onClose: () => void;
  onToggle: () => void;
  onZoom: () => void;
  /** 없으면 항목 자체를 그리지 않는다 — 표시 중 터미널 셀에만 넘어온다(onFloat 관례). */
  onTogglePrompt?: () => void;
  /** 선택이 있는 표시 중 터미널 셀에만 넘어온다(태스크 61). */
  onTranslate?: () => void;
  onNewTerminal?: () => void;
  onFloat?: () => void;
  onCloseCell?: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed z-50 min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        // 하단 클램프 = 메뉴 실높이. 헤더 24.5 + 항목 6 × 31.5 + 구분선 2 × 8.67 + 패딩·테두리 9.3
        // ≈ 240 → 8 단위 올림(PaneMenu와 같은 규칙). max(0, …)은 창이 메뉴보다 낮을 때 top이
        // 음수가 되어 위쪽 항목이 잘리는 것을 막는다(별도 창은 창 크기 제한이 낮다).
        // ponytail: 항목이 또 늘면 ref 실측으로. 번역 항목(선택이 있을 때만)은 32px을 더 잡는다.
        top: Math.max(0, Math.min(y, window.innerHeight - (onTranslate ? 280 : 248))),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 py-1 text-[11px] text-fg-dim">
        {cell.projName} · {cell.title}
      </div>
      <div className="my-1 border-t border-edge" />
      <MenuItem
        icon={shown ? <EyeOff size={14} /> : <Eye size={14} />}
        label={shown ? "그리드에서 숨기기" : "그리드에 표시"}
        onClick={run(onToggle)}
      />
      <MenuItem
        icon={zoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        label={zoomed ? "확대 해제" : "확대해서 보기"}
        onClick={run(onZoom)}
      />
      {onTogglePrompt && (
        <MenuItem
          icon={<History size={14} />}
          label={promptOpen ? "프롬프트 목록 닫기" : "프롬프트 목록 열기"}
          onClick={run(onTogglePrompt)}
        />
      )}
      {onTranslate && (
        <MenuItem
          icon={<Languages size={14} />}
          label="선택 영역 번역"
          onClick={run(onTranslate)}
        />
      )}
      {(onNewTerminal || onFloat || onCloseCell) && (
        <div className="my-1 border-t border-edge" />
      )}
      {onNewTerminal && (
        <MenuItem
          icon={<TerminalIcon size={14} />}
          label={`'${cell.projName}'에 새 터미널 열기`}
          onClick={run(onNewTerminal)}
        />
      )}
      {onFloat && (
        <MenuItem
          icon={<ExternalLink size={14} />}
          label="새 창으로 분리 (Float)"
          onClick={run(onFloat)}
        />
      )}
      {onCloseCell && (
        <MenuItem
          icon={<X size={14} />}
          label={cell.kind === "terminal" ? "터미널 닫기" : "브라우저 닫기"}
          danger
          onClick={run(onCloseCell)}
        />
      )}
    </div>
  );
}

/** 같은 프로젝트끼리 묶는다 — all이 projName 오름차순 정렬이라 인접 비교면 충분하다. */
function groupByProject(all: CellMeta[]): CellMeta[][] {
  const groups: CellMeta[][] = [];
  for (const c of all) {
    const last = groups[groups.length - 1];
    if (last && last[0].projName === c.projName) last.push(c);
    else groups.push([c]);
  }
  return groups;
}

/** 선택 칩 하나 — 클릭 토글·우클릭 메뉴·호버 시 해당 셀 강조. 칩 바와 묶음 드롭다운에서 공용. */
function Chip({
  t,
  on,
  full,
  onToggle,
  onMenu,
  onHover,
}: {
  t: CellMeta;
  on: boolean;
  /** 드롭다운 목록용 — 가로 폭을 채우고 제목을 더 길게 보여준다 */
  full?: boolean;
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
  onHover: (over: boolean) => void;
}) {
  return (
    <button
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      title={`${t.projName} · ${t.title} (우클릭: 메뉴)`}
      // 배경이 프로젝트 색이다 — 정렬로 같은 프로젝트를 붙여 놓아도 경계가 어디인지
      // 한눈에 안 들어와서(3px 막대는 너무 약했다) 칩 전체를 물들인다.
      style={{ backgroundColor: t.color.bg }}
      // 글자는 선택 여부와 무관하게 text-fg다. 예전처럼 미선택을 fg-muted로 흐리면
      // 물든 배경 위에서 대비가 무너진다(실측 solarized-light 3.5:1 — AA 미달).
      // 선택 표시는 ring-accent 하나가 한다 — 색이 불투명해져 선택/미선택 두 벌의 배경색이
      // 각각 32슬롯 대비 예산을 다시 받아야 하는데, 그럴 명도 여유가 라이트 2종에 없다.
      className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-fg ${
        on ? "ring-1 ring-accent" : ""
      } ${
        t.status === "working"
          ? "ai-working"
          : t.status === "done"
            ? "ai-done"
            : ""
      }${full ? " w-full" : ""}`}
    >
      {t.kind === "browser" ? (
        <Globe size={11} className="shrink-0 text-accent" />
      ) : (
        <StatusIcon status={t.status} />
      )}
      <span className={full ? "min-w-0 truncate" : "max-w-[120px] truncate"}>
        {t.projName}
        <span className="text-fg-dim"> · {t.title}</span>
      </span>
    </button>
  );
}

/** "+" 메뉴가 만들 수 있는 것 — 그리드 셀 종류 + "초기 입력만 다른" Claude Code 세션 터미널.
 *  라벨은 메뉴 행과 프로젝트 선택 머리말 두 곳이 같은 문구를 써야 해서 한 곳에 모은다. */
type NewCellKind = PaneKind | "claude";
const NEW_CELL_LABEL: Record<NewCellKind, string> = {
  terminal: "새 터미널",
  browser: "새 브라우저",
  claude: "Claude Code 세션 터미널",
};

/** 새 셀 추가 — "+" 하나로 종류(터미널 / Claude Code 세션 터미널 / 브라우저)를 고르고,
 *  프로젝트가 여러 개면 이어서 고른다.
 *  탭 스트립의 NewTabControls와 같은 방식으로 통일했다(버튼 두 개는 무엇을 하는지 구분이 안 됐다).
 *  API 클라이언트는 그리드가 지원하는 셀 종류가 아니라 여기 메뉴엔 없다.
 *
 *  프로젝트가 1개면 종류만 고르면 바로 생성한다(모호성 없음). 0개(또는 로딩 전)면 비활성.
 *  메뉴는 버튼 rect 기준 fixed 위치 + 백드롭 패턴 — 헤더(h-10) 밖으로 넘칠 때 클리핑을 벗어난다.
 *
 *  `onCreateBrowser`를 생략하면(별도 창 — 브라우저는 위임해도 이 창 그리드에 안 뜬다) 브라우저
 *  항목만 빠진다. 터미널 종류가 둘이라 종류 선택 단계 자체는 건너뛸 수 없다. */
function NewCellButton({
  projects,
  onCreateTerminal,
  onCreateBrowser,
}: {
  projects: Project[] | undefined;
  onCreateTerminal: (projectId: string, claude?: boolean) => void;
  onCreateBrowser?: (projectId: string) => void;
}) {
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  // 버튼이 헤더 우측 끝이라 좌측 기준(left)이면 메뉴가 창 밖으로 잘린다 — 우측 모서리 정렬
  const [menu, setMenu] = useState<{ right: number; y: number } | null>(null);
  // 2단계: null이면 종류 고르는 중, 값이 있으면 그 종류로 프로젝트 고르는 중
  const [kind, setKind] = useState<NewCellKind | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // 열린 동안 그리드의 모든 네이티브 webview를 숨긴다(점유 레지스트리가 단일 진실).
  useOccludesWebview(!!menu);

  const list = projects ?? [];
  // 마지막 선택 프로젝트를 맨 위로 — 나머지는 목록 순서 유지
  const ordered = [
    ...list.filter((p) => p.id === selectedProjectId),
    ...list.filter((p) => p.id !== selectedProjectId),
  ];

  const close = () => {
    setMenu(null);
    setKind(null);
  };
  const create = (k: NewCellKind, projectId: string) => {
    if (k === "browser") onCreateBrowser?.(projectId);
    else onCreateTerminal(projectId, k === "claude");
    close();
  };
  // 종류 선택 → 프로젝트가 하나뿐이면 바로 만들고, 여러 개면 프로젝트 목록으로 넘어간다.
  const pickKind = (k: NewCellKind) => {
    if (ordered.length === 1) create(k, ordered[0].id);
    else setKind(k);
  };

  const onClick = () => {
    if (menu) {
      close();
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenu({ right: window.innerWidth - r.right, y: r.bottom + 4 });
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={onClick}
        disabled={list.length === 0}
        // 텍스트가 없으므로 title이 유일한 설명이다 — e2e도 이 문구로 버튼을 찾는다.
        title={
          list.length === 0
            ? "프로젝트를 추가하면 새 터미널·브라우저를 열 수 있습니다"
            : onCreateBrowser
              ? "새 터미널 · 새 브라우저 — 이 화면에 바로 연다"
              : "새 터미널 · Claude Code 세션 터미널 — 이 화면에 바로 연다"
        }
        className="ml-1 flex shrink-0 items-center rounded p-1 text-fg-muted hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Plus size={15} />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="fixed z-50 max-h-80 min-w-44 overflow-auto rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
            style={{ right: menu.right, top: menu.y }}
          >
            {kind === null ? (
              <>
                <MenuRow
                  icon={<TerminalIcon size={14} />}
                  label={NEW_CELL_LABEL.terminal}
                  onClick={() => pickKind("terminal")}
                />
                {/* 새 터미널과 같되, 셸이 뜨면 `claude`를 입력해 바로 Claude Code 세션으로 간다. */}
                <MenuRow
                  icon={<Sparkles size={14} />}
                  label={NEW_CELL_LABEL.claude}
                  onClick={() => pickKind("claude")}
                />
                {/* 별도 창은 브라우저를 위임해도 이 창 그리드에 안 뜬다 — 그 창에선 항목을 뺀다. */}
                {onCreateBrowser && (
                  <MenuRow
                    icon={<Globe size={14} />}
                    label={NEW_CELL_LABEL.browser}
                    onClick={() => pickKind("browser")}
                  />
                )}
              </>
            ) : (
              <>
                {/* 어떤 종류를 만드는 중인지 잊지 않게 머리말로 남긴다 */}
                <div className="px-3 py-1 text-[11px] text-fg-dim">
                  {NEW_CELL_LABEL[kind]} — 프로젝트 선택
                </div>
                {ordered.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => create(kind, p.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
                  >
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** 그리드에서만 빼는 버튼 — 프로세스는 그대로 둔다(닫기 X와 구분되는 지점).
 *  상단 칩을 다시 누르면 돌아오므로, 별도 창에서도 안전해 항상 노출한다. */
function HideButton({ onClick, what }: { onClick: () => void; what: string }) {
  return (
    <button
      onClick={onClick}
      title={`숨기기 — 이 화면에서만 빼고 ${what}은 계속 실행됩니다 (상단 칩으로 되돌리기)`}
      className="shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
    >
      <EyeOff size={12} />
    </button>
  );
}

/** 메뉴 한 줄 — 아이콘 + 라벨. */
function MenuRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
    >
      <span className="shrink-0 text-fg-dim">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** 그리드 한 칸 — 라벨 헤더 + 실제 xterm(레지스트리에서 호스트를 붙인다).
 *  변/모서리 핸들 드래그는 그리드 트랙 경계를 움직인다(이웃과 재분배). 헤더 X로 닫는다. */
function AggregateCell({
  meta,
  fontSize,
  zoomed,
  onZoom,
  canRight,
  canBottom,
  onResizeStart,
  onHide,
  onClose,
}: {
  meta: TermMeta;
  fontSize: number;
  zoomed: boolean;
  onZoom: () => void;
  canRight: boolean;
  canBottom: boolean;
  onResizeStart: (e: React.PointerEvent, axis: "x" | "y" | "both") => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useAgentActivity((s) => s.byTerminal[meta.id]);
  const promptPanelOpen = usePromptHistory((s) => !!s.openPanels[meta.id]);

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    // 아직 렌더된 적 없는 터미널(비활성 탭 복구분)도 여기서 생성(멱등)해 붙인다.
    // attach 여부는 createTerminal이 판정한다 — 별도 창이면 메인이 만든 살아있는 PTY에
    // 재연결되고, 아직 PTY가 없는 복구분이면 새로 띄운다.
    void createTerminal({
      id: meta.id,
      projectId: meta.projectId,
      fontSize,
    }).then(() => {
      if (!cancelled && el) attachTerminal(meta.id, el);
    });
    const ro = new ResizeObserver(() => fitTerminal(meta.id));
    if (el) ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  return (
    <div
      className={`group/cell relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded border border-edge ${
        status === "working"
          ? "ai-working"
          : status === "done"
            ? "ai-done"
            : ""
      }`}
    >
      <div
        style={{ backgroundColor: meta.color.bg }}
        className="flex h-6 shrink-0 items-center gap-1.5 border-b border-edge px-2 text-[11px] text-fg-muted"
      >
        <StatusIcon status={status} />
        {/* h-6 헤더라 14px — 16px은 빡빡하다(태스크 54). */}
        <ProjectLogo projectId={meta.projectId} size={14} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{meta.projName}</span>
          <span className="text-fg-dim"> · {meta.title}</span>
        </span>
        <ThemeButton termId={meta.id} />
        <PromptLogButton termId={meta.id} />
        <GitDialogButton projectId={meta.projectId} />
        <button
          onClick={onZoom}
          title={
            zoomed
              ? "원래 크기로 — 그리드로 돌아갑니다"
              : "확대 — 이 터미널만 화면 가득 봅니다"
          }
          className="shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
        >
          {zoomed ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <HideButton onClick={onHide} what="터미널" />
        <button
          onClick={onClose}
          title="터미널 닫기 (프로세스 종료)"
          className="-mr-1 shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-danger"
        >
          <X size={12} />
        </button>
      </div>
      {/* 본문: xterm + (켜져 있으면) 우측 프롬프트 컬럼. 패널이 여닫히면 host 크기가 변해
          위 ResizeObserver가 refit한다 — xterm 배선 추가 없이 크기가 따라온다. */}
      <div className="flex min-h-0 flex-1">
        <div ref={ref} className="min-h-0 min-w-0 flex-1" />
        {promptPanelOpen && <PromptSidePanel termId={meta.id} />}
      </div>
      <CellHandles
        canRight={canRight}
        canBottom={canBottom}
        onResizeStart={onResizeStart}
      />
    </div>
  );
}

/** 브라우저 한 칸 — 식별 헤더(프로젝트 · 페이지 제목) + BrowserPane 재사용. 같은 id의
 *  네이티브 자식 webview(외부 URL)나 iframe(localhost·HTML 프리뷰)이 이 셀 위치로 따라온다.
 *  네이티브 webview는 항상 DOM 위에 뜨므로 핸들 자리(우/하 6px)를 비워 드래그 시작을 보장하고,
 *  suspended(트랙 드래그) 동안 active=false로 webview를 숨긴다. iframe은 드래그
 *  중 포인터를 차단해 pointermove가 iframe 문서로 새어 드래그가 끊기지 않게 한다. */
function BrowserCell({
  meta,
  suspended,
  layoutKey,
  canRight,
  canBottom,
  onResizeStart,
  onHide,
  onClose,
}: {
  meta: BrowserMeta;
  suspended: boolean;
  layoutKey: string;
  canRight: boolean;
  canBottom: boolean;
  onResizeStart: (e: React.PointerEvent, axis: "x" | "y" | "both") => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const ensurePane = useBrowsers((s) => s.ensurePane);
  // 분할 pane 브라우저가 워크스페이스에서 아직 렌더된 적 없어도 스토어 아이템을 보장(멱등).
  useEffect(() => {
    ensurePane(meta.id, meta.projectId);
  }, [meta.id, meta.projectId, ensurePane]);

  return (
    <div className="group/cell relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded border border-edge">
      <div
        style={{ backgroundColor: meta.color.bg }}
        className="flex h-6 shrink-0 items-center gap-1.5 border-b border-edge px-2 text-[11px] text-fg-muted"
      >
        <Globe size={11} className="shrink-0 text-accent" />
        <ProjectLogo projectId={meta.projectId} size={14} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{meta.projName}</span>
          <span className="text-fg-dim"> · {meta.title}</span>
        </span>
        <GitDialogButton projectId={meta.projectId} />
        <HideButton onClick={onHide} what="브라우저" />
        {/* 분할 pane(tabId 있음)은 closePane이라 위임을 탄다. 독립 브라우저 탭은 closeBrowserTab —
            위임 경로가 없는 메인 전용이라 별도 창에선 X를 감춘다(ChipMenu와 같은 규칙). */}
        {(!IS_AGGREGATE_WINDOW || meta.tabId != null) && (
          <button
            onClick={onClose}
            title="브라우저 닫기"
            className="-mr-1 shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-danger"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div
        className={`min-h-0 flex-1 ${suspended ? "pointer-events-none" : ""}${
          canRight ? " pr-1.5" : ""
        }${canBottom ? " pb-1.5" : ""}`}
      >
        <BrowserPane id={meta.id} active={!suspended} layoutKey={layoutKey} />
      </div>
      <CellHandles
        canRight={canRight}
        canBottom={canBottom}
        onResizeStart={onResizeStart}
      />
    </div>
  );
}

/** 트랙 경계 핸들 — 오른쪽 변(열 경계), 아래 변(행 경계), 모서리(양쪽). 이웃이 없는
 *  가장자리엔 안 그린다. 오른쪽 변은 헤더(h-6) 아래부터 — 닫기 버튼을 가리지 않게. */
function CellHandles({
  canRight,
  canBottom,
  onResizeStart,
}: {
  canRight: boolean;
  canBottom: boolean;
  onResizeStart: (e: React.PointerEvent, axis: "x" | "y" | "both") => void;
}) {
  return (
    <>
      {canRight && (
        <div
          onPointerDown={(e) => onResizeStart(e, "x")}
          className="absolute bottom-0 right-0 top-6 z-10 w-1.5 cursor-col-resize hover:bg-accent/50"
        />
      )}
      {canBottom && (
        <div
          onPointerDown={(e) => onResizeStart(e, "y")}
          className="absolute bottom-0 left-0 z-10 h-1.5 w-full cursor-row-resize hover:bg-accent/50"
        />
      )}
      {canRight && canBottom && (
        <div
          onPointerDown={(e) => onResizeStart(e, "both")}
          className="absolute bottom-0 right-0 z-20 size-3 cursor-nwse-resize bg-accent/0 group-hover/cell:bg-accent/40"
        />
      )}
    </>
  );
}

function StatusIcon({ status }: { status: "working" | "done" | undefined }) {
  if (status === "working")
    return <Loader2 size={11} className="shrink-0 animate-spin text-accent" />;
  if (status === "done")
    return <CircleCheck size={11} className="shrink-0 text-add" />;
  return <span className="size-[7px] shrink-0 rounded-full bg-fg-dim/50" />;
}
