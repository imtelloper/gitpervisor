import { CircleCheck, LayoutGrid, Loader2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Project } from "../lib/ipc";
import { isMac, modLabel } from "../lib/platform";
import { attachTerminal, createTerminal, fitTerminal } from "../lib/terminal";
import { useProjects, useSettings } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
import { collectByContent, useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";
import { EmptyState } from "./common/EmptyState";

// 모아보기 토글 단축키 라벨 — mac은 심볼 관례(⌘⇧A), 그 외는 Ctrl+Shift+A
const hotkeyLabel = isMac ? `${modLabel}⇧A` : `${modLabel}+Shift+A`;

interface TermMeta {
  paneId: string;
  tabId: string;
  projectId: string;
  projName: string;
  tabTitle: string;
  status: "working" | "done" | undefined;
}

// 트랙(열/행) 최소 크기(px) — 이보다 작으면 터미널이 못 읽힐 정도라 드래그 하한으로 막는다.
const MIN_W = 240;
const MIN_H = 160;
// 그리드 간격/패딩(px) — Tailwind gap-1.5 / p-1.5 = 6px와 맞춘다(트랙 px 환산용).
const GAP = 6;

/**
 * 터미널 모아보기 — 여러 프로젝트/탭에 흩어진 터미널을 한 화면에 분할해 동시에 본다.
 * 클로드(AI) 작업 중인 터미널을 기본 선택하고, 상단 칩으로 보고 싶은 것만 골라 그리드로 배치한다.
 * 이 뷰가 열리면 메인 워크스페이스(WorkspaceTabs)는 언마운트되고(App), 선택된 터미널의 xterm
 * 호스트를 이 그리드 셀로 옮겨 붙인다. 닫으면 워크스페이스가 다시 마운트되며 호스트를 되찾는다.
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
  // 드래그로 조절한 그리드 트랙(shape별 fr 배열) — ui 스토어에 영속돼 여닫아도 유지된다.
  const aggregateTracks = useUi((s) => s.aggregateTracks);
  const setAggregateTracks = useUi((s) => s.setAggregateTracks);

  // 모든 터미널 패널 메타 (스토어 기준 — 반응형). 브라우저 패널은 제외.
  const all = useMemo<TermMeta[]>(() => {
    const out: TermMeta[] = [];
    for (const tab of terminals) {
      for (const paneId of collectByContent(tab.layout, "terminal")) {
        out.push({
          paneId,
          tabId: tab.id,
          projectId: tab.projectId,
          projName: projects?.find((p) => p.id === tab.projectId)?.name ?? "프로젝트",
          tabTitle: tab.title,
          status: byTerminal[paneId],
        });
      }
    }
    return out;
  }, [terminals, projects, byTerminal]);

  // 선택 집합 — 최초엔 클로드 활동(working/done) 있는 터미널만. 없으면 전부.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current || all.length === 0) return;
    initedRef.current = true;
    const active = all.filter((t) => t.status).map((t) => t.paneId);
    setSelected(new Set(active.length ? active : all.map((t) => t.paneId)));
  }, [all]);

  // 사라진 터미널은 선택에서 제거
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(all.map((t) => t.paneId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [all]);

  const toggle = (paneId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
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

  const gridRef = useRef<HTMLDivElement>(null);

  const shown = all.filter((t) => selected.has(t.paneId));
  const n = shown.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(n / cols));

  // 행 단위로 자른 셀 목록 — 폭은 "행마다 독립"이라 행이 레이아웃의 기본 단위다.
  const rowsOfCells: TermMeta[][] = [];
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
        <span className="shrink-0 text-sm font-semibold">터미널 모아보기</span>
        <span className="shrink-0 text-[11px] text-fg-dim">
          {n}/{all.length} 선택
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pl-2">
          {all.map((t) => {
            const on = selected.has(t.paneId);
            return (
              <button
                key={t.paneId}
                onClick={() => toggle(t.paneId)}
                title={`${t.projName} · ${t.tabTitle}`}
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
                <StatusIcon status={t.status} />
                <span className="max-w-[120px] truncate">
                  {t.projName}
                  <span className="text-fg-dim"> · {t.tabTitle}</span>
                </span>
              </button>
            );
          })}
        </div>
        <NewTerminalButton projects={projects} onCreate={addTerminal} />
        <button
          onClick={() => setAggregateOpen(false)}
          title={`모아보기 닫기 (${hotkeyLabel})`}
          className="ml-1 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg"
        >
          <X size={14} /> 닫기
        </button>
      </div>

      {/* 그리드 */}
      {n === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title={all.length ? "표시할 터미널을 선택하세요" : "열린 터미널이 없습니다"}
          desc={
            all.length
              ? "위 칩에서 보고 싶은 터미널을 고르면 여기에 분할로 표시됩니다"
              : "위의 + 새 터미널 버튼으로 바로 열 수 있습니다"
          }
        />
      ) : (
        <div
          ref={gridRef}
          className="grid min-h-0 flex-1 gap-1.5 p-1.5"
          style={{
            // 외부는 행 트랙만(1열). grid-template-columns는 e2e가 그리드를 찾는 표식이라 유지.
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: rowFr.map((f) => `minmax(0, ${f}fr)`).join(" "),
          }}
        >
          {rowsOfCells.map((rowCells, r) => (
            <div
              key={rowCells[0].paneId}
              className="grid min-h-0 min-w-0 gap-1.5"
              style={{
                // 행마다 독립적인 셀 폭 — 이 행의 드래그는 이 배열만 바꾼다
                gridTemplateColumns: cellFr[r]
                  .map((f) => `minmax(0, ${f}fr)`)
                  .join(" "),
              }}
            >
              {rowCells.map((t, c) => (
                <AggregateCell
                  key={t.paneId}
                  meta={t}
                  fontSize={fontSize}
                  // 경계가 컨테이너 가장자리면 재분배할 이웃이 없다 — 핸들 생략
                  canRight={c < rowCells.length - 1}
                  canBottom={r < rowsOfCells.length - 1}
                  onResizeStart={(e, axis) => startResize(e, r, c, axis)}
                  onClose={() =>
                    askConfirm({
                      title: "터미널 닫기",
                      message: `'${t.projName} · ${t.tabTitle}' 터미널을 닫을까요? 실행 중인 프로세스가 종료됩니다.`,
                      confirmLabel: "닫기",
                      danger: true,
                      onConfirm: () => closePane(t.tabId, t.paneId),
                    })
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 새 터미널 추가 — 프로젝트 드롭다운에서 골라 생성. 1개면 드롭다운 생략 즉시 생성,
 *  0개(또는 로딩 전)면 비활성. 메뉴는 NewTabControls(WorkspaceTabs)와 같은
 *  버튼 rect 기준 fixed 위치 + 백드롭 패턴 — 헤더(h-10) 밖으로 넘칠 때 클리핑을 벗어난다. */
function NewTerminalButton({
  projects,
  onCreate,
}: {
  projects: Project[] | undefined;
  onCreate: (projectId: string) => void;
}) {
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  // 버튼이 헤더 우측 끝이라 좌측 기준(left)이면 메뉴가 창 밖으로 잘린다 — 우측 모서리 정렬
  const [menu, setMenu] = useState<{ right: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const list = projects ?? [];
  // 마지막 선택 프로젝트를 맨 위로 — 나머지는 목록 순서 유지
  const ordered = [
    ...list.filter((p) => p.id === selectedProjectId),
    ...list.filter((p) => p.id !== selectedProjectId),
  ];

  const onClick = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    if (ordered.length === 1) {
      onCreate(ordered[0].id); // 모호성 없음 — 드롭다운 생략
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
        title={
          list.length === 0
            ? "프로젝트를 추가하면 새 터미널을 열 수 있습니다"
            : "새 터미널 — 프로젝트를 골라 이 화면에 바로 연다"
        }
        className="ml-1 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Plus size={14} /> 새 터미널
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 max-h-80 min-w-40 overflow-auto rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
            style={{ right: menu.right, top: menu.y }}
          >
            {ordered.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  onCreate(p.id);
                  setMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
              >
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
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
  onClose,
}: {
  meta: TermMeta;
  fontSize: number;
  canRight: boolean;
  canBottom: boolean;
  onResizeStart: (e: React.PointerEvent, axis: "x" | "y" | "both") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useAgentActivity((s) => s.byTerminal[meta.paneId]);

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    // 아직 렌더된 적 없는 터미널(비활성 탭 복구분)도 여기서 생성(멱등)해 붙인다.
    void createTerminal({
      id: meta.paneId,
      projectId: meta.projectId,
      fontSize,
    }).then(() => {
      if (!cancelled && el) attachTerminal(meta.paneId, el);
    });
    const ro = new ResizeObserver(() => fitTerminal(meta.paneId));
    if (el) ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.paneId]);

  return (
    <div
      className={`group/cell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-edge ${
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
          <span className="text-fg-dim"> · {meta.tabTitle}</span>
        </span>
        <button
          onClick={onClose}
          title="터미널 닫기 (프로세스 종료)"
          className="-mr-1 shrink-0 rounded p-0.5 text-fg-dim hover:bg-raised hover:text-danger"
        >
          <X size={12} />
        </button>
      </div>
      <div ref={ref} className="min-h-0 flex-1" />
      {/* 트랙 경계 핸들 — 오른쪽 변(열 경계), 아래 변(행 경계), 모서리(양쪽). 이웃이 없는
          가장자리엔 안 그린다. 오른쪽 변은 헤더(h-6) 아래부터 — 닫기 버튼을 가리지 않게. */}
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
    </div>
  );
}

function StatusIcon({ status }: { status: "working" | "done" | undefined }) {
  if (status === "working")
    return <Loader2 size={11} className="shrink-0 animate-spin text-accent" />;
  if (status === "done")
    return <CircleCheck size={11} className="shrink-0 text-add" />;
  return <span className="size-[7px] shrink-0 rounded-full bg-fg-dim/50" />;
}
