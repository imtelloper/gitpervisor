import { CircleCheck, LayoutGrid, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { attachTerminal, createTerminal, fitTerminal } from "../lib/terminal";
import { useProjects, useSettings } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
import { collectByContent, useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";
import { EmptyState } from "./common/EmptyState";

interface TermMeta {
  paneId: string;
  projectId: string;
  projName: string;
  tabTitle: string;
  status: "working" | "done" | undefined;
}

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
  const byTerminal = useAgentActivity((s) => s.byTerminal);

  // 모든 터미널 패널 메타 (스토어 기준 — 반응형). 브라우저 패널은 제외.
  const all = useMemo<TermMeta[]>(() => {
    const out: TermMeta[] = [];
    for (const tab of terminals) {
      for (const paneId of collectByContent(tab.layout, "terminal")) {
        out.push({
          paneId,
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

  const shown = all.filter((t) => selected.has(t.paneId));
  const n = shown.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;

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
        <button
          onClick={() => setAggregateOpen(false)}
          title="모아보기 닫기"
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
              : "프로젝트에서 터미널을 연 뒤 다시 열어보세요"
          }
        />
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-1.5 overflow-auto p-1.5"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridAutoRows: "minmax(200px, 1fr)",
          }}
        >
          {shown.map((t) => (
            <AggregateCell
              key={t.paneId}
              meta={t}
              fontSize={fontSize}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 그리드 한 칸 — 라벨 헤더 + 실제 xterm(레지스트리에서 호스트를 붙인다). */
function AggregateCell({ meta, fontSize }: { meta: TermMeta; fontSize: number }) {
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
      className={`group/cell relative flex min-h-0 flex-col overflow-hidden rounded border border-edge ${
        status === "working"
          ? "ai-working"
          : status === "done"
            ? "ai-done"
            : ""
      }`}
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-edge bg-panel px-2 text-[11px] text-fg-muted">
        <StatusIcon status={status} />
        <span className="truncate font-medium text-fg">{meta.projName}</span>
        <span className="truncate text-fg-dim">· {meta.tabTitle}</span>
      </div>
      <div ref={ref} className="min-h-0 flex-1" />
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
