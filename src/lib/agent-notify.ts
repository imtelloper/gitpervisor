import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useEffect, useRef } from "react";

import { useProjects, useSettings } from "../queries";
import { useAgentActivity, type AgentState } from "../stores/agentActivity";
import { ipc, type Project, type Settings } from "./ipc";
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

// Windows는 앱 AUMID로 직접 토스트를 띄운다(플러그인은 dev에서 PowerShell 명의로 떠 아이콘이
// 안 보임 — desktop.rs:201). 그 외 플랫폼은 플러그인 sendNotification을 그대로 쓴다.
const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

async function fire(title: string, body: string) {
  if (IS_WINDOWS) {
    try {
      await ipc.notifyOs(title, body);
      return;
    } catch {
      /* 실패하면 아래 플러그인 경로로 폴백 */
    }
  }
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
  const settingsRef = useRef<Settings | undefined>(undefined);
  settingsRef.current = settings;

  const byProject = useAgentActivity((s) => s.byProject);
  const byTerminal = useAgentActivity((s) => s.byTerminal);
  const prevProject = useRef<Record<string, AgentState>>({});
  const prevTerminal = useRef<Record<string, AgentState>>({});
  // 외부 채널(Slack/email) 연타 방지 — 키(프로젝트/터미널)당 최소 간격.
  const lastExternal = useRef<Record<string, number>>({});

  const projectName = (pid: string | undefined) =>
    (pid && projRef.current?.find((p) => p.id === pid)?.name) || "프로젝트";

  // OS 토스트에 더해 Slack/email로도 보낸다(설정에 켜졌을 때만). 실패는 무시(OS 토스트가 폴백).
  const fireExternal = (title: string, body: string, key: string) => {
    const s = settingsRef.current;
    if (!s || (!s.slackEnabled && !s.emailEnabled)) return;
    const now = Date.now();
    if (now - (lastExternal.current[key] ?? 0) < 30_000) return; // 키당 30초
    lastExternal.current[key] = now;
    void ipc.notifyExternal(title, body).catch(() => {});
  };

  // 프로젝트 단위 엣지 (project-inactive / always)
  useEffect(() => {
    const m = modeRef.current;
    const prev = prevProject.current;
    if (m === "project-inactive" || m === "always") {
      for (const [pid, st] of Object.entries(byProject)) {
        if (st === "done" && prev[pid] === "working") {
          if (m === "project-inactive" && document.hasFocus()) continue;
          const body = `${projectName(pid)} — 작업이 끝났습니다`;
          void fire("AI 작업 완료", body);
          fireExternal("AI 작업 완료", body, `p:${pid}`);
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
          const body = `${projectName(pid)} — 터미널 작업이 끝났습니다`;
          void fire("AI 작업 완료", body);
          fireExternal("AI 작업 완료", body, `t:${tid}`);
        }
      }
    }
    prevTerminal.current = byTerminal;
  }, [byTerminal]);
}
