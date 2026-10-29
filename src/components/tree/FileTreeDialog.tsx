import { useCallback, useEffect, useRef, useState } from "react";

import { openDocWindow } from "../../lib/floating";
import { useUi } from "../../stores/ui";
import { FileTreePanel } from "./FileTreePanel";

/** 끌어서 바꾼 크기 — 창이 달라도(별도 모아보기 창) 같은 값을 쓴다. 손잡이 더블클릭이 지운다. */
const SIZE_KEY = "gp:file-tree-dialog-size";
const MIN_W = 320;
const MIN_H = 280;
type Size = { w: number; h: number };

function loadSize(): Size | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null; // 외부 데이터 경계
    return o && typeof o.w === "number" && typeof o.h === "number" ? { w: o.w, h: o.h } : null;
  } catch {
    return null; // 깨진 값·저장소 없음 — 기본 크기로
  }
}

/** 변·모서리 손잡이 8개 — [dx, dy]: 끄는 쪽 방향(-1 왼/위, 1 오른/아래, 0 그 축은 고정). */
const HANDLES: { dx: -1 | 0 | 1; dy: -1 | 0 | 1; cls: string }[] = [
  { dx: 0, dy: -1, cls: "-top-1 left-2 right-2 h-2 cursor-ns-resize" },
  { dx: 0, dy: 1, cls: "-bottom-1 left-2 right-2 h-2 cursor-ns-resize" },
  { dx: -1, dy: 0, cls: "-left-1 top-2 bottom-2 w-2 cursor-ew-resize" },
  { dx: 1, dy: 0, cls: "-right-1 top-2 bottom-2 w-2 cursor-ew-resize" },
  { dx: -1, dy: -1, cls: "-left-1 -top-1 h-3 w-3 cursor-nwse-resize" },
  { dx: 1, dy: 1, cls: "-right-1 -bottom-1 h-3 w-3 cursor-nwse-resize" },
  { dx: 1, dy: -1, cls: "-right-1 -top-1 h-3 w-3 cursor-nesw-resize" },
  { dx: -1, dy: 1, cls: "-left-1 -bottom-1 h-3 w-3 cursor-nesw-resize" },
];

/**
 * 터미널 세션 헤더의 파일 트리 버튼이 여는 파일 트리 모달(태스크 62). 모아보기(메인 안·별도
 * 창)에는 사이드바가 없어 이 모달이 그 프로젝트 트리로 가는 유일한 동선이다. 껍데기는
 * GitDialog와 같고 본문만 `FileTreePanel(variant="modal")`이다 — 상태는 창별 `useUi`라
 * 별도 모아보기 창은 자기 모달을 그린다.
 */
export function FileTreeDialog() {
  const dialog = useUi((s) => s.fileTreeDialog);
  const close = useUi((s) => s.closeFileTreeDialog);
  const projectId = dialog?.projectId;

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, close]);

  // 파일 열기는 **별도 문서 창**으로 보낸다. `selectDiff`를 부르면 (a) repoId를 안 넘겨 현재
  // 선택된 프로젝트 기준으로 경로를 풀어 다른 레포의 같은 경로 파일이 열리고, (b) 뷰어 탭을
  // 업서트하며, (c) 모아보기가 열려 있으면 닫아 버린다(설계 §2).
  const onActivate = useCallback(
    (path: string) => {
      if (projectId) openDocWindow(projectId, path);
    },
    [projectId],
  );

  // 배경 클릭 닫기 — pointerdown과 click이 **둘 다** 배경에 떨어졌을 때만 닫는다. 모달 안에서
  // 시작한 드래그(트리의 드래그 이동·텍스트 선택)를 배경 위에서 놓으면 click은 두 지점의 공통
  // 조상인 배경으로 가므로, 그것만 보면 드래그가 모달을 닫아 버린다(GitDialog와 같은 함정).
  const downOnBackdrop = useRef(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(loadSize);
  // 가운데 정렬이라 한쪽 변을 끌면 양쪽이 같이 움직인다 — 변화량을 두 배로 줘야 끄는 변이 포인터를 따라온다.
  const startResize = (e: React.PointerEvent<HTMLDivElement>, dx: number, dy: number) => {
    if (e.button !== 0 || !boxRef.current) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const r = boxRef.current.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: Size = { w: r.width, h: r.height };
    const move = (ev: PointerEvent) => {
      last = {
        w: Math.round(Math.min(Math.max(r.width + 2 * dx * (ev.clientX - x0), MIN_W), window.innerWidth - 16)),
        h: Math.round(Math.min(Math.max(r.height + 2 * dy * (ev.clientY - y0), MIN_H), window.innerHeight - 16)),
      };
      setSize(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(last));
      } catch {
        /* 저장소 없음 — 이번 세션에만 적용된다 */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const resetSize = () => {
    setSize(null);
    try {
      localStorage.removeItem(SIZE_KEY);
    } catch {
      /* 저장소 없음 — 화면만 되돌린다 */
    }
  };

  if (!dialog || !projectId) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) close();
      }}
    >
      <div
        ref={boxRef}
        data-gpv="file-tree-dialog"
        className={`relative max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] ${size ? "" : "h-[min(760px,90vh)] w-[min(520px,92vw)]"}`}
        style={size ? { width: size.w, height: size.h } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl">
          {/* key — 프로젝트가 바뀌면 멀티선택·우클릭 메뉴 같은 트리 로컬 상태를 처음으로 되돌린다. */}
          <FileTreePanel
            key={projectId}
            projectId={projectId}
            variant="modal"
            onActivate={onActivate}
            onClose={close}
          />
        </div>
        {/* 손잡이는 테두리 바깥으로 반쯤 걸친다 — 안쪽에 두면 트리 스크롤바를 가린다. */}
        {HANDLES.map((h) => (
          <div
            key={`${h.dx},${h.dy}`}
            data-gpv="file-tree-dialog-resize"
            className={`absolute z-10 ${h.cls}`}
            onPointerDown={(e) => startResize(e, h.dx, h.dy)}
            onDoubleClick={resetSize}
          />
        ))}
      </div>
    </div>
  );
}
