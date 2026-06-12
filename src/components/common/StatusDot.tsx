import type { RepoStatus } from "../../lib/ipc";

export type DotState = "clean" | "dirty" | "conflict" | "error" | "loading";

export function dotStateOf(
  status: RepoStatus | undefined,
  isLoading: boolean,
): DotState {
  if (!status) return isLoading ? "loading" : "error";
  if (status.error) return "error";
  if (status.conflicted.length > 0 || status.opState !== "normal")
    return "conflict";
  if (
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0 ||
    status.ahead > 0 ||
    status.behind > 0
  )
    return "dirty";
  return "clean";
}

const DOT_CLASS: Record<DotState, string> = {
  clean: "bg-ok",
  dirty: "bg-warn",
  conflict: "bg-danger",
  error: "bg-fg-dim",
  loading: "bg-fg-dim animate-pulse",
};

export function StatusDot({ state }: { state: DotState }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[state]}`}
    />
  );
}
