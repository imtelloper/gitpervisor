import { useEffect, useRef } from "react";

import { useProjects } from "../../queries";
import { useUi } from "../../stores/ui";
import { MemoPanel } from "./MemoPanel";

/** 프로젝트별 메모 — 큰 모달(좌: 메모 목록 / 우: 편집기). 여러 메모 지원. */
export function MemoDialog() {
  const open = useUi((s) => s.memoOpen);
  const setOpen = useUi((s) => s.setMemoOpen);
  const projectId = useUi((s) => s.selectedProjectId);
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId) ?? null;
  // 패널이 심어 주는 flush — 닫기 직전에 부른다(패널의 언마운트에 맡기면 StrictMode가 초안을 지운다).
  const flushRef = useRef<(() => void) | null>(null);

  // Esc 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !project || !projectId) return null;

  function close() {
    flushRef.current?.();
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={close}
    >
      <div
        className="flex h-[560px] w-[820px] overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <MemoPanel
          scopeId={projectId}
          scopeLabel={project.name}
          onClose={close}
          flushRef={flushRef}
        />
      </div>
    </div>
  );
}
