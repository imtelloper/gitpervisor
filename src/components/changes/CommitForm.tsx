import { useState } from "react";

import { useCommit, usePushFlow, useStatus } from "../../queries";
import { useOps } from "../../stores/ops";

export function CommitForm({ projectId }: { projectId: string }) {
  const { data: status } = useStatus(projectId);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const commit = useCommit(projectId);
  const startPush = usePushFlow(projectId);
  const syncing = useOps((s) => !!s.running[projectId]);

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
          setMessage("");
          setAmend(false);
          if (thenPush) startPush();
        },
      },
    );
  }

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
          className="flex-1 rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
