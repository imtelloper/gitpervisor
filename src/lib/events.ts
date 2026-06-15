import type { QueryClient } from "@tanstack/react-query";
import { focusManager } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { useOps } from "../stores/ops";
import { useUi } from "../stores/ui";
import type { SyncOp } from "../stores/ops";

interface RepoChanged {
  projectId: string;
}
interface OpProgress {
  projectId: string;
  op: SyncOp;
  line: string;
}
interface OpFinished {
  projectId: string;
  op: SyncOp;
  ok: boolean;
  error: string | null;
}

const OP_LABEL: Record<SyncOp, string> = {
  push: "푸시",
  pull: "풀",
  fetch: "페치",
};

/** 백엔드 이벤트 구독 — 앱 시작 시 1회. 이벤트는 신호일 뿐, 진실은 상태 재조회 (§10). */
export function attachRepoEvents(qc: QueryClient) {
  // v5 기본은 visibilitychange만 본다 — 데스크톱 창은 항상 visible이라
  // 실제 포커스 복귀 갱신(설계 §9)을 위해 window focus 이벤트에 연결한다.
  focusManager.setEventListener((handleFocus) => {
    const onFocus = () => handleFocus(true);
    const onBlur = () => handleFocus(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  });

  let timer: number | undefined;

  void listen<RepoChanged>("repo://changed", () => {
    // watcher 폭주 코얼레싱 — 마지막 신호 후 250ms 지나면 한 번만 재조회
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
      void qc.invalidateQueries({ queryKey: ["log"] });
      void qc.invalidateQueries({ queryKey: ["branches"] });
    }, 250);
  });

  void listen<OpProgress>("repo://op-progress", (e) => {
    useOps.getState().progress(e.payload.projectId, e.payload.line);
  });

  void listen<OpFinished>("repo://op-finished", (e) => {
    const { projectId, op, ok, error } = e.payload;
    const ops = useOps.getState();
    // invoke 응답이 유실됐어도 이벤트로 UI를 정리한다.
    // 진행 중 표시가 남아있을 때만 토스트 → mutation 콜백과 중복 방지.
    if (ops.running[projectId]) {
      ops.finish(projectId);
      if (ok) useUi.getState().pushToast("success", `${OP_LABEL[op]} 완료`);
      else useUi.getState().pushToast("error", error ?? `${OP_LABEL[op]} 실패`);
    }
    void qc.invalidateQueries({ queryKey: ["statuses"] });
    void qc.invalidateQueries({ queryKey: ["log"] });
    void qc.invalidateQueries({ queryKey: ["branches"] });
  });
}
