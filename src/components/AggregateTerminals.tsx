import {
  CircleCheck,
  EyeOff,
  Globe,
  LayoutGrid,
  Loader2,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Project } from "../lib/ipc";
import { isMac, modLabel } from "../lib/platform";
import { attachTerminal, createTerminal, fitTerminal } from "../lib/terminal";
import { useProjects, useSettings } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
import { useBrowsers } from "../stores/browser";
import {
  collectByContent,
  IS_AGGREGATE_WINDOW,
  type PaneKind,
  useTerminals,
} from "../stores/terminals";
import { useOccludesWebview } from "../stores/occlusion";
import { useUi } from "../stores/ui";
import { EmptyState } from "./common/EmptyState";
import { BrowserPane } from "./workspace/BrowserPane";

// 모아보기 토글 단축키 라벨 — mac은 심볼 관례(⌘⇧A), 그 외는 Ctrl+Shift+A
const hotkeyLabel = isMac ? `${modLabel}⇧A` : `${modLabel}+Shift+A`;

/** 그리드 한 칸의 메타 — 터미널 pane 또는 브라우저(분할 pane·독립 탭)를 한 목록으로 다룬다. */
type CellMeta =
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

type TermMeta = Extract<CellMeta, { kind: "terminal" }>;
type BrowserMeta = Extract<CellMeta, { kind: "browser" }>;

// 트랙(열/행) 최소 크기(px) — 이보다 작으면 터미널이 못 읽힐 정도라 드래그 하한으로 막는다.
const MIN_W = 240;
const MIN_H = 160;
// 그리드 간격/패딩(px) — Tailwind gap-1.5 / p-1.5 = 6px와 맞춘다(트랙 px 환산용).
const GAP = 6;

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
  const { data: settings } = useSettings();
  const fontSize = settings?.terminalFontSize ?? 13;
  const terminals = useTerminals((s) => s.terminals);
  const openTerminal = useTerminals((s) => s.openTerminal);
  const closePane = useTerminals((s) => s.closePane);
  const askConfirm = useUi((s) => s.askConfirm);
  const byTerminal = useAgentActivity((s) => s.byTerminal);
  const browserItems = useBrowsers((s) => s.items);
  const browserTabIds = useBrowsers((s) => s.tabIds);
  const openBrowserTab = useBrowsers((s) => s.openBrowser);
  const closeBrowserTab = useBrowsers((s) => s.closeBrowser);
  // 드래그로 조절한 그리드 트랙(shape별 fr 배열) — ui 스토어에 영속돼 여닫아도 유지된다.
  const aggregateTracks = useUi((s) => s.aggregateTracks);
  const setAggregateTracks = useUi((s) => s.setAggregateTracks);

  // 모든 셀 메타 (스토어 기준 — 반응형): 탭별 터미널·브라우저 pane + 독립 브라우저 탭.
  const all = useMemo<CellMeta[]>(() => {
    const projName = (id: string) =>
      projects?.find((p) => p.id === id)?.name ?? "프로젝트";
    const out: CellMeta[] = [];
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
    return out;
  }, [terminals, projects, byTerminal, browserItems, browserTabIds]);

  // 선택 집합 — 최초엔 클로드 활동(working/done) 있는 터미널만. 없으면 전부(브라우저 포함).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
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
    if (!prev || !initedRef.current) return;
    const added = [...ids].filter((id) => !prev.has(id));
    if (added.length === 0) return;
    setSelected((sel) => {
      const next = new Set(sel);
      added.forEach((id) => next.add(id));
      return next;
    });
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

  // 새 터미널 생성 + 즉시 그리드 편입. initedRef 선행 — 터미널 0개에서 첫 생성 시
  // 초기 자동선택 효과가 뒤늦게 selected를 덮어쓰는 경합 차단. 스토어 갱신은 동기라
  // 신규 paneId만 selected에 넣으면 셀 마운트→PTY spawn→attach는 기존 경로로 완결된다.
  const addTerminal = (projectId: string) => {
    initedRef.current = true;
    const { paneId } = openTerminal(projectId);
    setSelected((prev) => new Set(prev).add(paneId));
  };

  // 새 브라우저(독립 탭) 생성 + 즉시 그리드 편입 — URL은 셀 안 주소창에서 입력한다.
  const addBrowser = (projectId: string) => {
    initedRef.current = true;
    const id = openBrowserTab(projectId);
    setSelected((prev) => new Set(prev).add(id));
  };

  const gridRef = useRef<HTMLDivElement>(null);
  // 트랙 드래그 중 — 네이티브 webview를 숨기고 iframe 포인터를 차단해야 드래그가 안 끊긴다.
  const [resizing, setResizing] = useState(false);

  const shown = all.filter((t) => selected.has(t.id));
  const n = shown.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(n / cols));

  // 행 단위로 자른 셀 목록 — 폭은 "행마다 독립"이라 행이 레이아웃의 기본 단위다.
  const rowsOfCells: CellMeta[][] = [];
  for (let i = 0; i < shown.length; i += cols)
    rowsOfCells.push(shown.slice(i, i + cols));

  // 현재 배치의 트랙 크기 — 행 높이(rowFr[r])와 행별 셀 폭(cellFr[r][c], fr 배열).
  // 가로 드래그는 같은 행의 이웃과만 재분배하므로 위/아래 행 폭에 영향이 없다.
  // 재분배(총합 불변)라 그리드가 항상 컨테이너를 정확히 채운다 → 셀이 밖으로 밀려나
  // 사라질 수 없다. 키는 n — 마지막 행 셀 수까지 n이 결정하므로 모양 충돌이 없다.
  const shape = `n${n}`;
  const rowLens = rowsOfCells.map((r) => r.length);
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
          {all.map((t) => {
            const on = selected.has(t.id);
            return (
              <button
                key={t.id}
                onClick={() => toggle(t.id)}
                title={`${t.projName} · ${t.title}`}
                className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] ${
                  on
                    ? "bg-accent/20 text-fg ring-1 ring-accent"
                    : "bg-raised text-fg-muted hover:text-fg"
                } ${
                  t.status === "working"
                    ? "ai-working"
                    : t.status === "done"
                      ? "ai-done"
                      : ""
                }`}
              >
                {t.kind === "browser" ? (
                  <Globe size={11} className="shrink-0 text-accent" />
                ) : (
                  <StatusIcon status={t.status} />
                )}
                <span className="max-w-[120px] truncate">
                  {t.projName}
                  <span className="text-fg-dim"> · {t.title}</span>
                </span>
              </button>
            );
          })}
        </div>
        {/* 별도 창은 "보는 화면"이다 — 터미널을 만들고 닫는 관리는 메인 창에서 한다.
            (이 창의 스토어는 영속되지 않아 여기서 만든 터미널을 메인이 알 수 없고, 여기서
            닫으면 메인이 소유한 PTY가 죽는다.) */}
        {!IS_AGGREGATE_WINDOW && (
          <NewCellButton
            projects={projects}
            onCreateTerminal={addTerminal}
            onCreateBrowser={addBrowser}
          />
        )}
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
                const style = {
                  top,
                  height,
                  left: `calc(${GAP + c * GAP}px + ${leftFrac} * (100% - ${fixedH}px))`,
                  width: `calc(${cellFr[r][c] / sumC} * (100% - ${fixedH}px))`,
                };
                return (
                  <div key={t.id} className="absolute" style={style}>
                    {t.kind === "browser" ? (
                      <BrowserCell
                        meta={t}
                        // 드래그 중엔 네이티브 webview 숨김+iframe 포인터 차단, 드롭다운
                        // 열림 중엔 fixed 메뉴가 webview에 가려지지 않게 숨긴다.
                        suspended={resizing}
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
                        // 경계가 컨테이너 가장자리면 재분배할 이웃이 없다 — 핸들 생략
                        canRight={c < len - 1}
                        canBottom={r < rowsOfCells.length - 1}
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
    </div>
  );
}

/** 새 셀 추가 — "+" 하나로 종류(터미널/브라우저)를 고르고, 프로젝트가 여러 개면 이어서 고른다.
 *  탭 스트립의 NewTabControls와 같은 방식으로 통일했다(버튼 두 개는 무엇을 하는지 구분이 안 됐다).
 *  API 클라이언트는 그리드가 지원하는 셀 종류가 아니라 여기 메뉴엔 없다.
 *
 *  프로젝트가 1개면 종류만 고르면 바로 생성한다(모호성 없음). 0개(또는 로딩 전)면 비활성.
 *  메뉴는 버튼 rect 기준 fixed 위치 + 백드롭 패턴 — 헤더(h-10) 밖으로 넘칠 때 클리핑을 벗어난다. */
function NewCellButton({
  projects,
  onCreateTerminal,
  onCreateBrowser,
}: {
  projects: Project[] | undefined;
  onCreateTerminal: (projectId: string) => void;
  onCreateBrowser: (projectId: string) => void;
}) {
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  // 버튼이 헤더 우측 끝이라 좌측 기준(left)이면 메뉴가 창 밖으로 잘린다 — 우측 모서리 정렬
  const [menu, setMenu] = useState<{ right: number; y: number } | null>(null);
  // 2단계: null이면 종류 고르는 중, 값이 있으면 그 종류로 프로젝트 고르는 중
  const [kind, setKind] = useState<PaneKind | null>(null);
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
  const create = (k: PaneKind, projectId: string) => {
    if (k === "terminal") onCreateTerminal(projectId);
    else onCreateBrowser(projectId);
    close();
  };
  // 종류 선택 → 프로젝트가 하나뿐이면 바로 만들고, 여러 개면 프로젝트 목록으로 넘어간다.
  const pickKind = (k: PaneKind) => {
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
            : "새 터미널 · 새 브라우저 — 이 화면에 바로 연다"
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
                  label="새 터미널"
                  onClick={() => pickKind("terminal")}
                />
                <MenuRow
                  icon={<Globe size={14} />}
                  label="새 브라우저"
                  onClick={() => pickKind("browser")}
                />
              </>
            ) : (
              <>
                {/* 어떤 종류를 만드는 중인지 잊지 않게 머리말로 남긴다 */}
                <div className="px-3 py-1 text-[11px] text-fg-dim">
                  {kind === "terminal" ? "새 터미널" : "새 브라우저"} — 프로젝트 선택
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
  canRight,
  canBottom,
  onResizeStart,
  onHide,
  onClose,
}: {
  meta: TermMeta;
  fontSize: number;
  canRight: boolean;
  canBottom: boolean;
  onResizeStart: (e: React.PointerEvent, axis: "x" | "y" | "both") => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useAgentActivity((s) => s.byTerminal[meta.id]);

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
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-edge bg-panel px-2 text-[11px] text-fg-muted">
        <StatusIcon status={status} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{meta.projName}</span>
          <span className="text-fg-dim"> · {meta.title}</span>
        </span>
        <HideButton onClick={onHide} what="터미널" />
        {!IS_AGGREGATE_WINDOW && (
          <button
            onClick={onClose}
            title="터미널 닫기 (프로세스 종료)"
            className="-mr-1 shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-danger"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div ref={ref} className="min-h-0 flex-1" />
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
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-edge bg-panel px-2 text-[11px] text-fg-muted">
        <Globe size={11} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{meta.projName}</span>
          <span className="text-fg-dim"> · {meta.title}</span>
        </span>
        <HideButton onClick={onHide} what="브라우저" />
        {!IS_AGGREGATE_WINDOW && (
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
