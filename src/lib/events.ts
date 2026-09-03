import type { QueryClient } from "@tanstack/react-query";
import { focusManager } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { useOps } from "../stores/ops";
import { useUi } from "../stores/ui";
import { setSplitQueryClient, useVideoSplit } from "../stores/videoSplit";
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

/**
 * 이 창이 시작시킨 단일 내보내기 잡 id — `video://export-finished`는 **모든 창**에 오는데
 * (Rust `app.emit`), 창마다 토스트 호스트가 따로라 걸러내지 않으면 doc 창에서 내보낸 결과가
 * 메인 창에도 뜬다. 시작한 창만 표시해 두고 핸들러가 소비한다(태스크 35 §2.2).
 * 분할 배치는 videoSplit 스토어의 `owns`가 이미 창 단위라 그대로 둔다.
 */
const localVideoJobs = new Set<string>();

/** 내보내기 invoke 직전에 부른다 — 이 창이 그 잡의 토스트 주인임을 표시. */
export function markLocalVideoJob(id: string) {
  localVideoJobs.add(id);
}

/**
 * 동영상 내보내기 이벤트 구독 — 메인(attachRepoEvents)과 doc 창(DocWindow) 양쪽이 부른다.
 * 무효화는 어느 창이든(멱등), 토스트·배치 진행은 그 잡을 시작한 창만 한다.
 */
export function attachVideoEvents(qc: QueryClient) {
  // 분할 배치 스토어는 React 밖이라 훅으로 qc를 못 얻는다 — 여기서 한 번 넘긴다.
  setSplitQueryClient(qc);

  // 동영상 내보내기 종결 — invoke 응답이 유실돼도(§10) 이 이벤트가 토스트·갱신을 책임진다.
  // 진행 중 UI(ExportPanel)는 자기 jobId로 별도 구독하고, 토스트는 여기 한 곳에서만(중복 방지).
  void listen<VideoExportFinished>("video://export-finished", (e) => {
    // 분할 배치가 발급한 잡이면 세그먼트마다 토스트·무효화가 터지면 안 된다 —
    // 스토어가 루프를 이어가고 배치 끝에 요약 토스트 1개만 띄운다(태스크 22 §3.3).
    if (useVideoSplit.getState().owns(e.payload.jobId)) {
      useVideoSplit.getState().advance(e.payload);
      return;
    }
    // 남의 창이 시작한 잡 — 산출물 반영(무효화)만 하고 토스트는 그 창에 맡긴다.
    if (!localVideoJobs.delete(e.payload.jobId)) {
      invalidateVideoOutputs(qc);
      return;
    }
    const { ok, cancelled, error, outRel } = e.payload;
    const name = outRel.split("/").pop() ?? outRel;
    if (cancelled) useUi.getState().pushToast("info", "내보내기를 취소했습니다");
    else if (ok) useUi.getState().pushToast("success", `내보내기 완료 — ${name}`);
    else useUi.getState().pushToast("error", error ?? "내보내기 실패");
    invalidateVideoOutputs(qc);
  });
}

/** 산출물이 워크트리에 생겼다 — 파일트리·git 상태 갱신. 덮어쓰기 내보내기로 기존
 *  미디어가 교체됐을 수 있어 staleTime Infinity인 프로브·이미지 캐시도 함께 무효화. */
function invalidateVideoOutputs(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["dir"] });
  void qc.invalidateQueries({ queryKey: ["statuses"] });
  void qc.invalidateQueries({ queryKey: ["video-probe"] });
  void qc.invalidateQueries({ queryKey: ["file-image"] });
}

/** 백엔드 이벤트 구독 — 앱 시작 시 1회. 이벤트는 신호일 뿐, 진실은 상태 재조회 (§10). */
export function attachRepoEvents(qc: QueryClient) {
  attachVideoEvents(qc);

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
  // 코얼레싱 동안 바뀐 프로젝트 수집 — 파일트리(["dir", pid])는 **프로젝트 단위**로만
  // 무효화해 다른 프로젝트의 펼쳐진 폴더를 건드리지 않는다. 이 연결은 백엔드 ignore 캐시로
  // list_dir이 ms급이 된 뒤에만 안전하다(예전엔 폴더당 git 스폰이라 폭풍이 됐다 —
  // DOCS/file-tree-performance-design.md §4).
  const changedProjects = new Set<string>();

  void listen<RepoChanged>("repo://changed", (e) => {
    changedProjects.add(e.payload.projectId);
    // watcher 폭주 코얼레싱 — 마지막 신호 후 250ms 지나면 한 번만 재조회
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
      void qc.invalidateQueries({ queryKey: ["log"] });
      void qc.invalidateQueries({ queryKey: ["branches"] });
      void qc.invalidateQueries({ queryKey: ["repo-files"] }); // Quick Open 파일 목록
      // 파일트리 즉각 반영 — react-query는 마운트된(=펼쳐진) 폴더만 refetch한다.
      // file-image도 같은 이유로 **프로젝트 한정**이다: staleTime Infinity라 무효화하지 않으면
      // 별도 창(doc-*)이나 외부 도구가 저장한 새 그림이 이 창에 영영 반영되지 않는다.
      // 전역으로 지우면 다른 프로젝트의 열린 이미지까지 다시 읽는다.
      for (const pid of changedProjects) {
        void qc.invalidateQueries({ queryKey: ["dir", pid] });
        void qc.invalidateQueries({ queryKey: ["file-image", pid] });
      }
      changedProjects.clear();
    }, 250);
  });

  // ignore 캐시 재빌드 완료(tree.rs kick_ignore_refresh) — 펼쳐진 폴더의 디밍만 재검증.
  void listen<RepoChanged>("tree://ignore-ready", (e) => {
    void qc.invalidateQueries({ queryKey: ["dir", e.payload.projectId] });
  });

  // 배경 fetch 오류 발생/해소 "전이" 신호(태스크 04 §3.5) — statuses만 재조회해
  // fetchError/lastFetchAt 배지를 갱신한다. 정상 갱신은 refs 변경 → repo://changed 경로.
  void listen<RepoChanged>("repo://remote-freshness", () => {
    void qc.invalidateQueries({ queryKey: ["statuses"] });
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
