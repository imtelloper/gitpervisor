// 작업 리포트 화면.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ko = {
  // 카드와 채팅이 같은 상황에 같은 문구를 쓴다.
  modelLoading: "모델 로드 중…",
  cancelled: "취소됨",
  cancel: "취소",
  prepareInMainSettings: "메인 창의 설정 › AI에서 준비하세요",
  openSettings: "설정 열기",
  heatmap: {
    // 월요일 시작 — 월·수·금만 적는다(Heatmap 의 라벨 배열).
    weekdayMon: "월",
    weekdayWed: "수",
    weekdayFri: "금",
    /** month 는 1~12. */
    cellTitle: (month: number, day: number, commits: number, prompts: number) =>
      `${month}월 ${day}일 · 커밋 ${commits} · 프롬프트 ${prompts}`,
    monthLabel: (month: number) => `${month}월`,
    legendLess: "적음",
    legendMore: "많음",
    legendHint: "칸 = 하루(커밋 + 프롬프트), 클릭하면 그 날 요약으로",
  },
  card: {
    combinedTitle: (n: number) => `종합 · ${n}개 프로젝트`,
    counts: (commits: number, prompts: number) => `커밋 ${commits} · 프롬프트 ${prompts}`,
    inputChanged: "입력이 바뀜",
    askTitle: "이 리포트를 두고 AI와 대화합니다",
    ask: "AI에게 묻기",
    regenerate: "다시 생성",
    generate: "요약 생성",
    generating: "요약 생성 중…",
    noActivity: "활동 없음",
  },
  chat: {
    busyNote: "다른 생성이 진행 중입니다 — 끝나면 다시 보내세요",
    headerFallback: "리포트 채팅",
    newChatTitle: "새 대화 — 지금까지의 대화를 지웁니다(컨텍스트는 그대로)",
    close: "닫기",
    emptyHint: "카드의 [AI에게 묻기]를 누르면 그 리포트를 두고 대화합니다 — 그냥 물어봐도 됩니다.",
    saveAsSummaryTitle: "이 답변을 요약으로 저장합니다 — 카드 본문이 바뀝니다",
    notSummaryTitle: "요약 형식이 아닙니다 — '요약을 다시 써 줘'라고 요청하세요",
    saveAsSummary: "요약으로 저장",
    writing: "답변을 쓰는 중…",
    inputPlaceholder: "더 짧게 써 줘 · 존댓말로 · 영어로 (Enter 전송, Shift+Enter 줄바꿈)",
  },
  promptEditor: {
    title: "요약 생성 프롬프트",
    custom: "사용자 지정",
    default: "기본값",
    resetTitle: "앱 기본 프롬프트로 되돌립니다(저장해야 적용됩니다)",
    reset: "기본값으로",
    saving: "저장 중…",
    save: "저장",
    closeTitle: "닫기(저장하지 않은 편집은 버립니다)",
    placeholdersLabel: "자리표시자:",
    footnote:
      "커밋·프롬프트 근거 목록은 이 뒤에 자동으로 붙습니다. 프롬프트가 길수록 근거로 싣는 분량이 줄어듭니다. 이미 저장된 요약은 다시 생성해야 바뀐 프롬프트가 반영됩니다.",
  },
  view: {
    scopeTitle: "요약할 프로젝트를 고릅니다 — 2개 이상이면 맨 위에 종합 카드가 붙습니다",
    scopeAll: "전체",
    scopeCount: (n: number) => `프로젝트 ${n}개`,
    mineOnly: "내 커밋만",
    prev: "이전",
    next: "다음",
    promptToggleTitle: "요약 생성 프롬프트를 고칩니다",
    promptToggle: (custom: boolean) => `프롬프트${custom ? " (사용자 지정)" : ""}`,
    cancelBatch: (current: number, total: number) => `취소 (${current}/${total})`,
    generateAll: "모두 생성",
    chatToggleTitle: "AI 채팅 — 요약을 두고 대화하거나 그냥 물어봅니다",
    chatToggle: "AI 채팅",
    noProjects: "등록된 프로젝트가 없습니다",
    noneSelected: "선택한 프로젝트가 없습니다",
  },
};

export const reportText = defineText(ko, {
  en: {
    modelLoading: "Loading model…",
    cancelled: "Cancelled",
    cancel: "Cancel",
    prepareInMainSettings: "Set it up in Settings › AI in the main window",
    openSettings: "Open settings",
    heatmap: {
      weekdayMon: "Mon",
      weekdayWed: "Wed",
      weekdayFri: "Fri",
      cellTitle: (month, day, commits, prompts) =>
        `${EN_MONTHS[month - 1]} ${day} · Commits ${commits} · Prompts ${prompts}`,
      monthLabel: (month) => EN_MONTHS[month - 1],
      legendLess: "Less",
      legendMore: "More",
      legendHint: "Cell = one day (commits + prompts). Click to see that day's summary",
    },
    card: {
      combinedTitle: (n) => `Combined · ${n} ${plural(n, "project", "projects")}`,
      counts: (commits, prompts) => `Commits ${commits} · Prompts ${prompts}`,
      inputChanged: "Input changed",
      askTitle: "Chat with AI about this report",
      ask: "Ask AI",
      regenerate: "Regenerate",
      generate: "Generate summary",
      generating: "Generating summary…",
      noActivity: "No activity",
    },
    chat: {
      busyNote: "Another generation is in progress — send again when it finishes",
      headerFallback: "Report chat",
      newChatTitle: "New chat — clears the conversation so far (context is kept)",
      close: "Close",
      emptyHint: "Press [Ask AI] on a card to chat about that report — or just ask.",
      saveAsSummaryTitle: "Save this reply as the summary — replaces the card's text",
      notSummaryTitle: "Not in summary format — ask it to 'rewrite the summary'",
      saveAsSummary: "Save as summary",
      writing: "Writing a reply…",
      inputPlaceholder: "Make it shorter · More formal · In English (Enter to send, Shift+Enter for new line)",
    },
    promptEditor: {
      title: "Summary prompt",
      custom: "Custom",
      default: "Default",
      resetTitle: "Revert to the app's default prompt (save to apply)",
      reset: "Reset to default",
      saving: "Saving…",
      save: "Save",
      closeTitle: "Close (unsaved edits are discarded)",
      placeholdersLabel: "Placeholders:",
      footnote:
        "The commit and prompt evidence list is appended after this automatically. The longer the prompt, the less evidence fits. Saved summaries reflect a changed prompt only after you regenerate them.",
    },
    view: {
      scopeTitle: "Choose projects to summarize — with 2 or more, a combined card is added at the top",
      scopeAll: "All",
      scopeCount: (n) => `${n} ${plural(n, "project", "projects")}`,
      mineOnly: "My commits only",
      prev: "Previous",
      next: "Next",
      promptToggleTitle: "Edit the summary prompt",
      promptToggle: (custom) => `Prompt${custom ? " (custom)" : ""}`,
      cancelBatch: (current, total) => `Cancel (${current}/${total})`,
      generateAll: "Generate all",
      chatToggleTitle: "AI chat — discuss a summary or just ask",
      chatToggle: "AI chat",
      noProjects: "No projects registered",
      noneSelected: "No projects selected",
    },
  },
});
