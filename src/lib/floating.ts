import { invoke } from "@tauri-apps/api/core";

/**
 * 터미널 패널을 별도 OS 창으로 띄운다. 창 생성은 Rust(open_float_window)가 담당한다 —
 * JS의 new WebviewWindow는 메인 창과 WebView2 환경 인자가 어긋나 웹뷰가 빈 채로 뜨기 때문.
 * 창은 index.html?float=<paneId>&project=<pid>를 로드하고 FloatingTerminal이 살아있는 PTY에
 * term_attach로 재연결한다. 창 라벨 `float-<paneId>` 는 Rust 창 닫힘 이벤트에서 PTY 종료에 쓰인다.
 */
export function openFloatingWindow(paneId: string, _projectId: string) {
  // paneId는 창 라벨(float-<paneId>)로 전달된다 — 프론트가 라벨에서 읽어 PTY에 attach한다.
  // origin은 메인 창이 로드된 곳 — 새 창도 같은 곳을 띄워 dev/prod 모두 동작한다.
  void invoke("open_float_window", {
    paneId,
    origin: window.location.origin,
  }).catch((e) => {
    console.error("플로팅 터미널 창 생성 실패:", e);
  });
}
