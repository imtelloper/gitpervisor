import { MousePointerClick, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import type { DiffTarget } from "../../lib/ipc";
import { useProjects } from "../../queries";
import { useUi } from "../../stores/ui";
import { ChangesPanel } from "../changes/ChangesPanel";
import { EmptyState } from "../common/EmptyState";
import { ProjectLogo } from "../common/ProjectLogo";
import { CommitDetailPane } from "../log/CommitDetailPane";
import { CommitList } from "../log/CommitList";

// Monaco 번들은 무겁다 — 파일을 처음 열 때만 로드한다(ViewerTab과 같은 lazy 경계).
const DiffViewer = lazy(() => import("../diff/DiffViewer"));

/** 모달 로컬 선택 — 전역 selectedDiff를 건드리지 않는다(뷰어 탭·모아보기 불변). */
type Sel = { target: DiffTarget; repoId: string };
type Tab = "changes" | "log";

/**
 * 터미널 세션 헤더의 Git 버튼이 여는 변경·로그 모달(태스크 55). 모아보기에는 Changes·Log 패널이
 * 없어 이 모달이 유일한 동선이다. 상태는 창별 `useUi`라 별도 모아보기 창은 자기 모달을 그린다.
 */
export function GitDialog() {
  const gitDialog = useUi((s) => s.gitDialog);
  const close = useUi((s) => s.closeGitDialog);

  useEffect(() => {
    if (!gitDialog) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gitDialog, close]);

  // 배경 클릭 닫기 — pointerdown과 click이 **둘 다** 배경에 떨어졌을 때만 닫는다. 모달 안에서
  // 시작한 드래그(텍스트 선택·리사이즈)를 배경 위에서 놓으면 click은 두 지점의 공통 조상인
  // 배경으로 가므로, 그것만 보면 드래그가 모달을 닫아 버린다(MemoPanel.tsx의 같은 함정).
  const downOnBackdrop = useRef(false);

  if (!gitDialog) return null;
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
        className="flex h-[min(780px,92vh)] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* key — 프로젝트가 바뀌면 탭·선택을 처음 상태로 되돌린다. */}
        <Body key={gitDialog.projectId} projectId={gitDialog.projectId} onClose={close} />
      </div>
    </div>
  );
}

function Body({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { data: projects } = useProjects();
  const name = projects?.find((p) => p.id === projectId)?.name ?? projectId;
  const [tab, setTab] = useState<Tab>("changes");
  // 탭별 선택 — 변경/로그가 서로의 선택을 지우지 않는다.
  const [sel, setSel] = useState<Record<Tab, Sel | null>>({
    changes: null,
    log: null,
  });
  // 커밋 선택도 모달 로컬 — 전역 selectedCommitSha를 쓰면 하단 Log 패널(다른 프로젝트일 수 있다)과
  // 서로의 선택을 덮어쓰고, 남의 저장소 sha를 조회한 상세는 영영 안 뜬다.
  const [sha, setSha] = useState<string | null>(null);
  const active = sel[tab];
  // DiffViewer가 정의 이동용으로 모듈 컨텍스트에 들고 있으므로 신원이 안정해야 한다.
  const onSelect = useCallback(
    (target: DiffTarget, repoId: string) =>
      setSel((s) => ({ ...s, [tab]: { target, repoId } })),
    [tab],
  );

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        <ProjectLogo projectId={projectId} />
        <span className="truncate font-semibold">{name}</span>
        <div className="ml-2 flex items-center gap-1">
          {(["changes", "log"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`border-b-2 px-2 py-1 text-xs ${
                tab === t
                  ? "border-accent text-fg"
                  : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              {t === "changes" ? "변경" : "로그"}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={onClose}
          title="닫기"
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      {/* 탭 전환 시 리마운트 — 모달 수명이 짧아 숨겨 두고 살릴 이유가 없다. */}
      <div className="flex min-h-0 flex-1">
        {tab === "changes" ? (
          <ChangesPanel
            projectId={projectId}
            onSelect={onSelect}
            active={active}
            embedded
          />
        ) : (
          <>
            <div className="flex w-[380px] shrink-0 flex-col overflow-hidden border-r border-edge">
              <CommitList
                projectId={projectId}
                selectedSha={sha}
                onSelectCommit={setSha}
              />
            </div>
            <CommitDetailPane
              projectId={projectId}
              onSelect={onSelect}
              active={active}
              selectedSha={sha}
            />
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {active ? (
            <Suspense fallback={<EmptyState title="diff 뷰어 로딩 중…" />}>
              <DiffViewer
                projectId={active.repoId}
                target={active.target}
                onOpenFile={onSelect}
              />
            </Suspense>
          ) : (
            <EmptyState icon={MousePointerClick} title="파일을 선택하세요" />
          )}
        </div>
      </div>
    </>
  );
}
