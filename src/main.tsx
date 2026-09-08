import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import React from "react";
import ReactDOM from "react-dom/client";

import { AggregateWindow } from "./AggregateWindow";
import App from "./App";
import { CaptureOverlay } from "./CaptureOverlay";
import { DocWindow } from "./DocWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SysMonitorWindow } from "./components/sysmon/SysMonitorWindow";
import { FloatingTerminal } from "./FloatingTerminal";
import { installMacCopyInterceptor } from "./lib/clipboard";
import { attachLogoEvents, attachRepoEvents } from "./lib/events";
import { setupErrorLogging } from "./lib/logging";
import { watchAggregateWindow } from "./lib/aggregate-window";
import { docTarget, openDocWindow, warmFloatingWindowPool } from "./lib/floating";
import { ipc } from "./lib/ipc";
import { keys } from "./queries";
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
import { useUi } from "./stores/ui";
import { planSegments, useVideoSplit } from "./stores/videoSplit";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

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

// E2E·디버그용 — dev 빌드에서만 핵심 스토어를 노출한다(프론트 기능 e2e가 상태를 구동/단언).
// release 빌드에는 포함되지 않는다(import.meta.env.DEV).
if (import.meta.env.DEV) {
  (window as unknown as { __gpv?: unknown }).__gpv = {
    ui: useUi,
    terminals: useTerminals,
    videoSplit: useVideoSplit,
    planSegments,
    promptHistory: usePromptHistory, // 호버 카드 e2e — 기록 생성·컬럼 열기·교체 시뮬레이션
    term: { get: getTerminal }, // 터미널 e2e — xterm 인스턴스·win32Input 플래그 관측
    customThemes: useCustomThemes, // 커스텀 테마 e2e — 정의 upsert/remove
    builtinTokens: BUILTIN_TOKENS, // e2e 19 — styles.css ↔ 정적 사본 짝 검증
    // 프로젝트 색 — e2e 19(32슬롯 대비 전수)·14(슬롯 배정 중복 0). 노출이 없으면 테스트가
    // 팔레트를 자기 사본으로 재게 되고, 사본은 구현이 바뀌어도 조용히 옛 값으로 통과한다.
    // FG·FLOORS도 같은 이유로 낀다 — 재는 토큰 목록과 하한까지 구현 쪽 단일 출처를 쓴다.
    projectColor: { PROJECT_HUES, projectPalette, assignProjectSlots, FG, FLOORS },
    openDocWindow, // 문서 창 e2e 34 — 더블클릭이 부르는 것과 같은 계약을 직접 구동
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

if (label === "aggregate") {
  // 터미널 모아보기 전용 창 — 메인의 살아있는 PTY에 재연결해 보여주는 "터미널 벽".
  const aggQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 셀 헤더의 로고는 메인 창에서 지정한다 — 이 창의 캐시는 그 무효화를 못 듣는다(태스크 54 §1).
  attachLogoEvents(aggQc);
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={aggQc}>
        <ErrorBoundary>
          <AggregateWindow />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
} else if (docId) {
  // 파일 뷰어 창 — 뷰어가 settings·diff 쿼리를 쓰므로 자체 QueryClient로 감싼다.
  const docQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // **파일 읽기를 렌더보다 먼저 건다.** 뷰어 컴포넌트는 lazy라 청크를 받아 오는 동안 아무 일도
  // 안 하는데, 그 시간에 IPC를 태우면 마운트 시점엔 대개 캐시에 이미 있다. 뷰어가 쓰는 것과
  // **같은 키**여야 하므로 queries.keys를 그대로 쓴다(키가 어긋나면 조용히 두 번 읽는다).
  {
    const t = docTarget(docId);
    if (t) {
      const target = { mode: "file", path: t.path } as const;
      void docQc.prefetchQuery({
        queryKey: keys.diff(t.projectId, target),
        queryFn: () => ipc.getDiff(t.projectId, target),
        staleTime: Infinity,
      });
    }
  }
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={docQc}>
        <ErrorBoundary>
          <DocWindow docId={docId} />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
} else if (label === "capture") {
  // 화면 캡쳐 오버레이 — 프리즈 프레임 위에서 영역만 고른다. 쿼리·이벤트 부트스트랩을 태우지
  // 않는다: 이 창은 상시 살아 있으면서 숨었다 나타나므로, 여기서 구독을 열면 캡쳐를 안 쓰는
  // 내내 메인 창과 같은 부하를 두 벌 돌리게 된다.
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <CaptureOverlay />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} else if (label === "sysmon") {
  // 리소스 모니터 팝업 창(태스크 05) — 플로팅 터미널 분기와 대칭, 자체 QueryClient.
  const sysmonQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={sysmonQc}>
        <ErrorBoundary>
          <SysMonitorWindow />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
} else if (floatPaneId || isFloatPool) {
  // 플로팅 창도 QueryClientProvider로 감싼다 — 분할 패널 컴포넌트가 쿼리를 쓰더라도 안전하게.
  // 풀 창(paneId=null)은 FloatingTerminal이 claim 이벤트를 기다렸다가 배정받아 attach한다.
  const floatQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={floatQc}>
        <ErrorBoundary>
          <FloatingTerminal paneId={floatPaneId} />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
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

  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
