import type { Terminal } from "@xterm/xterm";
import { useEffect } from "react";
import { create } from "zustand";

import { listTerminals } from "../lib/terminal";

export type AgentState = "working" | "done";

interface AgentActivityStore {
  /** projectId → 에이전트 상태. 키가 없으면 배지 표시 안 함. */
  byProject: Record<string, AgentState>;
  applyScan: (workingByProject: Map<string, boolean>) => void;
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

export const useAgentActivity = create<AgentActivityStore>((set) => ({
  byProject: {},
  applyScan: (working) =>
    set((s) => {
      const next: Record<string, AgentState> = {};
      // working 맵의 키 = 라이브 터미널이 있는 프로젝트. 닫힌 프로젝트는 키가 빠져
      // 자연히 배지가 해제된다. 한 번 working이었다가 멈추면 done으로 유지된다.
      for (const [pid, isWorking] of working) {
        const prev = s.byProject[pid];
        if (isWorking) next[pid] = "working";
        else if (prev === "working" || prev === "done") next[pid] = "done";
        // prev 없음 + 작업 안 함 → 표시 없음
      }
      return sameRecord(s.byProject, next) ? s : { byProject: next };
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

/** 모든 라이브 터미널 버퍼를 스캔해 프로젝트별 작업중 여부를 산출하고 스토어에 반영. */
export function scanAgents() {
  const working = new Map<string, boolean>();
  for (const t of listTerminals()) {
    if (t.status !== "live") continue;
    const prev = working.get(t.projectId) ?? false;
    working.set(t.projectId, prev || WORKING_RE.test(visibleScreen(t.term)));
  }
  useAgentActivity.getState().applyScan(working);
}

/** 1.2초 간격 스캐너 — 앱에서 1회 마운트. */
export function useAgentScanner() {
  useEffect(() => {
    const id = window.setInterval(scanAgents, 1200);
    return () => window.clearInterval(id);
  }, []);
}
