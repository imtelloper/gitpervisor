import { useEffect } from "react";

import { AggregateTerminals } from "./components/AggregateTerminals";
import { ConfirmHost } from "./components/common/ConfirmDialog";
import { Toasts } from "./components/common/Toast";
import { FloatTitleBar } from "./components/FloatTitleBar";
import { announceAggregateWindow } from "./lib/aggregate-window";
import { refreshTerminalThemes } from "./lib/terminal";
import { useSettings } from "./queries";

/**
 * 터미널 모아보기 전용 창(label="aggregate") — 보조 모니터에 띄우는 터미널 벽.
 *
 * 이 창은 메인이 만든 PTY에 **재연결**해 보여준다(AggregateTerminals의 attach 분기). PTY 출력
 * 소비자는 하나뿐이라 붙는 순간 메인 창의 같은 터미널은 멈추므로, 메인은 이 창이 떠 있는 동안
 * 터미널 패널을 "다른 창에서 표시 중"으로 접는다(lib/aggregate-window.ts § 소유권 이전).
 *
 * 창을 닫아도 PTY는 살아 있다 — 라벨이 `float-`가 아니라 Rust의 Destroyed 핸들러가 세션을
 * 종료하지 않기 때문. 닫히면 메인이 다시 이어받는다.
 */
export function AggregateWindow() {
  const { data: settings } = useSettings();

  // 열림만 여기서 알린다. "닫힘"은 Rust의 Destroyed 훅이 메인에 보낸다(lib.rs) — 예전엔 이 창의
  // beforeunload가 보냈는데, 창이 죽는 중의 비동기 IPC라 **유실**돼 메인이 "다른 창에서 표시 중"에
  // 갇혔다(2026-09-02 실측). 효과 정리에서도 보내지 않는다 — StrictMode 이중 마운트가 true·true·false
  // 순서로 도착해 창이 열려 있는데 마지막 false가 남았다(같은 날 실측).
  useEffect(() => {
    announceAggregateWindow(true);
  }, []);

  // 이 창에도 저장된 테마 적용 — attach된 xterm은 생성 시 테마가 박제라 확정값으로 재적용한다.
  useEffect(() => {
    if (!settings?.theme) return;
    document.documentElement.dataset.theme = settings.theme;
    refreshTerminalThemes();
  }, [settings?.theme]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-base">
      <FloatTitleBar title="터미널 모아보기" badge="모아보기" />
      <div className="min-h-0 flex-1">
        <AggregateTerminals />
      </div>
      {/* 이 창에도 확인 모달·토스트가 필요하다 — 터미널 닫기 확인(askConfirm)이 이 창에서 뜨고,
          셀의 프롬프트 목록 복사는 성공/실패를 알려야 한다. 스토어는 창마다 별개라
          (웹뷰 = 별도 JS 컨텍스트) 메인 창의 호스트가 여기 대신 그려 주지 않는다(SysMonitorWindow와 동일). */}
      <ConfirmHost />
      <Toasts />
    </div>
  );
}
