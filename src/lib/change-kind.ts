import type { ChangeKind } from "./ipc";

/** 변경 종류별 한 글자 뱃지 + 색 토큰 — Changes 목록과 커밋 상세 파일 트리가 공유. */
export const KIND_BADGE: Record<
  ChangeKind,
  { letter: string; className: string }
> = {
  modified: { letter: "M", className: "text-mod" },
  added: { letter: "A", className: "text-add" },
  deleted: { letter: "D", className: "text-del" },
  renamed: { letter: "R", className: "text-mod" },
  typechange: { letter: "T", className: "text-mod" },
  conflicted: { letter: "!", className: "text-danger" },
  untracked: { letter: "?", className: "text-untrk" },
};
