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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
