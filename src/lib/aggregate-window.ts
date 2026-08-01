import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

/**
 * 터미널 모아보기 별도 창(label="aggregate") — 열기와 "지금 떠 있는가" 신호.
 *
 * ## 왜 소유권 이전인가
 * PTY 세션의 출력 소비자는 하나뿐이다(`term_attach`가 sink를 **교체**한다 — commands/terminal.rs).
 * 따라서 모아보기 창이 터미널에 붙으면 메인 창의 같은 터미널은 출력이 끊긴다. 두 창에서
 * 동시에 보려면 백엔드를 다중 sink로 바꿔야 하는데, 그러면 두 창의 크기가 달라 PTY cols/rows가
 * 요동친다(tmux의 그 문제). 그래서 **모아보기 창이 터미널을 가져가고, 메인은 "다른 창에서 표시
 * 중"으로 접는다** — 창을 닫으면 메인이 다시 이어받는다.
 *
 * ## 열림 상태를 어떻게 아는가
 * 창이 켜지고 꺼질 때 Tauri 이벤트를 쏜다(창 간 브로드캐스트). 다만 창이 비정상 종료하면
 * "꺼짐"을 못 받아 메인이 영영 접힌 채 남을 수 있어, 메인은 포커스를 얻을 때마다 실제 창
 * 목록으로 재확인한다(아래 watchAggregateWindow).
 */
const EVENT = "aggregate-window://state";

/** 모아보기 창을 연다(이미 떠 있으면 포커스만 — 백엔드가 싱글턴 처리). */
export function openAggregateWindow(): void {
  void invoke("open_aggregate_window", { origin: window.location.origin }).catch(
    (e) => console.error("모아보기 창 생성 실패:", e),
  );
}

/** 모아보기 창 자신이 호출 — 열림/닫힘을 다른 창에 알린다. */
export function announceAggregateWindow(open: boolean): void {
  void emit(EVENT, { open }).catch(() => {});
}

/** 실제 창 목록으로 확인 — 이벤트를 놓쳤을 때의 진실 판정. */
async function isAggregateWindowOpen(): Promise<boolean> {
  try {
    const wins = await getAllWebviewWindows();
    return wins.some((w) => w.label === "aggregate");
  } catch {
    return false;
  }
}

/**
 * 메인 창에서 호출 — 모아보기 창의 열림 여부를 구독한다. 정리 함수를 돌려준다.
 * 이벤트(즉시성) + 포커스 시 재확인(정합성)의 두 겹이다.
 */
export function watchAggregateWindow(onChange: (open: boolean) => void): () => void {
  let disposed = false;
  const sync = () => {
    void isAggregateWindowOpen().then((v) => {
      if (!disposed) onChange(v);
    });
  };

  sync(); // 초기값 — 메인이 새로고침돼도 실제 상태를 따라간다
  const unlisten = listen<{ open: boolean }>(EVENT, (e) => {
    if (!disposed) onChange(!!e.payload?.open);
  });
  window.addEventListener("focus", sync);

  return () => {
    disposed = true;
    window.removeEventListener("focus", sync);
    void unlisten.then((f) => f()).catch(() => {});
  };
}
