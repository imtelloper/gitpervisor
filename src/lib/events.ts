import type { QueryClient } from "@tanstack/react-query";
import { focusManager } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { useOps } from "../stores/ops";
import { useUi } from "../stores/ui";
import type { SyncOp } from "../stores/ops";
import type { VideoExportFinished } from "./ipc";
import { ipc } from "./ipc";

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
    const onFocus = () => {
      handleFocus(true);
      // 포커스 복귀 시 원격 새로고침 1회 트리거 — 스로틀(60초)은 백엔드 소관이라
      // 여기서는 그냥 쏜다(태스크 04 §3.1). 실패는 조용히 무시(freshness 배지가 진실).
      void ipc.refreshRemotes([], false).catch(() => {});
    };
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
      void qc.invalidateQueries({ queryKey: ["repo-files"] }); // Quick Open 파일 목록
    }, 250);
  });

  // 배경 fetch 오류 발생/해소 "전이" 신호(태스크 04 §3.5) — statuses만 재조회해
  // fetchError/lastFetchAt 배지를 갱신한다. 정상 갱신은 refs 변경 → repo://changed 경로.
  void listen<RepoChanged>("repo://remote-freshness", () => {
    void qc.invalidateQueries({ queryKey: ["statuses"] });
  });

  void listen<OpProgress>("repo://op-progress", (e) => {
    useOps.getState().progress(e.payload.projectId, e.payload.line);
  });

  // 동영상 내보내기 종결 — invoke 응답이 유실돼도(§10) 이 이벤트가 토스트·갱신을 책임진다.
  // 진행 중 UI(ExportPanel)는 자기 jobId로 별도 구독하고, 토스트는 여기 한 곳에서만(중복 방지).
  void listen<VideoExportFinished>("video://export-finished", (e) => {
    const { ok, cancelled, error, outRel } = e.payload;
    const name = outRel.split("/").pop() ?? outRel;
    if (cancelled) useUi.getState().pushToast("info", "내보내기를 취소했습니다");
    else if (ok) useUi.getState().pushToast("success", `내보내기 완료 — ${name}`);
    else useUi.getState().pushToast("error", error ?? "내보내기 실패");
    // 산출물이 워크트리에 생겼다 — 파일트리·git 상태 갱신. 덮어쓰기 내보내기로 기존
    // 미디어가 교체됐을 수 있어 staleTime Infinity인 프로브·이미지 캐시도 함께 무효화.
    void qc.invalidateQueries({ queryKey: ["dir"] });
    void qc.invalidateQueries({ queryKey: ["statuses"] });
    void qc.invalidateQueries({ queryKey: ["video-probe"] });
    void qc.invalidateQueries({ queryKey: ["file-image"] });
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
