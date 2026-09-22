// 공용 lib — 리포트 UI 라벨·LLM·클립보드·터미널·상대 시간 등.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const ko = {
  // 여러 곳의 실패 토스트에 붙는 버튼(클립보드 복사·터미널 붙여넣기).
  toastRetry: "다시 시도",
  agentNotify: {
    projectFallback: "프로젝트",
    doneTitle: (project: string) => `${project} — 작업 완료`,
    projectDoneBody: "작업이 끝났습니다",
    terminalDoneBody: "터미널 작업이 끝났습니다",
  },
  browserDownload: {
    delegated: "다운로드를 외부 브라우저에서 엽니다",
    unsupported: "이 다운로드는 지원되지 않습니다",
  },
  clipboard: {
    heldByOtherApp: "다른 프로그램이 클립보드를 쓰고 있습니다 — 다시 시도하세요",
    unknownError: "알 수 없는 오류",
    execCommandFalse: "execCommand가 false를 반환했습니다",
    notReflected: (readFailed: boolean) =>
      `클립보드에 반영되지 않았습니다(되읽기=${readFailed ? "실패" : "불일치"})`,
    macNonAsciiSkipped: "webview: macOS 비-ASCII는 인코딩이 깨져 건너뜀",
    copyFailed: (reason: string) => `복사에 실패했습니다 — ${reason}`,
    copied: "복사했습니다",
  },
  reportWindowTitle: "작업 리포트",
  relativeTime: {
    justNow: "방금 전",
    secondsAgo: (n: number) => `${n}초 전`,
    minutesAgo: (n: number) => `${n}분 전`,
    hoursAgo: (n: number) => `${n}시간 전`,
  },
  imageCodec: {
    encodeFailed: (format: string) => `${format} 인코딩에 실패했습니다`,
    canvasContextUnavailable: "캔버스 컨텍스트를 얻지 못했습니다",
    decodeFailed: "이미지를 디코드하지 못했습니다",
  },
  llmProgress: {
    loading: (seconds: number) => `모델 로드 중… (${seconds}초)`,
    downloading: (percent: number | null) =>
      `CPU 런타임 받는 중${percent != null ? ` ${percent}%` : "…"}`,
    verifying: "CPU 런타임 검증 중…",
    extracting: "CPU 런타임 압축 해제 중…",
    failed: (message: string | null) => `⚠ ${message ?? "실패"}`,
    runtimeReady: "런타임 준비 완료 — 모델을 올리는 중…",
  },
  llmReady: {
    settingsLoading: "설정을 불러오는 중입니다",
    externalUrlMissing: "설정 › AI › 고급에서 외부 서버 URL을 입력하세요",
    statusLoading: "AI 상태를 확인하는 중입니다",
    runtimeUnsupported:
      "이 플랫폼용 llama.cpp 공식 빌드가 없습니다 — 설정 › AI › 고급에서 외부 서버 URL을 쓰세요",
    runtimeMissing: "설정 › AI에서 런타임을 다운로드하세요",
    customModelInvalid: "설정 › AI › 고급의 GGUF 경로를 확인하세요",
    modelNotChosen: "설정 › AI에서 모델을 고르세요",
    modelMissing: (label: string) => `설정 › AI에서 ${label} 모델을 다운로드하세요`,
  },
  lspRename: {
    noSymbol: "이름을 바꿀 심볼이 없습니다",
    failed: "이름 변경 실패",
    notRenamable: "이름을 바꿀 수 없습니다",
    appliedToOtherFiles: (count: number) =>
      `${count}개 파일에 이름 변경 적용됨 · 현재 파일은 Ctrl+S로 저장`,
  },
  // 화면(리포트 상단 바·기간 버튼)용. 프롬프트의 {기간} 값은 report.ts 가 따로 한국어로 둔다(모델 입력).
  reportPeriod: { day: "일간", week: "주간", month: "월간" },
  reportWeekLabel: (month: number, nth: number) => `${month}월 ${nth}주`,
  reportPromptVarDesc: {
    language: "출력 언어(설정 › AI) — 한국어·영어",
    period: "일간·주간·월간",
    projectPrefix: '여러 프로젝트를 한 카드로 요약할 때만 "[프로젝트명] ", 하나면 빈칸',
  },
  terminal: {
    connectFailed: (err: string) => `[터미널 연결 실패] ${err}`,
    pasteFailed: (reason: string) => `붙여넣기에 실패했습니다 — ${reason}`,
    clipboardEmpty: "클립보드가 비어 있습니다",
  },
  themeLabel: { darcula: "다크 (Darcula)", light: "라이트 (IntelliJ)" },
  translateWaitingForOtherAiJob: "다른 AI 작업이 끝나면 시작합니다…",
};

const EN_MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const libText = defineText(ko, {
  en: {
    toastRetry: "Retry",
    agentNotify: {
      projectFallback: "Project",
      doneTitle: (project) => `${project} — Task complete`,
      projectDoneBody: "Task finished",
      terminalDoneBody: "Terminal task finished",
    },
    browserDownload: {
      delegated: "Opening the download in your external browser",
      unsupported: "This download is not supported",
    },
    clipboard: {
      heldByOtherApp: "Another app is using the clipboard — try again",
      unknownError: "Unknown error",
      execCommandFalse: "execCommand returned false",
      notReflected: (readFailed) =>
        `The clipboard was not updated (read-back ${readFailed ? "failed" : "mismatch"})`,
      macNonAsciiSkipped: "webview: skipped on macOS because non-ASCII text gets garbled",
      copyFailed: (reason) => `Copy failed — ${reason}`,
      copied: "Copied",
    },
    reportWindowTitle: "Work report",
    relativeTime: {
      justNow: "just now",
      secondsAgo: (n) => `${n}s ago`,
      minutesAgo: (n) => `${n}m ago`,
      hoursAgo: (n) => `${n}h ago`,
    },
    imageCodec: {
      encodeFailed: (format) => `Failed to encode ${format}`,
      canvasContextUnavailable: "Couldn't get a canvas context",
      decodeFailed: "Couldn't decode the image",
    },
    llmProgress: {
      loading: (seconds) => `Loading model… (${seconds}s)`,
      downloading: (percent) => `Downloading CPU runtime${percent != null ? ` ${percent}%` : "…"}`,
      verifying: "Verifying CPU runtime…",
      extracting: "Extracting CPU runtime…",
      failed: (message) => `⚠ ${message ?? "Failed"}`,
      runtimeReady: "Runtime ready — loading the model…",
    },
    llmReady: {
      settingsLoading: "Loading settings…",
      externalUrlMissing: "Enter an external server URL in Settings › AI › Advanced",
      statusLoading: "Checking AI status…",
      runtimeUnsupported:
        "No official llama.cpp build for this platform — use an external server URL in Settings › AI › Advanced",
      runtimeMissing: "Download the runtime in Settings › AI",
      customModelInvalid: "Check the GGUF path in Settings › AI › Advanced",
      modelNotChosen: "Choose a model in Settings › AI",
      modelMissing: (label) => `Download the ${label} model in Settings › AI`,
    },
    lspRename: {
      noSymbol: "No symbol to rename",
      failed: "Rename failed",
      notRenamable: "This symbol can't be renamed",
      appliedToOtherFiles: (count) =>
        `Rename applied to ${count} ${plural(count, "file", "files")} · save the current file with Ctrl+S`,
    },
    reportPeriod: { day: "Daily", week: "Weekly", month: "Monthly" },
    reportWeekLabel: (month, nth) => `Week ${nth} of ${EN_MONTH_SHORT[month - 1]}`,
    reportPromptVarDesc: {
      language: "Output language (Settings › AI) — Korean or English",
      period: "Daily, weekly or monthly",
      projectPrefix: 'Only when one card summarizes several projects: "[project name] "; otherwise empty',
    },
    terminal: {
      connectFailed: (err) => `[Terminal connection failed] ${err}`,
      pasteFailed: (reason) => `Paste failed — ${reason}`,
      clipboardEmpty: "The clipboard is empty",
    },
    themeLabel: { darcula: "Dark (Darcula)", light: "Light (IntelliJ)" },
    translateWaitingForOtherAiJob: "Waiting for another AI task to finish…",
  },
});
