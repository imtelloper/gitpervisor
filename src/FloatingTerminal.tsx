import { emit } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { attachTerminal, createTerminal, fitTerminal } from "./lib/terminal";

/**
 * 별도 OS 창으로 분리된 단일 터미널. 메인 창이 만든 살아있는 PTY에 term_attach로 재연결한다
 * (attach=true). 스크롤백은 옮겨지지 않고, 이후 출력만 이 창에 흐른다. 창을 닫으면 Rust의
 * 창 닫힘 이벤트(float-<paneId>)가 해당 PTY를 종료한다.
 */
export function FloatingTerminal({ paneId }: { paneId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    // attach 경로는 projectId를 쓰지 않는다(term_attach는 termId=paneId만 필요).
    void createTerminal({
      id: paneId,
      projectId: "",
      fontSize: 13,
      attach: true,
    }).then(() => {
      if (!cancelled && el) attachTerminal(paneId, el);
      // 창이 로드돼 PTY에 재연결됐음을 메인 창에 알린다(상태 표시/검증용).
      void emit("float://ready", { paneId });
    });
    const ro = new ResizeObserver(() => fitTerminal(paneId));
    if (el) ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [paneId]);

  return <div ref={ref} className="h-screen w-screen bg-base p-1" />;
}
