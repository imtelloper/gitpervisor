import { forwardRef, useImperativeHandle, useState } from "react";

// ── 드래그 이동 고스트 ──
// 커서를 따라다니는 라벨은 pointermove마다 갱신된다 — 목록을 그리는 부모의 state로 두면
// 이동 한 번에 행 수백 개가 프레임마다 리렌더된다. 고스트만 자기 state를 갖고, 부모는 핸들로
// 명령만 내린다(리렌더 범위 = 이 작은 컴포넌트 하나).
// 소비자: 파일 트리(FileTreePanel), 레이어 패널(태스크 44).
//
// **props 로 바꾸지 마라.** `{label, dest}` 를 props 로 받으면 부모가 그 값을 state 로 들고
// pointermove 마다 리렌더한다 — 그리고 **e2e 는 그대로 통과한다**(드래그는 여전히 되고
// 버벅일 뿐이라 단언에 안 걸린다). 잡는 방법은 호출부 한 줄이다:
//     grep -n "<DragGhost" src/      → `ref` 외의 props 가 보이면 그 형태다
// 2026-09-09 에 실제로 이 파일을 props 형태로 옮길 뻔했다. 위의 성능 주석이 이미 있었는데도
// 설계 요약(`{label, dest} 유지`)만 보고 props 로 읽었기 때문이다 — 그래서 이유가 아니라
// **금지와 검사 방법**을 여기 둔다.
export interface GhostState {
  x: number;
  y: number;
  /** 끌고 있는 것 — 파일명·레이어 이름 또는 "N개 항목" */
  label: string;
  /** 대상 설명(파일 트리는 레포 상대 폴더, ""=루트). null = 지금 위치엔 놓을 수 없음 */
  dest: string | null;
}
export interface DragGhostHandle {
  update(g: GhostState | null): void;
}
export const DragGhost = forwardRef<DragGhostHandle>(function DragGhost(_props, ref) {
  const [g, setG] = useState<GhostState | null>(null);
  useImperativeHandle(ref, () => ({ update: setG }), []);
  if (!g) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-64 rounded-md border border-edge bg-panel px-2.5 py-1.5 text-xs shadow-xl"
      style={{ left: g.x + 14, top: g.y + 10 }}
    >
      <div className="truncate font-medium text-fg">{g.label}</div>
      <div className={`truncate text-[11px] ${g.dest !== null ? "text-accent" : "text-fg-dim"}`}>
        {g.dest !== null ? `→ ${g.dest || "루트"}` : "여기로는 이동할 수 없습니다"}
      </div>
    </div>
  );
});
