import { CircleAlert, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { useGitCheck } from "../queries";

/** 앱 시작 게이트: git 실행 파일이 없으면 안내 화면으로 막는다. */
export function GitGate({ children }: { children: ReactNode }) {
  const { data, isLoading, refetch, isFetching } = useGitCheck();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-fg-dim">
        git 확인 중…
      </div>
    );
  }

  if (!data?.found) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <CircleAlert size={36} className="text-danger" strokeWidth={1.5} />
        <div className="text-base font-semibold">git을 찾을 수 없습니다</div>
        <div className="max-w-100 text-[13px] leading-6 text-fg-muted">
          Gitpervisor는 시스템에 설치된 git CLI를 사용합니다 (2.35 이상 권장).
          <br />
          <span className="select-text font-mono text-fg">
            git-scm.com/download/win
          </span>
          에서 설치한 뒤 다시 시도하세요.
        </div>
        <button
          onClick={() => refetch()}
          className="mt-2 flex items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
        >
          <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} />
          다시 확인
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
