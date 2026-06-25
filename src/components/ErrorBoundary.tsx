import { Component, type ErrorInfo, type ReactNode } from "react";

import { logFatal } from "../lib/logging";

interface State {
  error: Error | null;
}

/**
 * 렌더 중 던져진 에러를 잡아 흰 화면 대신 폴백 UI를 보이고 로그 파일에 남긴다.
 * (React 19 — 클래스 컴포넌트만 에러 경계가 된다.)
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logFatal("[react]", error, info.componentStack ?? undefined);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-base p-8 text-center text-fg">
        <div className="text-lg font-semibold">문제가 발생했습니다</div>
        <div className="max-w-lg break-words font-mono text-xs text-fg-dim">
          {error.message}
        </div>
        <div className="text-[11px] text-fg-dim">
          자세한 내용은 앱 로그 폴더(logs/)에 기록됐습니다.
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded border border-edge px-4 py-1.5 text-sm text-fg-muted hover:bg-raised hover:text-fg"
          >
            다시 시도
          </button>
          <button
            onClick={() => location.reload()}
            className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
