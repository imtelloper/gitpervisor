// 공용 lib — 리포트 UI 라벨·LLM·클립보드·터미널·상대 시간 등.

import type { SyncOp } from "../stores/ops";
import { defineText } from "./define-text";
import { fmtInt, plural } from "./format-locale";

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
  // lib/events.ts — 백엔드 이벤트(op-finished·내보내기·전사 종결)로 뜨는 토스트.
  gitOpLabel: { push: "푸시", pull: "풀", fetch: "페치" },
  gitOpDone: (label: string) => `${label} 완료`,
  gitOpFailed: (label: string) => `${label} 실패`,
  videoExport: {
    cancelled: "내보내기를 취소했습니다",
    done: (name: string) => `내보내기 완료 — ${name}`,
    failed: "내보내기 실패",
  },
  sttJob: {
    cancelled: "자막 만들기를 취소했습니다",
    done: (name: string) => `자막을 만들었습니다 — ${name}`,
    failed: "자막 만들기 실패",
  },
  // queries/index.ts — mutation 결과 토스트.
  mutationToast: {
    dbConnectionSaveFailed: (err: string) => `연결 저장 실패: ${err}`,
    dbConnectionDeleteFailed: (err: string) => `연결 삭제 실패: ${err}`,
    targetCleaned: (freed: string) => `target 청소 완료 — ${freed} 회수`,
    quarantineCleared: (count: number) => `격리 해제 완료 (${fmtInt(count)}개)`,
    settingsSaved: "설정을 저장했습니다",
    projectPathChanged: (path: string) => `경로 변경됨 — ${path}`,
    folderCreated: "폴더를 만들었습니다",
    fileCreated: "파일을 만들었습니다",
    pathDeleted: "삭제했습니다",
    pathRenamed: "이름을 바꿨습니다",
    committed: "커밋 완료",
    // 한국어는 원래부터 영문 키 그대로다("push 완료") — e2e 40 c-8b 가 /push/ 로 이 토스트를 찾는다.
    syncOpDone: (op: SyncOp) => `${op} 완료`,
    logoSet: "로고를 지정했습니다",
    logoCleared: "로고를 해제했습니다",
  },
  // lib/ipc.ts. 영어에도 "timed out"을 남긴다 — 타임아웃을 "시간 초과"·"timed out" 문구로 가려내는 관례
  // (queries keepLastGoodStatuses)와 맞춘다. 한국어 "IPC 응답 시간 초과"는 e2e 48 이 접두어로 본다.
  ipcTimeout: (cmd: string) => `IPC 응답 시간 초과: ${cmd}`,
  ipcMutatingTimeout: (cmd: string) =>
    `${cmd} 응답을 받지 못했습니다 — 실제 결과는 새로고침된 상태로 확인하세요`,
};

const EN_MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_GIT_OP = { push: "Push", pull: "Pull", fetch: "Fetch" };

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
    gitOpLabel: EN_GIT_OP,
    gitOpDone: (label) => `${label} complete`,
    gitOpFailed: (label) => `${label} failed`,
    videoExport: {
      cancelled: "Export canceled",
      done: (name) => `Export complete — ${name}`,
      failed: "Export failed",
    },
    sttJob: {
      cancelled: "Caption generation canceled",
      done: (name) => `Captions created — ${name}`,
      failed: "Caption generation failed",
    },
    mutationToast: {
      dbConnectionSaveFailed: (err) => `Couldn't save the connection: ${err}`,
      dbConnectionDeleteFailed: (err) => `Couldn't delete the connection: ${err}`,
      targetCleaned: (freed) => `Cleaned target — freed ${freed}`,
      quarantineCleared: (count) => `Quarantine cleared (${fmtInt(count)})`,
      settingsSaved: "Settings saved",
      projectPathChanged: (path) => `Path changed — ${path}`,
      folderCreated: "Folder created",
      fileCreated: "File created",
      pathDeleted: "Deleted",
      pathRenamed: "Renamed",
      committed: "Committed",
      syncOpDone: (op) => `${EN_GIT_OP[op]} complete`,
      logoSet: "Logo set",
      logoCleared: "Logo cleared",
    },
    ipcTimeout: (cmd) => `IPC response timed out: ${cmd}`,
    ipcMutatingTimeout: (cmd) =>
      `${cmd} timed out with no response — check the refreshed state for the actual result`,
  },
});
