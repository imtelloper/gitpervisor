import type { Query, QueryClient } from "@tanstack/react-query";
import { focusManager } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { invalidateVideoMedia } from "../queries";
import { useOps } from "../stores/ops";
import { useUi } from "../stores/ui";
import { setSplitQueryClient, useVideoSplit } from "../stores/videoSplit";
import type { SyncOp } from "../stores/ops";
import type { RepoStatus, SttFinishedEvent, VideoExportFinished } from "./ipc";
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

/** 이 창이 시작한 자막 만들기(전사) 잡 id → 파일 이름. `stt://finished`도 모든 창에 오므로 위와 같은 이유로 거른다. */
const localSttJobs = new Map<string, string>();

/** 전사 invoke 직전에 부른다 — 완료 토스트는 이 창에서만. */
export function markLocalSttJob(id: string, fileName: string) {
  localSttJobs.set(id, fileName);
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
      invalidateVideoOutputs(qc, e.payload);
      return;
    }
    const { ok, cancelled, error, outRel } = e.payload;
    const name = outRel.split("/").pop() ?? outRel;
    if (cancelled) useUi.getState().pushToast("info", "내보내기를 취소했습니다");
    else if (ok) useUi.getState().pushToast("success", `내보내기 완료 — ${name}`);
    else useUi.getState().pushToast("error", error ?? "내보내기 실패");
    invalidateVideoOutputs(qc, e.payload);
  });

  // 자막 만들기 종결 — 결과 반영은 captionDoc 스토어가 자기 잡으로 한다. 여기는 시작한 창의 토스트만.
  void listen<SttFinishedEvent>("stt://finished", (e) => {
    const name = localSttJobs.get(e.payload.jobId);
    if (name === undefined) return;
    localSttJobs.delete(e.payload.jobId);
    const { ok, cancelled, error } = e.payload;
    if (cancelled) useUi.getState().pushToast("info", "자막 만들기를 취소했습니다");
    else if (ok) useUi.getState().pushToast("success", `자막을 만들었습니다 — ${name}`);
    else useUi.getState().pushToast("error", error ?? "자막 만들기 실패");
  });
}

/** 산출물이 워크트리에 생겼다 — 파일트리·git 상태 갱신. 덮어쓰기 내보내기로 기존
 *  미디어가 교체됐을 수 있어 staleTime Infinity인 프로브·이미지 캐시도 함께 무효화. */
function invalidateVideoOutputs(qc: QueryClient, done: VideoExportFinished) {
  void qc.invalidateQueries({ queryKey: ["dir"] });
  void qc.invalidateQueries({ queryKey: ["statuses"] });
  void qc.invalidateQueries({ queryKey: ["video-probe"] });
  void qc.invalidateQueries({ queryKey: ["file-image"] });
  invalidateVideoMedia(qc, done.projectId, (rel) => rel === done.outRel);
}

/**
 * 로고 수동 지정/해제 구독(태스크 54) — 메인(attachRepoEvents)과 모아보기 별도 창(main.tsx)이
 * 부른다. `project-logo`는 staleTime Infinity라 지정한 창 밖에서는 스스로 다시 읽지 않는다.
 */
export function attachLogoEvents(qc: QueryClient) {
  void listen<RepoChanged>("project://logo-changed", (e) => {
    void qc.invalidateQueries({ queryKey: ["project-logo", e.payload.projectId] });
  });
}

/**
 * 바뀐 프로젝트의 status 만 다시 재고 배치 캐시에 **끼워 넣는다**.
 *
 * 쿼리 키가 `["statuses", 전체 id 배열]` 하나라 무효화는 늘 전체 배치를 부른다. 여기서는
 * `get_statuses(바뀐 것)` 만 부른 뒤 결과를 캐시 배열에 병합한다 — 중첩 저장소는 부모 id 로
 * 딸려 오므로(`parentId`) 그 프로젝트에 속한 항목을 통째로 교체한다.
 *
 * 캐시가 아직 없거나(첫 로드 전) 호출이 실패하면 **예전 동작(전체 무효화)** 으로 떨어진다 —
 * 신선도가 이 최적화 때문에 나빠지지는 않게.
 */
async function refreshChangedStatuses(qc: QueryClient, pids: string[]) {
  if (!pids.length) return;
  const cached = qc.getQueriesData<RepoStatus[]>({ queryKey: ["statuses"] });
  const hasData = cached.some(([, v]) => Array.isArray(v) && v.length > 0);
  if (!hasData) {
    void qc.invalidateQueries({ queryKey: ["statuses"] });
    return;
  }
  let fresh: RepoStatus[];
  try {
    fresh = await ipc.getStatuses(pids);
  } catch {
    void qc.invalidateQueries({ queryKey: ["statuses"] });
    return;
  }
  const touched = new Set(pids);
  const mine = (s: RepoStatus) =>
    touched.has(s.projectId) || (s.parentId != null && touched.has(s.parentId));
  qc.setQueriesData<RepoStatus[]>({ queryKey: ["statuses"] }, (prev) => {
    if (!prev) return prev;
    const byId = new Map(fresh.map((s) => [s.projectId, s]));
    // 순서 유지 — 있던 자리에 새 값을 놓고, 사라진 중첩은 빠지고, 새 중첩은 뒤에 붙는다.
    const next = prev.flatMap((s) => {
      if (!mine(s)) return [s];
      const hit = byId.get(s.projectId);
      if (hit) byId.delete(s.projectId);
      return hit ? [hit] : [];
    });
    return [...next, ...byId.values()];
  });
}

/**
 * 워처 한정 무효화가 다루는 쿼리 종류 — `[종류, projectId, …]` 모양이다(queries/index.ts).
 *
 * **`diff`뿐이다.** 히스토리 계열(`log`·`branches`·`activity`·`commits-between`)은 일부러 뺐다 —
 * 그것들은 작업 트리가 아니라 `.git`(refs)에 달려 있고, `.git`은 등록된 프로젝트끼리 **공유될 수
 * 있다**: linked worktree의 커밋은 본 저장소의 `.git/refs`만 건드리므로 바뀐 id에 본 저장소만
 * 담긴다. 한정하면 워크트리 프로젝트의 히스토리·잔디가 포커스 복귀까지 조용히 낡는다(태스크 69
 * 리뷰가 잡은 회귀). 그쪽은 로그 패널·리포트가 열려 있을 때만 재조회되므로 전역으로 둬도 싸다.
 * `diff`는 뷰어가 늘 마운트돼 있어 남의 프로젝트 저장마다 git을 띄우던 자리이고, 작업 트리
 * 기준이라 이미 프로젝트 한정인 status(`refreshChangedStatuses`)와 같은 수준의 신선도다.
 * 히스토리까지 한정하려면 Rust가 `git rev-parse --git-common-dir`이 같은 프로젝트를 묶어 함께
 * emit해야 한다.
 *
 * 여기 없는 종류는 `queryKeyTouchesProject`가 **전역 무효화**(true)로 떨어뜨린다. 목록을 명시로
 * 두는 이유: `["prompts", projectPath, …]`처럼 key[1]이 id가 **아닌** 키가 같은 파일에 있어서,
 * "key[1]은 늘 projectId"로 가정하면 새 종류를 얹는 순간 조용히 영영 무효화되지 않는다.
 */
const WATCHER_SCOPED_KINDS = new Set(["diff"]);

/** 중첩 저장소 합성 id(`<outer>::<rel>`, projects.rs `project_path`) 때문에 **양방향 접두**를 본다 —
 *  바깥이 바뀌면 그 안의 중첩 쿼리도, 중첩이 바뀌면 바깥 쿼리도 낡는다. 구분자 `::`까지 붙여
 *  비교하는 이유는 맨 `startsWith`가 `"abc"`와 `"abcd"`를 한 프로젝트로 보기 때문이다. */
function sameOrNestedProject(keyProjectId: string, changedId: string): boolean {
  return (
    keyProjectId === changedId ||
    keyProjectId.startsWith(`${changedId}::`) ||
    changedId.startsWith(`${keyProjectId}::`)
  );
}

/**
 * `repo://changed` 무효화 대상 판별 — 이 쿼리 키가 바뀐 프로젝트에 걸리는가(태스크 69 §4).
 *
 * 모양을 모르는 키는 **true**(전역 무효화)로 답한다 — 잘못 무효화해서 한 번 더 읽는 것보다
 * 낡은 화면이 조용히 남는 쪽이 나쁘다.
 */
export function queryKeyTouchesProject(
  key: readonly unknown[],
  changedIds: readonly string[],
): boolean {
  const kind = key[0];
  // Quick Open 목록만 키가 `["repo-files", ...정렬된 id 목록]`이다(QuickOpenHost.tsx) —
  // 중첩 저장소 id가 그 목록에 함께 들어가므로 하나라도 걸리면 목록을 통째로 다시 읽는다.
  if (kind === "repo-files") {
    return key
      .slice(1)
      .some((v) => typeof v === "string" && changedIds.some((id) => sameOrNestedProject(v, id)));
  }
  if (typeof kind !== "string" || !WATCHER_SCOPED_KINDS.has(kind)) return true;
  const keyProjectId = key[1];
  if (typeof keyProjectId !== "string") return true;
  return changedIds.some((id) => sameOrNestedProject(keyProjectId, id));
}

/** 백엔드 이벤트 구독 — 앱 시작 시 1회. 이벤트는 신호일 뿐, 진실은 상태 재조회 (§10). */
export function attachRepoEvents(qc: QueryClient) {
  attachVideoEvents(qc);
  attachLogoEvents(qc);

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
      // **바뀐 프로젝트만 다시 잰다.** 전체 무효화는 `get_statuses(전체)` 를 부르는데, 그건
      // 레포마다 git 프로세스를 띄우는 배치다(프로젝트 21개 실측 22.5초 — status.rs 주석).
      // 파일 하나 저장할 때마다 그게 도는 구조였다. 실패하면 예전처럼 전체 무효화로 떨어진다.
      const touched = [...changedProjects];
      void refreshChangedStatuses(qc, touched);
      // `diff`도 **바뀐 프로젝트로 한정**한다(태스크 69 §4) — 뷰어는 늘 마운트돼 있어, 전역으로
      // 지우면 남의 프로젝트가 저장될 때마다 지금 열린 파일의 git diff가 다시 돈다. 히스토리
      // 계열은 predicate가 전역으로 통과시킨다(이유는 `WATCHER_SCOPED_KINDS` 주석).
      const onlyTouched = (q: Query) => queryKeyTouchesProject(q.queryKey, touched);
      void qc.invalidateQueries({ queryKey: ["diff"], predicate: onlyTouched });
      void qc.invalidateQueries({ queryKey: ["log"], predicate: onlyTouched });
      // 리포트 히트맵도 커밋을 세므로 로그와 같은 신호에 딸려 간다(태스크 60 §3.5).
      // 카드의 커밋 목록도 **함께** — 잔디만 갱신하면 카드 개수와 입력 해시가 낡은 채로 남아
      // "입력이 바뀜 — 다시 생성" 제안이 영영 안 뜬다(§1 수용 조건 3, e2e 48 ⑤가 잡았다).
      void qc.invalidateQueries({ queryKey: ["activity"], predicate: onlyTouched });
      void qc.invalidateQueries({ queryKey: ["commits-between"], predicate: onlyTouched });
      void qc.invalidateQueries({ queryKey: ["branches"], predicate: onlyTouched });
      // Quick Open 파일 목록 — 키가 `["repo-files", ...id 목록]`이라 판정이 다르다(위 함수).
      void qc.invalidateQueries({ queryKey: ["repo-files"], predicate: onlyTouched });
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

  // 백엔드가 스스로 설정을 고쳐 쓴 경우(태스크 59 — Windows Vulkan 기동 실패 시 llmBackend="cpu").
  // 알리지 않으면 열려 있는 설정 폼이 옛 값을 그대로 저장해 그 기록을 도로 덮는다.
  // 메인 창만 구독한다 — 설정 편집은 여기서만 한다.
  void listen("settings://changed", () => {
    void qc.invalidateQueries({ queryKey: ["settings"] });
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
    void qc.invalidateQueries({ queryKey: ["activity"] });
    void qc.invalidateQueries({ queryKey: ["commits-between"] }); // 카드 입력(위 주석과 같은 이유)
    void qc.invalidateQueries({ queryKey: ["branches"] });
  });
}

if (import.meta.env.DEV) {
  // e2e 48 ⑤b 가 진리표를 잰다 — 한정 무효화가 빗나가면(접두만 같은 id·합성 id 놓침) 화면에는
  // "가끔 갱신이 안 된다"로만 보여 DOM 단언으로는 잡히지 않는다. main.tsx 의 `__gpv` 대신
  // 이 모듈에 두는 이유는 `__gpvXterm`·`__gpvClipboard` 와 같다(그 파일은 저장 시 풀 리로드).
  (window as unknown as { __gpvRepoEvents?: unknown }).__gpvRepoEvents = {
    queryKeyTouchesProject,
  };
}
