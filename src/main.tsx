import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SysMonitorWindow } from "./components/sysmon/SysMonitorWindow";
import { FloatingTerminal } from "./FloatingTerminal";
import { attachRepoEvents } from "./lib/events";
import { setupErrorLogging } from "./lib/logging";
import { useTerminals } from "./stores/terminals";
import { useUi } from "./stores/ui";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// 미처리 에러/프라미스 거부를 Rust 로그 파일로 보낸다 — 메인·플로팅 창 모두 1회.
setupErrorLogging();

// E2E·디버그용 — dev 빌드에서만 핵심 스토어를 노출한다(프론트 기능 e2e가 상태를 구동/단언).
// release 빌드에는 포함되지 않는다(import.meta.env.DEV).
if (import.meta.env.DEV) {
  (window as unknown as { __gpv?: unknown }).__gpv = {
    ui: useUi,
    terminals: useTerminals,
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
const floatPaneId = label.startsWith("float-")
  ? label.slice("float-".length)
  : null;

if (label === "sysmon") {
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
} else if (floatPaneId) {
  // 플로팅 창도 QueryClientProvider로 감싼다 — 분할 패널 컴포넌트가 쿼리를 쓰더라도 안전하게.
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
      },
    },
  });

  // watcher·작업 이벤트 구독 (모듈 스코프 — StrictMode 이중 마운트와 무관하게 1회)
  attachRepoEvents(queryClient);

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
