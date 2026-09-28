import { useSettings } from "../queries";
import { useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";
import { errorMessage, ipc } from "./ipc";
import { prepareOpenCode } from "./opencode";
import type { SplitDir } from "./pane-tree";
import {
  CLAUDE_LAUNCH,
  formatLaunch,
  getTerminal,
  type InitialInput,
  queueInitialInput,
} from "./terminal";

// 새 터미널을 에이전트 세션으로 띄우는 공용 경로 — 터미널을 새로 만드는 곳은 전부 이걸 거친다.
//  - 종류를 **고르는** 곳("+" 메뉴·"OpenCode로 분할" 등)은 그 종류를 넘긴다.
//  - 종류를 **고르지 않는** 곳(단축키·분할 버튼·우클릭 "새 터미널")은 설정 "새 터미널 시작"
//    (`terminalStartAgent`)을 넘긴다 — `useStartAgent()`.
// 2/4/8 그리드는 기본값을 따르지 않는다: 한 번에 최대 7개의 에이전트가 뜨면 메모리를 크게 먹는다
// (OpenCode 한 개가 수백 MB — 2026-08 OOM 사건 참고). 그리드는 셸로 열고 필요한 칸에서 띄운다.

export type TerminalAgent = "claude" | "opencode";

/** 설정값 → 에이전트. 빈값·모르는 값은 null(셸만). */
export function agentOf(v: string | null | undefined): TerminalAgent | null {
  return v === "claude" || v === "opencode" ? v : null;
}

/** 설정 "새 터미널 시작" — 종류를 고르지 않고 여는 곳이 따른다. */
export function useStartAgent(): TerminalAgent | null {
  return agentOf(useSettings().data?.terminalStartAgent);
}

/** 에이전트의 초기 입력을 준비해 `open`에 넘긴다. 셸이면 입력 없이 바로 연다.
 *  Claude는 **동기**로 연다(예전 동작 그대로 — 예약이 pane 마운트보다 먼저 저장된다).
 *  OpenCode는 첫 사용이면 안내·다운로드가 끼어 비동기이고, 취소·실패면 **열지 않는다** —
 *  먼저 열어 두면 기다리는 동안 빈 셸이 떠 있고 취소하면 쓸모없는 터미널만 남는다. */
export function runWithAgent(
  agent: TerminalAgent | null,
  open: (input?: InitialInput) => void,
): void {
  if (!agent) return open();
  if (agent === "claude") return open(CLAUDE_LAUNCH);
  void prepareOpenCode().then((spec) => {
    if (spec) open(spec);
  });
}

/** 이미 열린 터미널에 에이전트를 띄운다(헤더의 에이전트 버튼) — 지금 프롬프트에 실행 줄을 입력한다.
 *  `term.input`이라 키 입력과 같은 경로(onData → ptyWrite)를 타 순서·프롬프트 기록이 그대로다.
 *  OpenCode 줄은 셸마다 문법이 달라 이 PTY가 **실제로 띄운 셸**을 백엔드에 묻는다 — 별도 창은
 *  attach라 open 응답의 셸을 모른다. */
export async function launchAgentInTerminal(termId: string, agent: TerminalAgent): Promise<void> {
  let line = CLAUDE_LAUNCH;
  if (agent === "opencode") {
    const spec = await prepareOpenCode();
    if (!spec) return; // 취소·실패 — prepareOpenCode가 이미 알렸다
    try {
      line = formatLaunch(spec, await ipc.termShell(termId));
    } catch (e) {
      useUi.getState().pushToast("error", errorMessage(e));
      return;
    }
  }
  getTerminal(termId)?.term.input(line);
}

/** 새 터미널 탭. */
export function openTerminalWith(projectId: string, agent: TerminalAgent | null): void {
  runWithAgent(agent, (input) => {
    const { paneId } = useTerminals.getState().openTerminal(projectId);
    if (input) queueInitialInput(paneId, input);
  });
}

/** 패널 분할 — 새 칸에 에이전트를 띄운다. */
export function splitPaneWith(
  tabId: string,
  paneId: string,
  dir: SplitDir,
  newFirst: boolean,
  agent: TerminalAgent | null,
): void {
  runWithAgent(agent, (input) => {
    const newPaneId = useTerminals.getState().splitPane(tabId, paneId, dir, newFirst);
    if (input) queueInitialInput(newPaneId, input);
  });
}
