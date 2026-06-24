import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { FloatingTerminal } from "./FloatingTerminal";
import { attachRepoEvents } from "./lib/events";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

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

if (floatPaneId) {
  root.render(
    <React.StrictMode>
      <FloatingTerminal paneId={floatPaneId} />
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
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
