import { useEffect, useRef } from "react";

import { GLOBAL_NOTES_ID } from "../../lib/ipc";
import { useOccludesWebview } from "../../stores/occlusion";
import { MemoPanel } from "./MemoPanel";

/**
 * 타이틀바 "메모장" 팝오버 — 프로젝트와 무관한 전역 메모(예약 키 하나에 몰아 저장).
 *
 * 버튼 rect 기준 fixed + 투명 백드롭 패턴(AggregateTerminals의 NewCellButton과 같다):
 * 타이틀바는 h-8이라 그 안에 두면 잘리고, 우측 끝 버튼이라 left 기준이면 창 밖으로 나간다.
 */
export function GlobalMemoPopover({
  anchor,
  onClose,
  closeRef,
}: {
  /** 버튼의 getBoundingClientRect() 결과 — 이 아래에 붙인다 */
  anchor: { right: number; top: number };
  onClose: () => void;
  /** 부모(타이틀바 버튼)가 토글로 닫을 때 쓸 close를 심어 준다 — flush를 거치게 하기 위함. */
  closeRef?: React.RefObject<(() => void) | null>;
}) {
  const flushRef = useRef<(() => void) | null>(null);
  // 워크스페이스의 네이티브 자식 webview(브라우저 탭)는 React DOM과 z-합성되지 않고 항상 위에
  // 그려진다 — 등록하지 않으면 브라우저가 열려 있을 때 이 팝오버가 통째로 가린다(occlusion.ts).
  useOccludesWebview(true);

  // 닫기 전에 flush — 미저장분 저장 + 빈 메모 정리(패널 언마운트에 맡기면 StrictMode가 초안을 지운다).
  function close() {
    flushRef.current?.();
    onClose();
  }

  // Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 부모 버튼의 "다시 눌러 닫기"도 이 close를 타야 한다. 마우스 클릭은 백드롭이 먼저 먹지만
  // 키보드(버튼에 포커스 후 Enter)는 버튼에 직접 닿아, 부모가 자체적으로 닫으면 flush를
  // 건너뛰어 미저장분이 날아간다.
  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = close;
    return () => {
      closeRef.current = null;
    };
  });

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={close} />
      <div
        // 좁은 창에서 화면 밖으로 나가지 않게 **앵커 오프셋을 뺀** 값으로 클램프한다.
        // `max-w-[calc(100vw-24px)]` 같은 상수는 우측 고정 박스에 아무 소용이 없다 — 폭이
        // 100vw보다 작아도 right 오프셋(≈384px, macOS 격리 배지가 뜨면 ≈480px)만큼 더 밀려
        // 왼쪽이 잘린다. 최소 창폭이 1100(lib.rs min_inner_size)이라 실제로 잘린다.
        //
        // cursor-auto·select-text: 이 팝오버는 타이틀바(<header> select-none cursor-default)
        // 안에 DOM으로 들어가 상속을 받는다 — 편집기에는 상속을 끊어 준다.
        className="fixed z-50 flex h-[420px] w-[720px] cursor-auto overflow-hidden rounded-lg border border-edge bg-panel shadow-xl select-text"
        style={{
          right: anchor.right,
          top: anchor.top,
          maxWidth: `calc(100vw - ${anchor.right}px - 12px)`,
          maxHeight: `calc(100vh - ${anchor.top}px - 12px)`,
        }}
      >
        <MemoPanel
          scopeId={GLOBAL_NOTES_ID}
          scopeLabel="전역 메모"
          onClose={close}
          flushRef={flushRef}
        />
      </div>
    </>
  );
}
