import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { useMessages } from "../../i18n/ui-language";
import type { DiffTarget } from "../../lib/ipc";
import { useSettings } from "../../queries";
import { ConfirmHost } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { PromptHost } from "../common/PromptDialog";
import { Toasts } from "../common/Toast";
import { FloatTitleBar } from "../FloatTitleBar";
import { CommitDetailPane } from "./CommitDetailPane";
import { CommitList } from "./CommitList";

// Git 모달과 같은 이유로 lazy — 이 파일이 정적 import 하면 Monaco 가 doc 창 진입 청크에 실린다.
const DiffViewer = lazy(() => import("../diff/DiffViewer"));

/** 창 로컬 선택 — 메인 창의 전역 `selectedDiff` 를 건드리지 않는다(Git 모달과 같은 계약). */
type Sel = { target: DiffTarget; repoId: string };

/**
 * 프로젝트 git 로그를 띄우는 별도 OS 창(사이드바 우클릭 → git log).
 *
 * 배치는 Git 모달의 로그 탭 그대로다: 커밋 목록 | 커밋 상세 | diff. 다른 점은 창이라는 것뿐이라
 * 선택·상태를 전부 여기 로컬로 들고, 메인 창 스토어는 읽지도 쓰지도 않는다.
 */
export function LogWindow({ projectId, name }: { projectId: string; name: string }) {
  const msg = useMessages();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  useEffect(() => {
    if (settings?.theme) document.documentElement.dataset.theme = settings.theme;
  }, [settings?.theme]);

  /**
   * **이 창이 직접 들어야 한다.** `attachRepoEvents` 는 메인 창에서만 걸리므로(main.tsx),
   * 그대로 두면 메인에서 커밋해도 이 창의 로그가 안 바뀐다 — `useLog` 는 staleTime 30초라
   * 포커스 복귀에 우연히 풀릴 뿐이고, 브랜치는 더 오래 낡은 채로 남는다.
   */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ projectId: string }>("repo://changed", (e) => {
      // 중첩 저장소 파일 변경은 최상위 id 로 온다 — 그 프로젝트의 로그면 갱신한다.
      if (e.payload.projectId !== projectId.split("::")[0]) return;
      void qc.invalidateQueries({ queryKey: ["log", projectId] });
      void qc.invalidateQueries({ queryKey: ["branches", projectId] });
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [qc, projectId]);

  const [sha, setSha] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  // DiffViewer 가 정의 이동용으로 모듈 컨텍스트에 들고 있어 신원이 안정해야 한다(Git 모달과 동일).
  const onSelect = useCallback(
    (target: DiffTarget, repoId: string) => setSel({ target, repoId }),
    [],
  );

  return (
    <div className="flex h-screen flex-col bg-base">
      <FloatTitleBar title={`${name} — git log`} badge="git log" />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[380px] shrink-0 flex-col overflow-hidden border-r border-edge">
          <CommitList projectId={projectId} selectedSha={sha} onSelectCommit={setSha} />
        </div>
        <CommitDetailPane
          projectId={projectId}
          onSelect={onSelect}
          active={sel}
          selectedSha={sha}
        />
        <div className="min-h-0 min-w-0 flex-1">
          {sel ? (
            <Suspense fallback={<EmptyState title={msg.git.diff.diffViewerLoading} />}>
              <DiffViewer projectId={sel.repoId} target={sel.target} onOpenFile={onSelect} />
            </Suspense>
          ) : (
            <EmptyState title={msg.git.log.logWindowEmpty} />
          )}
        </div>
      </div>
      {/* 해시·메시지 복사 토스트와 확인·입력 창은 **이 창의** 스토어를 본다 — 호스트가 여기
          없으면 이 창에서만 아무 것도 안 뜬다(DocWindow 의 다른 창들과 같은 이유). */}
      <Toasts />
      <ConfirmHost />
      <PromptHost />
    </div>
  );
}

export default LogWindow;
