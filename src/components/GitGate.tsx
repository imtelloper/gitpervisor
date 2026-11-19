import { CircleAlert, RefreshCw, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { useMessages } from "../i18n/ui-language";
import { useGitCheck } from "../queries";

function downloadUrlForPlatform(): string {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "git-scm.com/download/mac";
  if (/Linux/i.test(ua)) return "git-scm.com/download/linux";
  return "git-scm.com/download/win";
}

/**
 * git 미설치 안내 띠. 예전엔 앱 전체를 안내 화면으로 막았는데, git이 없는 PC에서는 터미널·파일·
 * DB·이미지 편집처럼 git과 무관한 기능까지 통째로 못 썼다(사용자 보고). 이제 위에 띠만 두고
 * 나머지는 그대로 쓴다 — git 호출은 각자 "git 실행 파일을 찾을 수 없습니다" 오류로 실패한다.
 */
export function GitGate({ children }: { children: ReactNode }) {
  const msg = useMessages();
  const { data, refetch, isFetching } = useGitCheck();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const missing = data && !data.found && !dismissed ? data : null;

  return (
    <div className="flex h-full flex-col">
      {missing && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-soft px-3 py-1.5 text-[12px] text-fg-muted"
          title={[missing.path && `path: ${missing.path}`, missing.reason && `reason: ${missing.reason}`]
            .filter(Boolean)
            .join("\n")}
        >
          <CircleAlert size={14} className="shrink-0 text-danger" />
          <span className="font-medium text-fg">{msg.app.gitGate.notFoundTitle}</span>
          <span className="min-w-0 truncate">
            {msg.app.gitGate.othersStillWork} {msg.app.gitGate.installBeforeUrl}
            <span className="select-text font-mono text-fg">{downloadUrlForPlatform()}</span>
            {msg.app.gitGate.installAfterUrl}
          </span>
          <span className="flex-1" />
          <button
            // 설치 뒤 다시 확인에 성공하면 git 없이 실패해 있던 상태·로그 쿼리도 다시 불러온다.
            onClick={() => void refetch().then((r) => { if (r.data?.found) void queryClient.invalidateQueries(); })}
            className="flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            {msg.app.gitGate.recheck}
          </button>
          <button
            onClick={() => setDismissed(true)}
            aria-label={msg.app.gitGate.dismiss}
            title={msg.app.gitGate.dismiss}
            className="shrink-0 rounded p-0.5 hover:bg-raised hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
