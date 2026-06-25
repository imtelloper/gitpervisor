import { attachConsole, error as logError } from "@tauri-apps/plugin-log";

let installed = false;

/**
 * 프론트의 미처리 에러/프라미스 거부를 Rust 로그 파일(앱 로그 폴더)로 보낸다. 메인·플로팅 창
 * 모두에서 앱 부트스트랩 시 1회 호출한다. attachConsole로 Rust 로그를 웹뷰 콘솔에도 미러한다.
 */
export function setupErrorLogging() {
  if (installed) return;
  installed = true;
  void attachConsole().catch(() => {});

  window.addEventListener("error", (e) => {
    const stack = (e.error as { stack?: string } | undefined)?.stack ?? "";
    void logError(
      `[uncaught] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${stack}`,
    ).catch(() => {});
  });

  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    void logError(
      `[unhandledrejection] ${r?.message ?? String(e.reason)}\n${r?.stack ?? ""}`,
    ).catch(() => {});
  });
}

/** ErrorBoundary 등에서 치명 에러를 직접 로그 파일에 남길 때. */
export function logFatal(prefix: string, err: unknown, extra?: string) {
  const e = err as { message?: string; stack?: string } | undefined;
  void logError(
    `${prefix} ${e?.message ?? String(err)}\n${e?.stack ?? ""}${
      extra ? "\n" + extra : ""
    }`,
  ).catch(() => {});
}
