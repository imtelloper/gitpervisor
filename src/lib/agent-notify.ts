import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useEffect, useRef } from "react";

import { useProjects, useSettings } from "../queries";
import { useAgentActivity, type AgentState } from "../stores/agentActivity";
import type { Project } from "./ipc";
import { listTerminals } from "./terminal";

// OS 알림 권한은 1회만 요청한다(여러 알림이 동시에 권한을 묻지 않게 프라미스 캐시).
let permPromise: Promise<boolean> | null = null;
function ensurePermission(): Promise<boolean> {
  if (!permPromise) {
    permPromise = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === "granted";
      } catch {
        return false;
      }
    })();
  }
  return permPromise;
}

async function fire(title: string, body: string) {
  if (!(await ensurePermission())) return;
  try {
    sendNotification({ title, body });
  } catch {
    /* 알림 실패는 무시 — 상태바 칩이 폴백 */
  }
}

/**
 * AI(터미널 Claude) 작업 완료 시 OS 알림. 완료는 agentActivity의 working→done 엣지로 감지한다.
 * 모드(settings.notifyMode):
 *  - off: 알림 안 함
 *  - project-inactive: 프로젝트 단위, 창이 비활성(비포커스)일 때만 (기본)
 *  - terminal: 분할된 터미널 단위로 매번
 *  - always: 프로젝트 단위, 포커스 중에도 매번
 *
 * 메인 창에서만 1회 마운트한다(App). 플로팅 터미널 창은 이 훅을 마운트하지 않아 중복이 없다.
 *
 * 알림 클릭→프로젝트 이동: 데스크톱 토스트의 본문 클릭 콜백은 플랫폼/설치 상태에 따라
 * 신뢰성이 낮아, 보장된 클릭 이동 경로는 상태바의 AI 칩(StatusBar)이 담당한다.
 * (클릭 시 OS가 앱 창을 전면으로 가져오는 것은 기본 동작이다.)
 */
export function useAgentNotifications() {
  const { data: settings } = useSettings();
  const { data: projects } = useProjects();
  const mode = settings?.notifyMode || "project-inactive";

  const projRef = useRef<Project[] | undefined>(undefined);
  projRef.current = projects;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const byProject = useAgentActivity((s) => s.byProject);
  const byTerminal = useAgentActivity((s) => s.byTerminal);
  const prevProject = useRef<Record<string, AgentState>>({});
  const prevTerminal = useRef<Record<string, AgentState>>({});

  const projectName = (pid: string | undefined) =>
    (pid && projRef.current?.find((p) => p.id === pid)?.name) || "프로젝트";

  // 프로젝트 단위 엣지 (project-inactive / always)
  useEffect(() => {
    const m = modeRef.current;
    const prev = prevProject.current;
    if (m === "project-inactive" || m === "always") {
      for (const [pid, st] of Object.entries(byProject)) {
        if (st === "done" && prev[pid] === "working") {
          if (m === "project-inactive" && document.hasFocus()) continue;
          void fire("AI 작업 완료", `${projectName(pid)} — 작업이 끝났습니다`);
        }
      }
    }
    prevProject.current = byProject;
  }, [byProject]);

  // 터미널 단위 엣지 (terminal)
  useEffect(() => {
    const m = modeRef.current;
    const prev = prevTerminal.current;
    if (m === "terminal") {
      for (const [tid, st] of Object.entries(byTerminal)) {
        if (st === "done" && prev[tid] === "working") {
          const pid = listTerminals().find((t) => t.id === tid)?.projectId;
          void fire(
            "AI 작업 완료",
            `${projectName(pid)} — 터미널 작업이 끝났습니다`,
          );
        }
      }
    }
    prevTerminal.current = byTerminal;
  }, [byTerminal]);
}
