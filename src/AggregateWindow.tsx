import { useEffect } from "react";

import { AggregateTerminals } from "./components/AggregateTerminals";
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

  // 열림/닫힘을 메인 창에 알린다. 비정상 종료로 "닫힘"을 못 보내는 경우는 메인이 포커스 시
  // 창 목록으로 재확인해 보정한다.
  useEffect(() => {
    announceAggregateWindow(true);
    const bye = () => announceAggregateWindow(false);
    window.addEventListener("beforeunload", bye);
    return () => {
      window.removeEventListener("beforeunload", bye);
      bye();
    };
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
    </div>
  );
}
