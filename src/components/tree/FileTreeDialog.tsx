import { useCallback, useEffect, useRef } from "react";

import { openDocWindow } from "../../lib/floating";
import { useUi } from "../../stores/ui";
import { FileTreePanel } from "./FileTreePanel";

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
        className="flex h-[min(760px,90vh)] w-[min(520px,92vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* key — 프로젝트가 바뀌면 멀티선택·우클릭 메뉴 같은 트리 로컬 상태를 처음으로 되돌린다. */}
        <FileTreePanel
          key={projectId}
          projectId={projectId}
          variant="modal"
          onActivate={onActivate}
          onClose={close}
        />
      </div>
    </div>
  );
}
