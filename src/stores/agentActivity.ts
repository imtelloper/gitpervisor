import type { Terminal } from "@xterm/xterm";
import { useEffect } from "react";
import { create } from "zustand";

import { listTerminals } from "../lib/terminal";

export type AgentState = "working" | "done";

interface AgentActivityStore {
  /** projectId → 에이전트 상태. 키가 없으면 배지 표시 안 함. */
  byProject: Record<string, AgentState>;
  /** termId(=paneId) → 에이전트 상태. 터미널 탭 무지개 표시용. */
  byTerminal: Record<string, AgentState>;
  applyScan: (
    workingByProject: Map<string, boolean>,
    workingByTerminal: Map<string, boolean>,
  ) => void;
}

function sameRecord(
  a: Record<string, AgentState>,
  b: Record<string, AgentState>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// 작업 맵 → 상태 맵. working이면 "working", 한 번이라도 working/done이었으면 "done" 유지,
// 그 외(처음 보는데 작업 안 함)는 표시 없음. 닫힌 키는 빠져 자연 해제된다.
function reduceStates(
  working: Map<string, boolean>,
  prevStates: Record<string, AgentState>,
): Record<string, AgentState> {
  const next: Record<string, AgentState> = {};
  for (const [key, isWorking] of working) {
    const prev = prevStates[key];
    if (isWorking) next[key] = "working";
    else if (prev === "working" || prev === "done") next[key] = "done";
  }
  return next;
}

export const useAgentActivity = create<AgentActivityStore>((set) => ({
  byProject: {},
  byTerminal: {},
  applyScan: (workingByProject, workingByTerminal) =>
    set((s) => {
      const nextProject = reduceStates(workingByProject, s.byProject);
      const nextTerminal = reduceStates(workingByTerminal, s.byTerminal);
      const projectSame = sameRecord(s.byProject, nextProject);
      const terminalSame = sameRecord(s.byTerminal, nextTerminal);
      if (projectSame && terminalSame) return s;
      return {
        byProject: projectSame ? s.byProject : nextProject,
        byTerminal: terminalSame ? s.byTerminal : nextTerminal,
      };
    }),
}));

// Claude Code는 한 턴을 처리하는 동안 하단 상태줄에 "esc to interrupt"를 표시한다.
// 이 마커가 보이면 작업 중, 사라지면 직전 턴이 끝난 것으로 본다(완료).
const WORKING_RE = /esc to interrupt/i;

// 현재 화면(뷰포트)에 그려진 모든 줄을 읽는다. Claude Code는 "esc to interrupt"를 입력
// 커서 '아래' 푸터(plan mode 줄 등)에 그리기도 해서 커서 위쪽만 보면 놓친다. 또 새 터미널은
// 내용이 상단에 있고 하단이 빈 줄이라 "버퍼 끝줄"만 봐도 안 된다 → 보이는 화면 전체를 본다.
function visibleScreen(term: Terminal): string {
  const buf = term.buffer.active;
  const start = buf.baseY;
  const end = Math.min(buf.length, buf.baseY + term.rows);
  let s = "";
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) s += line.translateToString(true) + "\n";
  }
  return s;
}

/** 모든 라이브 터미널 버퍼를 스캔해 프로젝트별·터미널별 작업중 여부를 산출하고 스토어에 반영. */
export function scanAgents() {
  // 창이 보이지 않으면(최소화/비포커스) 표시가 어차피 안 보이므로 스캔을 건너뛴다 —
  // 매 1.2초 전 터미널 버퍼를 읽는 비용을 절약. 복귀 시 다음 틱(≤1.2s)에 현재 상태로 복원된다.
  if (typeof document !== "undefined" && document.hidden) return;
  const byProject = new Map<string, boolean>();
  const byTerminal = new Map<string, boolean>();
  for (const t of listTerminals()) {
    if (t.status !== "live") continue;
    const isWorking = WORKING_RE.test(visibleScreen(t.term));
    byTerminal.set(t.id, isWorking); // t.id = paneId
    byProject.set(t.projectId, (byProject.get(t.projectId) ?? false) || isWorking);
  }
  useAgentActivity.getState().applyScan(byProject, byTerminal);
}

/** 1.2초 간격 스캐너 — 앱에서 1회 마운트. */
export function useAgentScanner() {
  useEffect(() => {
    const id = window.setInterval(scanAgents, 1200);
    return () => window.clearInterval(id);
  }, []);
}
