import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import React from "react";
import ReactDOM from "react-dom/client";

import { AggregateWindow } from "./AggregateWindow";
import App from "./App";
import { CaptureOverlay } from "./CaptureOverlay";
import { DocWindow } from "./DocWindow";
import { endedIndex, stepIndex } from "./components/audio/playlist";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SysMonitorWindow } from "./components/sysmon/SysMonitorWindow";
import { FloatingTerminal } from "./FloatingTerminal";
import { initUiLanguage } from "./i18n/ui-language";
import { installMacCopyInterceptor } from "./lib/clipboard";
import { attachLogoEvents, attachRepoEvents } from "./lib/events";
import { setupErrorLogging } from "./lib/logging";
import { watchAggregateWindow } from "./lib/aggregate-window";
import { armEngagementTracking } from "./lib/engagement";
import {
  docTarget,
  floatPoolReady,
  markDocWindow,
  openDocWindow,
  openLogWindow,
  openReportWindow,
  warmFloatingWindowPool,
} from "./lib/floating";
import { ipc } from "./lib/ipc";
import { opensInOwnViewer } from "./lib/language-map";
import { buildMessages, chatMessages, scopeKey } from "./lib/report";
import { keys, LOG_PAGE_SIZE } from "./queries";
import {
  getTerminal,
  installTerminalCopyFallback,
  reattachAllTerminals,
} from "./lib/terminal";
import {
  assignProjectSlots,
  FG,
  FLOORS,
  projectPalette,
  PROJECT_HUES,
} from "./lib/project-color";
import { BUILTIN_TOKENS, installCustomThemeStyles } from "./lib/theme-apply";
import { initPreviewRemint } from "./stores/browser";
import { useCustomThemes } from "./stores/customThemes";
import { usePromptHistory } from "./stores/promptHistory";
import { useTerminals } from "./stores/terminals";
import { selectBlockingOverlay, useUi } from "./stores/ui";
import { planSegments, useVideoSplit } from "./stores/videoSplit";
import {
  captionCueSpans,
  captionCueText,
  captionCutAllowed,
  captionFillerIds,
  captionGapKeptMs,
  captionIndexAt,
  captionMatchCutIds,
  captionPlaySkipTo,
  captionRemovedRanges,
  captionSelectionTimeRange,
  captionSilenceCandidates,
  captionSourceCues,
  cutCaptionTokens,
  findCaptionMatches,
  mergeCaptionCues,
  replaceCaptionMatches,
  setCaptionCueCaption,
  setCaptionSilence,
  setCaptionWordText,
  splitCaptionCue,
  toggleCaptionCut,
} from "./lib/captionEdit";
import { captionOverlayLayout, setCaptionStylePreset } from "./lib/captionStyle";
import {
  batchCaptionItems,
  captionTranslateBudget,
  captionTranslateItems,
  captionTranslateMessages,
  captionTranslatePending,
  captionTranslationCounts,
  parseCaptionTranslation,
  setCaptionTranslation,
  setCaptionTranslations,
  translateCaptionItems,
} from "./lib/captionTranslate";
import { sttAudioTrackLabel } from "./lib/stt";
import { useCaptionDoc } from "./stores/captionDoc";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
// 첫 화면 전에 이 창의 UI 언어를 정한다 — 안 그러면 영어 사용자가 창을 열 때마다 한국어 화면을 한 프레임
// 본다. 모든 창 갈래가 이 한 곳을 지난다(initUiLanguage 는 던지지 않고 1.5초 넘게 붙잡지 않는다).
const uiLanguageReady = initUiLanguage();
function renderAfterUiLanguage(node: React.ReactNode): void {
  void uiLanguageReady.then(() => root.render(node));
}

// 사용자 정의 테마(태스크 29)의 CSS 블록을 **선적용보다 먼저** 심는다 — 캐시된 id가
// custom-…이면 블록이 있어야 첫 페인트부터 제 색이 나온다. 모든 창 공통 경로.
installCustomThemeStyles();

// 시작 플래시 제거 — settings 로드 전 첫 페인트가 항상 darcula(기본값)였던 문제.
// App effect가 저장 시점에 캐시해 둔 테마 id를 렌더 "전"에 선적용한다(이후 settings가
// 로드되면 각 창의 테마 effect가 확정값으로 덮는다). 미지 id는 CSS 매칭 실패로 기본 유지.
try {
  const cachedTheme = localStorage.getItem("gp:theme");
  if (cachedTheme) document.documentElement.dataset.theme = cachedTheme;
} catch {
  /* localStorage 불가 환경 무시 */
}

// 미처리 에러/프라미스 거부를 Rust 로그 파일로 보낸다 — 메인·플로팅 창 모두 1회.
setupErrorLogging();

// macOS: Cmd+C/메뉴 복사의 WebKit 기본 경로가 한글을 깨뜨린다 — 전역에서 네이티브로 대체.
installMacCopyInterceptor();
// 터미널 밖 포커스에서 Ctrl+C 눌러도 선택된 터미널 내용이 복사되게 하는 전역 폴백.
installTerminalCopyFallback();

// 앱 밖에서 끌어온 파일(탐색기, 또는 파일 트리에서 OS 드래그로 넘겼다가 도로 창에 놓은 것)을 아무도 안
// 받으면 막는다. 창들이 OS 드롭 핸들러를 끄고 있어 wry 가 AllowExternalDrop 을 기본값(켜짐)으로 두므로
// (webview2/mod.rs), 그 드롭은 브라우저 기본 동작 — 그 파일로 페이지 이동 — 에 맡겨진다. 파일을 받는
// 곳은 스스로 preventDefault 하므로 버블 끝에서 남은 것만 거른다. dropEffect "none" 이 금지 커서를 띄운다.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    if (type === "dragover") e.dataTransfer.dropEffect = "none";
  });
}

// E2E·디버그용 — dev 빌드에서만 핵심 스토어를 노출한다(프론트 기능 e2e가 상태를 구동/단언).
// release 빌드에는 포함되지 않는다(import.meta.env.DEV).
if (import.meta.env.DEV) {
  (window as unknown as { __gpv?: unknown }).__gpv = {
    ui: useUi,
    terminals: useTerminals,
    videoSplit: useVideoSplit,
    planSegments,
    // 대본 편집(태스크 72) — 나누기·합치기·찾아 바꾸기 순수 함수와 창별 자막 문서 스토어. TS 단위 테스트 러너가 없어
    // e2e가 이것으로 불변식을 잰다(planSegments와 같은 이유).
    caption: {
      captionCueSpans,
      captionCueText,
      captionIndexAt,
      captionSelectionTimeRange,
      captionSourceCues,
      findCaptionMatches,
      mergeCaptionCues,
      replaceCaptionMatches,
      setCaptionCueCaption,
      setCaptionWordText,
      splitCaptionCue,
      // P2 — 컷·일괄 컷·무음 줄이기 미리보기·편집 반영 재생 위치.
      captionCutAllowed,
      toggleCaptionCut,
      cutCaptionTokens,
      captionMatchCutIds,
      captionFillerIds,
      captionGapKeptMs,
      captionSilenceCandidates,
      setCaptionSilence,
      captionPlaySkipTo,
      captionRemovedRanges,
      // P3 — 자막 스타일(오버레이 배치·문서 기억)·오디오 트랙 이름.
      captionOverlayLayout,
      setCaptionStylePreset,
      sttAudioTrackLabel,
      // P4 — 번역 배치·프롬프트·응답 검증·쪼개기(가짜 chat을 넣어 결정적으로)·문서 쓰기.
      captionTranslateItems,
      captionTranslatePending,
      captionTranslationCounts,
      captionTranslateBudget,
      batchCaptionItems,
      captionTranslateMessages,
      parseCaptionTranslation,
      translateCaptionItems,
      setCaptionTranslations,
      setCaptionTranslation,
    },
    captionDoc: useCaptionDoc,
    // 오디오 플레이리스트 다음 곡 계산(순수) — e2e 69가 반복·셔플·감아 돌기 표를 잰다(planSegments와 같은 이유).
    playlist: { stepIndex, endedIndex },
    promptHistory: usePromptHistory, // 호버 카드 e2e — 기록 생성·컬럼 열기·교체 시뮬레이션
    term: { get: getTerminal }, // 터미널 e2e — xterm 인스턴스·win32Input 플래그 관측
    customThemes: useCustomThemes, // 커스텀 테마 e2e — 정의 upsert/remove
    builtinTokens: BUILTIN_TOKENS, // e2e 19 — styles.css ↔ 정적 사본 짝 검증
    // 차단 모달 점유 판정 — e2e 45가 "새 전체화면 모달이 목록에 들어갔나"를 잰다. 이 목록에서
    // 빠진 모달은 네이티브 자식 webview 뒤에 가려 보이지 않는다(ui.ts의 계약 주석).
    selectBlockingOverlay,
    // 프로젝트 색 — e2e 19(32슬롯 대비 전수)·14(슬롯 배정 중복 0). 노출이 없으면 테스트가
    // 팔레트를 자기 사본으로 재게 되고, 사본은 구현이 바뀌어도 조용히 옛 값으로 통과한다.
    // FG·FLOORS도 같은 이유로 낀다 — 재는 토큰 목록과 하한까지 구현 쪽 단일 출처를 쓴다.
    projectColor: { PROJECT_HUES, projectPalette, assignProjectSlots, FG, FLOORS },
    openDocWindow, // 문서 창 e2e 34 — 더블클릭이 부르는 것과 같은 계약을 직접 구동
    openReportWindow, // 리포트 창 e2e 48 ⑩ — 우클릭 메뉴가 부르는 것과 같은 계약
    openLogWindow, // git 로그 창 — 사이드바 우클릭 메뉴가 부르는 것과 같은 계약
    // 리포트 프롬프트 조립 e2e 48 ⑧ — LLM 없이 "무엇을 보내는가"만 잰다(순수 함수).
    report: { buildMessages, chatMessages, scopeKey },
    // PDF 주석 스파이크 하니스(S1) — e2e 62. 동적 import 라 메인 청크에 안 들어간다. 첫 open 이
    // 모듈을 불러 이 자리를 전체 API(close·setZoom·switchTo·setNodes·stats…)로 바꾼다.
    pdfSpike: {
      open: (o?: import("./components/pdf/PdfAnnotateSpike").SpikeOpenOpts) =>
        import("./components/pdf/PdfAnnotateSpike").then((m) => m.pdfSpike.open(o)),
    },
  };
}

// 플로팅 창은 라벨이 `float-<paneId>` 다 — 이 경우 단일 터미널만 렌더하고 메인 부트스트랩은 건너뛴다.
// (WebviewUrl::App이 쿼리스트링을 못 실어 라벨로 paneId를 전달한다.)
const label = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "";
  }
})();
// 프리워밍 풀 창(float-pool-*)은 paneId가 아직 없다 — claim 이벤트로 나중에 배정받는다.
// `float-`로도 시작하므로 **먼저** 판별해야 한다.
const isFloatPool = label.startsWith("float-pool-");
const floatPaneId =
  !isFloatPool && label.startsWith("float-")
    ? label.slice("float-".length)
    : null;
// 파일 뷰어 창 — 라벨이 곧 대상 id다(경로는 localStorage 경유, lib/floating.ts 주석).
const docId = label.startsWith("doc-") ? label.slice("doc-".length) : null;

// 자동재생 관문 무장(lib/engagement.ts). 메인 창만 "복원된 탭"이라는 사정이 있어 첫 조작을
// 기다리고, 보조 창은 그 창이 열린 것 자체가 사용자의 행동이라 처음부터 허용한다.
// 여기서 달아야 파일을 여는 그 클릭을 놓치지 않는다 — VideoPlayer는 지연 로드다.
armEngagementTracking(label !== "main" && label !== "");

/**
 * 문서 창 한 채의 렌더 트리 — 라벨 `doc-<id>` 창과 **프리워밍 풀에서 나온 창**(라벨
 * `float-pool-N`, 태스크 73)이 같은 구성을 쓰게 한 곳에 모은다. 갈라 두면 풀 경로만 캐시·
 * 프리페치가 빠져 "빠르지만 느린 창"이 된다.
 */
function docWindowTree(id: string) {
  // 뷰어가 settings·diff 쿼리를 쓰므로 자체 QueryClient로 감싼다.
  const docQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // e2e 61 — 문서 창 diff 0 단언용. 이름을 queryClient로 두면 34가 메인 창으로 오판한다.
  if (import.meta.env.DEV) {
    const g = (window as unknown as { __gpv?: Record<string, unknown> }).__gpv;
    if (g) g.docQueryClient = docQc;
  }
  // **읽기를 렌더보다 먼저 건다.** 뷰어 컴포넌트는 lazy라 청크를 받아 오는 동안 아무 일도
  // 안 하는데, 그 시간에 IPC를 태우면 마운트 시점엔 대개 캐시에 이미 있다. 뷰어가 쓰는 것과
  // **같은 키·같은 인자**여야 하므로 queries의 keys·LOG_PAGE_SIZE를 그대로 쓴다(어긋나면
  // 조용히 두 번 읽는다).
  const t = docTarget(id);
  const logProjectId = t?.log;
  if (logProjectId) {
    // git 로그 창 — 첫 페이지 커밋 목록. `useLog`(useInfiniteQuery, CommitList)와 같은 키·
    // 같은 limit·skip 이어야 캐시가 그대로 쓰인다. 브랜치는 프리페치하지 않는다: 이 창은
    // `BranchesPane`을 그리지 않아(LogWindow.tsx — Git 모달의 LogPanel 전용) 쓰이지 않는다.
    void docQc.prefetchInfiniteQuery({
      queryKey: keys.log(logProjectId),
      queryFn: () => ipc.getLog(logProjectId, { limit: LOG_PAGE_SIZE, skip: 0 }),
      initialPageParam: 0,
    });
  } else if (t && !t.folder && !t.report && !opensInOwnViewer(t.path)) {
    // 폴더 창(태스크 66)·리포트 창(67)은 프로젝트 상대경로 diff 를 읽지 않는다 — projectId 가
    // 빈 문자열이라 여기서 걸러 두지 않으면 뜰 때마다 실패할 게 뻔한 IPC 를 한 번씩 태운다.
    // 자기 뷰어로 여는 파일(PDF·이미지 등)은 diff를 쓰지 않는다 — git spawn 0회.
    const target = { mode: "file", path: t.path } as const;
    void docQc.prefetchQuery({
      queryKey: keys.diff(t.projectId, target),
      queryFn: () => ipc.getDiff(t.projectId, target),
      staleTime: Infinity,
    });
  }
  return (
    <QueryClientProvider client={docQc}>
      <ErrorBoundary>
        <DocWindow docId={id} />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

/** 플로팅 터미널 창 한 채의 렌더 트리 — 라벨 `float-<paneId>` 창과 풀 claim 이 같이 쓴다. */
function floatWindowTree(paneId: string) {
  // 플로팅 창도 QueryClientProvider로 감싼다 — 분할 패널 컴포넌트가 쿼리를 쓰더라도 안전하게.
  const floatQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={floatQc}>
      <ErrorBoundary>
        <FloatingTerminal paneId={paneId} />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

if (label === "aggregate") {
  // 터미널 모아보기 전용 창 — 메인의 살아있는 PTY에 재연결해 보여주는 "터미널 벽".
  const aggQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 셀 헤더의 로고는 메인 창에서 지정한다 — 이 창의 캐시는 그 무효화를 못 듣는다(태스크 54 §1).
  attachLogoEvents(aggQc);
  renderAfterUiLanguage(
    <React.StrictMode>
      <QueryClientProvider client={aggQc}>
        <ErrorBoundary>
          <AggregateWindow />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
} else if (docId) {
  renderAfterUiLanguage(<React.StrictMode>{docWindowTree(docId)}</React.StrictMode>);
} else if (label === "capture") {
  // 화면 캡쳐 오버레이 — 프리즈 프레임 위에서 영역만 고른다. 쿼리·이벤트 부트스트랩을 태우지
  // 않는다: 이 창은 상시 살아 있으면서 숨었다 나타나므로, 여기서 구독을 열면 캡쳐를 안 쓰는
  // 내내 메인 창과 같은 부하를 두 벌 돌리게 된다.
  renderAfterUiLanguage(
    <React.StrictMode>
      <ErrorBoundary>
        <CaptureOverlay />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} else if (label === "sysmon") {
  // 리소스 모니터 팝업 창(태스크 05) — 플로팅 터미널 분기와 대칭, 자체 QueryClient.
  const sysmonQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderAfterUiLanguage(
    <React.StrictMode>
      <QueryClientProvider client={sysmonQc}>
        <ErrorBoundary>
          <SysMonitorWindow />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
} else if (floatPaneId) {
  renderAfterUiLanguage(<React.StrictMode>{floatWindowTree(floatPaneId)}</React.StrictMode>);
} else if (isFloatPool) {
  // 프리워밍 풀 창 — **무엇이 될지 모른 채** 부트를 끝내 두고 claim 을 기다린다(터미널 분리 창
  // 또는 문서 창, lib.rs FloatPool). 리스너를 **둘 다 무장한 뒤** ready 를 신고해야 이벤트가
  // 유실되지 않는다(핸드셰이크 — 신고가 먼저면 Rust 가 이미 emit 했을 수 있다).
  //
  // 여기서 하는 이유(FloatingTerminal 안이 아니라): 배정 결과에 따라 QueryClient 구성과
  // 프리페치가 갈리므로 창 갈래를 고르는 이 파일이 맡는다.
  renderAfterUiLanguage(<div className="h-screen w-screen bg-base" />);
  // 대기 중에 터미널 엔진 청크(xterm)를 선로딩 — claim 후 첫 createTerminal 이 dynamic import 를
  // 기다리지 않는다. **문서 창 쪽은 선로딩하지 않는다**: 둘 다 당기면 숨김 창 하나가 xterm +
  // Monaco(~3MB)를 통째로 물고 있게 되는데(풀 창 1개가 이미 렌더러 273MB다), 정작 이 태스크가
  // 겨냥한 git log 창은 Monaco 를 쓰지 않는다 — 커밋 목록은 순수 DOM 이고 Monaco 는 파일을
  // 고른 뒤에야 필요하다. 파일 뷰어로 배정되면 그때 lazy 청크를 받는다(기존 동작과 같다).
  void import("./lib/terminal-engine");
  let claimed = false;
  const claim = (tree: React.ReactNode) => {
    if (claimed) return; // 브로드캐스트가 두 번 와도 QueryClient·프리페치를 두 벌 만들지 않는다
    claimed = true;
    renderAfterUiLanguage(<React.StrictMode>{tree}</React.StrictMode>);
  };
  void Promise.all([
    listen<{ label: string; paneId: string }>("float://claim", (e) => {
      if (e.payload.label === label) claim(floatWindowTree(e.payload.paneId));
    }),
    listen<{ label: string; docId: string }>("doc://claim", (e) => {
      if (e.payload.label !== label) return;
      // 라벨이 `doc-`로 시작하지 않으므로 문서 창임을 명시적으로 알린다(lib/floating.ts).
      markDocWindow();
      claim(docWindowTree(e.payload.docId));
    }),
  ]).then(() => floatPoolReady());
} else {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // git 오류는 재시도해도 같다 — 즉시 표면화
        refetchOnWindowFocus: true, // 앱 포커스 복귀 시 일괄 갱신 (설계 §9)
        // 전송이 Tauri IPC라 네트워크 연결과 무관하다. 기본 'online'이면 OS가 오프라인을
        // 보고하는 순간 첫 fetch가 'paused'로 멈춰 — 로딩도 오류도 아닌 채 — 파일트리가
        // 비어 있지 않은 폴더를 "비어 있음"으로 그리는 오표시가 난다(v5 networkMode 실측).
        networkMode: "always",
      },
    },
  });

  // watcher·작업 이벤트 구독 (모듈 스코프 — StrictMode 이중 마운트와 무관하게 1회)
  attachRepoEvents(queryClient);

  // 재시작으로 죽은 프리뷰(로컬 HTML) 탭의 루프백 URL을 재발급해 되살린다. 메인 창에서만
  // 실행한다 — 보조 창이 공유 localStorage(gp:browser)를 스테일 스냅샷으로 덮지 않게.
  initPreviewRemint();

  // 모아보기 별도 창의 열림/닫힘 추적 — 그 창이 PTY 출력을 가져가므로(소비자 1개) 열려 있는
  // 동안 메인은 터미널 패널을 접고, 닫히면 원래 채널로 다시 붙여 이어받는다.
  watchAggregateWindow((open) => {
    const ui = useUi.getState();
    if (ui.aggregateWindowOpen === open) return;
    ui.setAggregateWindowOpen(open);
    if (open) {
      // 메인 안의 모아보기는 닫는다 — 같은 터미널을 두 곳에서 그리면 attach를 서로 뺏어
      // 한쪽이 멈춘 화면이 된다. 벽은 이제 저 창이 담당한다.
      ui.setAggregateOpen(false);
    } else {
      reattachAllTerminals();
    }
  });

  // E2E용 — dev에서 queryClient도 노출한다(테스트가 프로젝트 목록을 갱신해 픽스처를 인지).
  if (import.meta.env.DEV) {
    const g = (window as unknown as { __gpv?: Record<string, unknown> }).__gpv;
    if (g) g.queryClient = queryClient;
  }

  // Monaco(diff 뷰어) 청크를 유휴 시간에 선로딩 — 첫 파일 클릭의 로드 비용 제거
  const preloadDiffViewer = () => void import("./components/diff/DiffViewer");
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preloadDiffViewer, { timeout: 3000 });
  } else {
    setTimeout(preloadDiffViewer, 1500);
  }

  // 플로팅 터미널 풀 프리워밍 — "새 창으로 분리"가 창 생성·번들 로드를 기다리지 않게
  // 숨김 창 1개를 미리 만들어 둔다(claim 시 즉시 표시, 사용 후 자동 보충 — lib.rs FloatPool).
  // 메인 부트와 경합하지 않게 넉넉히 뒤로 미룬다.
  setTimeout(() => warmFloatingWindowPool(), 3000);

  renderAfterUiLanguage(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
