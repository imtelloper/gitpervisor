import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { attachRepoEvents } from "./lib/events";
import "./styles.css";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
