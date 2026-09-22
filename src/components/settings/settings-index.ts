// 설정 카테고리 + 검색 인덱스 (태스크 18). 검색·하이라이트·완전성 가드의 단일 진실.
// 필드 추가 시 SETTINGS_INDEX에 항목 하나 + 카탈로그(`settings.search`)에 label·keywords —
// E2E 29가 Settings 런타임 키 커버리지를, tsc가 카탈로그 누락을 가드한다.
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpCircle,
  Bell,
  Code2,
  Palette,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "lucide-react";

import type { Messages } from "../../i18n/messages";
import { settingsText } from "../../i18n/text-settings";
import type { Settings } from "../../lib/ipc";

export type SettingsCategory =
  | "general"
  | "appearance"
  | "codetools"
  | "terminal"
  | "notify"
  | "ai"
  | "maintenance"
  | "update";

/** 라벨은 카탈로그 `settings.categoryLabel[id]` — 언어가 실행 중에 바뀌므로 여기 담지 않는다. */
export const CATEGORIES: { id: SettingsCategory; icon: LucideIcon }[] = [
  { id: "general", icon: SlidersHorizontal },
  { id: "appearance", icon: Palette },
  { id: "codetools", icon: Code2 },
  { id: "terminal", icon: TerminalSquare },
  { id: "notify", icon: Bell },
  { id: "maintenance", icon: Wrench },
  { id: "ai", icon: Sparkles },
  { id: "update", icon: ArrowUpCircle },
];

/** 카탈로그 `settings.search`의 키 — 항목의 label·keywords가 사는 곳. */
export type SettingsSearchId = keyof Messages["settings"]["search"];

export type SettingIndexEntry = {
  category: SettingsCategory;
  /** 조건 렌더로 숨을 수 있는 필드의 부모 토글 — 그 토글이 꺼져 있으면 토글을 대신 하이라이트. */
  parentToggle?: keyof Settings;
} & (
  | {
      /** 대응 Settings 필드. 완전성 가드(E2E)가 이 키 집합을 쓴다. */
      key: keyof Settings & SettingsSearchId;
      id?: undefined;
    }
  | {
      /** 즉시 액션·시크릿은 null — 하이라이트 식별자는 id. */
      key: null;
      id: SettingsSearchId;
    }
);

// Settings 전 필드(key 지정) + 시크릿 2 + 즉시 액션(다운로드·테스트·유지보수·업데이트).
// **완전성 가드(E2E 29 ⑤)가 getSettings 런타임 키를 이 배열의 non-null key와 대조한다** —
// Settings에 필드를 더하면 여기도 한 줄 더해야 스위트가 통과한다.
export const SETTINGS_INDEX: SettingIndexEntry[] = [
  // 일반
  { category: "general", key: "uiLanguage" },
  { category: "general", key: "remoteRefreshMinutes" },
  { category: "general", key: "confirmDiscard" },
  { category: "general", key: "gitPath" },
  { category: "general", key: "favoriteFolders" },
  // 모양
  { category: "appearance", key: "theme" },
  { category: "appearance", key: "diffFontSize" },
  // 코드 도구
  { category: "codetools", key: "formatterRuffPath" },
  { category: "codetools", key: "formatterBiomePath" },
  { category: "codetools", key: "formatOnSave" },
  { category: "codetools", key: "formatterProjectLocal" },
  { category: "codetools", key: "lspEnabledProjects" },
  { category: "codetools", key: "lspWorkspaceTsserver" },
  { category: "codetools", key: null, id: "lspDownload" },
  { category: "codetools", key: "videoFfmpegPath" },
  { category: "codetools", key: null, id: "ffmpegDownload" },
  // 터미널
  { category: "terminal", key: "terminalShell" },
  { category: "terminal", key: "terminalFontSize" },
  // 알림
  { category: "notify", key: "notifyMode" },
  { category: "notify", key: "slackEnabled" },
  { category: "notify", key: null, id: "slackSecret", parentToggle: "slackEnabled" },
  { category: "notify", key: "emailEnabled" },
  { category: "notify", key: "smtpHost", parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpPort", parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpFrom", parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpTo", parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpUsername", parentToggle: "emailEnabled" },
  { category: "notify", key: null, id: "smtpSecret", parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpTls", parentToggle: "emailEnabled" },
  // 유지보수 (즉시 액션 — key null)
  { category: "maintenance", key: null, id: "browserData" },
  { category: "maintenance", key: null, id: "crashLog" },
  { category: "maintenance", key: null, id: "quarantine" },
  { category: "notify", key: null, id: "healthAlert" },
  // AI (로컬 LLM — 태스크 59). 다운로드·테스트는 즉시 액션(key null).
  { category: "ai", key: null, id: "llmRuntimeDownload" },
  { category: "ai", key: "llmModel" },
  { category: "ai", key: "reportAutoWeekly" },
  { category: "ai", key: "llmReportModel" },
  { category: "ai", key: "reportPrompt" },
  { category: "ai", key: null, id: "llmModelDownload" },
  { category: "ai", key: null, id: "llmTest" },
  { category: "ai", key: null, id: "llmDeleteModels" },
  { category: "ai", key: "llmProvider" },
  { category: "ai", key: "llmCustomModelPath" },
  { category: "ai", key: "llmExternalUrl" },
  { category: "ai", key: "llmExternalModel" },
  { category: "ai", key: "llmExternalKey" },
  { category: "ai", key: "llmGpuLayers" },
  { category: "ai", key: "llmContext" },
  { category: "ai", key: "llmLanguage" },
  { category: "ai", key: "llmBackend" },
  // 음성 인식(자막) — 태스크 72. AI 섹션의 소제목(새 카테고리 없음).
  { category: "ai", key: "sttModel" },
  { category: "ai", key: "sttLanguage" },
  { category: "ai", key: null, id: "sttRuntimeDownload" },
  // 업데이트 (즉시 액션 — key null)
  { category: "update", key: null, id: "appUpdate" },
  { category: "update", key: null, id: "autoUpdateCheck" },
];

/**
 * 질의가 항목에 매칭되나 — 레이블·키워드 부분일치(대소문자 무시). 지금 UI 언어만이 아니라 **모든 언어**의
 * 문구를 본다(설계 §4.2) — 영어 UI에서도 "프롬프트"로, 한국어 UI에서도 "prompt"로 찾힌다.
 */
export function matchesEntry(e: SettingIndexEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const id = e.key === null ? e.id : e.key;
  return Object.values(settingsText).some(({ search }) => {
    const t = search[id];
    return [t.label, ...t.keywords].some((s) => s.toLowerCase().includes(needle));
  });
}
