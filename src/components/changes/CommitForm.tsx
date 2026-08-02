import { useEffect, useRef, useState } from "react";

import { useCommit, usePushFlow, useStatus } from "../../queries";
import { useOps } from "../../stores/ops";

const draftKey = (projectId: string) => `gp:commit-draft:${projectId}`;

function loadDraft(projectId: string): string {
  try {
    return localStorage.getItem(draftKey(projectId)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(projectId: string, message: string) {
  try {
    if (message.trim()) localStorage.setItem(draftKey(projectId), message);
    else localStorage.removeItem(draftKey(projectId));
  } catch {
    // 초안은 편의 기능이라 저장 실패(용량 초과 등)는 조용히 무시한다.
  }
}

export function CommitForm({
  projectId,
  bindShortcut = true,
}: {
  projectId: string;
  /**
   * Ctrl+K 전역 커밋 단축키에 반응할지 여부. 임베디드 저장소용 커밋 폼이 여러 개
   * 동시에 뜨므로, 전역 단축키는 최상위(pinned) 폼 하나만 처리하게 한다(중복 커밋 방지).
   */
  bindShortcut?: boolean;
}) {
  const { data: status } = useStatus(projectId);
  // 작성 중인 커밋 메시지는 앱이 갑자기 죽으면(예: OS의 메모리 부족 강제 종료) 통째로
  // 사라지던 유일한 데이터였다 — 메모·프로젝트·터미널 레이아웃은 모두 즉시 영속된다.
  // 프로젝트별로 초안을 남겨 재시작 후 이어서 쓸 수 있게 한다.
  const [message, setMessage] = useState(() => loadDraft(projectId));
  const [amend, setAmend] = useState(false);
  const commit = useCommit(projectId);
  const startPush = usePushFlow(projectId);
  const syncing = useOps((s) => !!s.running[projectId]);

  // projectId가 바뀌면 렌더 중에 즉시 초안을 교체한다(React 공식 "props 변화에 상태 맞추기" 패턴).
  // useEffect로 하면 아래 저장 이펙트가 먼저 돌아 이전 프로젝트의 메시지를 새 프로젝트 초안으로
  // 덮어쓴다 — 이펙트는 항상 message와 projectId가 맞춰진 뒤에 실행돼야 한다.
  const [draftOf, setDraftOf] = useState(projectId);
  if (draftOf !== projectId) {
    setDraftOf(projectId);
    setMessage(loadDraft(projectId));
  }

  // 300ms 디바운스로 초안 기록 — 타이핑마다 쓰지 않는다. 커밋 성공 시 message가 ""가 되면
  // saveDraft가 키를 지운다.
  // 마지막 값을 ref로 들고 있다가 cleanup에서 flush한다 — 언마운트/프로젝트 전환으로
  // 타이머가 취소돼도 직전 입력이 유실되지 않는다.
  const pendingDraft = useRef({ projectId, message });
  pendingDraft.current = { projectId, message };
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(projectId, message), 300);
    return () => {
      clearTimeout(timer);
      saveDraft(pendingDraft.current.projectId, pendingDraft.current.message);
    };
  }, [projectId, message]);

  const stagedCount = status?.staged.length ?? 0;
  const canCommit =
    message.trim().length > 0 &&
    (stagedCount > 0 || amend) &&
    !commit.isPending &&
    !syncing;

  function doCommit(thenPush: boolean) {
    commit.mutate(
      { message, amend },
      {
        onSuccess: () => {
          // 디바운스(300ms)를 기다리지 않고 즉시 지운다. 기다리는 사이 컴포넌트가 언마운트되면
          // (커밋 후 변경 목록이 비어 CommitForm이 사라지는 흔한 경로) 타이머가 취소돼
          // **이미 커밋한 메시지가 초안으로 남는다.** 다음에 폼이 다시 뜨면 그 메시지가 채워지고
          // Ctrl+K는 확인 없이 커밋하므로 같은 메시지로 중복 커밋할 위험이 있다.
          saveDraft(projectId, "");
          setMessage("");
          setAmend(false);
          if (thenPush) startPush();
        },
      },
    );
  }

  // Ctrl+K 단축키 → 커밋. 메시지 상태가 여기 있으므로 이벤트로 받아 처리한다.
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    if (canCommit) doCommit(false);
  };
  useEffect(() => {
    if (!bindShortcut) return;
    const handler = () => commitRef.current();
    window.addEventListener("gitpervisor:commit", handler);
    return () => window.removeEventListener("gitpervisor:commit", handler);
  }, [bindShortcut]);

  return (
    <div className="border-t border-edge p-3">
      <label className="flex w-fit cursor-pointer items-center gap-1.5 pb-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={amend}
          onChange={(e) => setAmend(e.target.checked)}
          className="accent-accent"
        />
        Amend (마지막 커밋 수정)
      </label>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="커밋 메시지"
        rows={3}
        className="w-full resize-none rounded border border-edge bg-base px-2 py-1.5 text-[13px] outline-none placeholder:text-fg-dim focus:border-accent"
      />
      <div className="mt-2 flex gap-2">
        <button
          disabled={!canCommit}
          onClick={() => doCommit(false)}
          className="rounded border border-edge px-3 py-1.5 text-[13px] hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
        >
          {commit.isPending ? "커밋 중…" : "Commit"}
        </button>
        <button
          disabled={!canCommit}
          onClick={() => doCommit(true)}
          className="flex-1 rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Commit and Push
        </button>
      </div>
      {stagedCount === 0 && !amend && (
        <div className="mt-1.5 text-[11px] text-fg-dim">
          커밋하려면 파일을 체크해 스테이지하세요
        </div>
      )}
    </div>
  );
}
