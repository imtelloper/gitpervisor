import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

// 타입만 가져온다(import type) — 런타임 import가 아니라서 settings-index ↔ ui 순환이 생기지 않는다.
import type { SettingsCategory } from "../components/settings/settings-index";
import type { DiffTarget } from "../lib/ipc";
import {
  collectPanes,
  removePane,
  setRatioAt,
  splitAt,
  type Pane,
  type SplitDir,
} from "../lib/pane-tree";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  message: string;
  /** 선택 액션 버튼(예: "설정 열기") — 클릭 시 실행 + 토스트 닫힘. */
  action?: { label: string; run: () => void };
}

export interface ToastOptions {
  /** 자동 소멸까지 ms. 기본 6000. `null`이면 사용자가 X로 닫을 때까지 유지. */
  durationMs?: number | null;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  detail?: string; // 본문 아래 모노스페이스 박스(경로 등 — 줄바꿈 보존)
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  /** 취소·배경 클릭으로 닫혔을 때. 확인 시에는 호출되지 않는다. */
  onCancel?: () => void;
}

export interface PromptRequest {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** 입력값 검증 — 오류 메시지를 반환하면 확인이 막힌다(null이면 통과). */
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
}

/** 선택 텍스트 번역 카드 요청(태스크 61) — x·y는 카드를 띄울 메뉴 좌표. */
export interface TranslateRequest {
  /** 번역할 원문 — 8,000자로 이미 잘려 들어온다(lib/translate.ts translateRequest). */
  text: string;
  x: number;
  y: number;
  /** 원문이 잘렸는가 — 카드가 "잘림" 뱃지를 보인다. */
  truncated: boolean;
}

/**
 * 뷰어에 열린 파일 탭 하나 — 같은 파일이라도 모드(diff/파일)가 다르면 별개 탭.
 * 탭은 **패널 소속**이다 — 같은 파일을 두 패널에 열면 탭도 둘(신원 = paneId + key).
 */
export interface ViewerFileTab {
  key: string;
  /** 이 탭이 붙은 뷰어 패널(`viewerLayout`의 리프) */
  paneId: string;
  /** 이 탭이 속한(뷰어에 표시되는) 프로젝트 id */
  outerId: string;
  /** 임베디드 저장소 라우팅용 합성 id (없으면 null → outer) */
  repoId: string | null;
  target: DiffTarget;
}

/** 탭 동일성 키 — file 모드의 line은 제외(같은 파일 내 이동은 기존 탭 재사용). */
export function viewerTabKey(
  target: DiffTarget,
  repoId: string | null,
  outerId: string,
): string {
  const sha = target.mode === "commit" ? target.sha : "";
  return `${repoId ?? outerId}|${target.mode}|${target.path}|${sha}`;
}

/** 모아보기 자동배치 모드 — grid(2×2·3×3 …) / columns(좌우 한 줄, 최대 4열). */
export type AggregateLayout = "grid" | "columns";

/** 뷰어 분할 트리의 리프 payload — 무엇을 보여줄지는 리프가 아니라 viewerByPane이 쥔다(§3.2). */
export interface ViewerLeaf {
  paneId: string;
}

/** 한 뷰어 패널이 보고 있는 대상. */
export interface ViewerPaneTarget {
  target: DiffTarget;
  repoId: string | null;
}

/**
 * 뷰어 분할 상한. Monaco는 인스턴스당 비용이 커서 터미널처럼 무제한으로 두지 않는다 —
 * 4분할이면 "나란히 보기"는 충족된다.
 * ponytail: 상한 4 — 실사용에서 부족하면 이 상수만 올린다.
 */
export const VIEWER_MAX_PANES = 4;

export interface UiState {
  selectedProjectId: string | null;
  /**
   * **활성 뷰어 패널이 보고 있는 대상의 미러**(태스크 64). 단일 진실은
   * `viewerByPane[viewerActivePaneId]`이고, 읽는 쪽은 `selectActiveDiff`를 쓴다.
   * 쓰는 곳은 전부 아래 `writeActivePane`/`mirror` 한 군데를 지난다.
   */
  selectedDiff: DiffTarget | null;
  /**
   * selectedDiff를 조회할 저장소 id. 임베디드(중첩) 저장소의 파일을 클릭하면 그 저장소의
   * 합성 id(`<outer>::<rel>`)가 들어와 diff/편집이 중첩 저장소를 대상으로 라우팅된다.
   * null이면 현재 선택 프로젝트(outer)를 쓴다.
   */
  selectedDiffRepoId: string | null;
  /** 뷰어 분할 레이아웃(기본 = 리프 1개). 터미널 탭과 **같은 트리**를 쓴다(lib/pane-tree.ts). */
  viewerLayout: Pane<ViewerLeaf>;
  /** 포커스된 뷰어 패널 — selectDiff의 라우팅 대상이자 파일 탭 바·단축키의 기준. */
  viewerActivePaneId: string;
  /** 설정 시 그 패널만 전체 표시(전이 상태 — 영속하지 않는다). */
  viewerMaximizedPaneId: string | null;
  /** 패널별로 무엇을 보고 있나. 없거나 null이면 빈 패널("파일을 선택하세요"). */
  viewerByPane: Record<string, ViewerPaneTarget | null>;
  /**
   * 뷰어에 열린 파일 탭들(PyCharm식) — selectDiff로 연 대상이 **활성 패널에** 쌓이고,
   * go-to-definition으로 점프해도 이전 파일이 탭으로 남아 되돌아갈 수 있다.
   * 패널(paneId)·프로젝트(outerId)로 필터해 각 패널 위에 표시한다.
   */
  viewerTabs: ViewerFileTab[];
  /**
   * 프로젝트별 "마지막 활성 파일" — 프로젝트를 오갈 때 보던 파일로 복원한다(selectedDiff는
   * 전역 단일값이라 전환 시 리셋되므로). selectDiff에서 갱신, selectProject에서 복원.
   */
  activeDiffByProject: Record<string, { target: DiffTarget; repoId: string | null }>;
  /** 하단 Log 패널 펼침 여부 */
  logOpen: boolean;
  /** 하단 Log 패널 펼침 높이(px) — 드래그로 조절, localStorage 영속 */
  logHeight: number;
  /** 터미널 모아보기(여러 터미널 한 화면 분할) 모드 */
  aggregateOpen: boolean;
  /** 모아보기가 **별도 창**으로 떠 있는가 — 그 창이 PTY 출력을 가져가므로(소비자 1개) 메인 창은
   *  터미널 패널을 접고 "다른 창에서 표시 중"으로 알린다. 전이 상태, 영속 없음. */
  aggregateWindowOpen: boolean;
  setAggregateWindowOpen: (open: boolean) => void;
  /**
   * 모아보기 그리드 트랙 크기 — 셀 개수(n)별로 행 높이(rows)와 "행마다 독립적인" 셀 폭
   * (cols[r] = r행의 fr 배열)을 기억한다. 가로 드래그는 같은 행 이웃과만 재분배하므로
   * 다른 행의 폭에 영향이 없고, 재분배(총합 불변)라 셀이 화면 밖으로 밀려나지 않는다.
   * 여닫아도 유지되게 localStorage 영속. fr은 상대값이라 창 크기가 변해도 비율 유지.
   */
  aggregateTracks: Record<string, { rows: number[]; cols: number[][] }>;
  /** 모아보기 칩 바에서 같은 프로젝트의 탭을 칩 하나로 묶어 표시 (localStorage 영속) */
  aggregateGroupTabs: boolean;
  toggleAggregateGroupTabs: () => void;
  /** 모아보기 자동배치 모드 — grid(2×2·3×3 …) / columns(좌우 한 줄, 최대 4열). localStorage 영속 */
  aggregateLayout: AggregateLayout;
  setAggregateLayout: (mode: AggregateLayout) => void;
  /** 작업 리포트(잔디 + 기간 요약) 전체 뷰 — 모아보기와 같은 층. 세션 상태, 영속 없음(태스크 60).
   *  모아보기가 열려 있으면 뜻이 바뀐다: 모아보기 헤더에 **리포트 탭이 있다**. */
  reportOpen: boolean;
  /** 모아보기 안에서 리포트 탭이 **앞에** 있다(그리드 위를 덮어 리포트 한 페이지를 보인다).
   *  reportOpen 이 참일 때만 뜻이 있다. 모아보기를 닫으면 풀린다. */
  aggregateReportActive: boolean;
  /** 리포트 버튼. 모아보기 밖: 열기/닫기. 모아보기 안: 탭을 만들어 앞으로, 이미 앞이면 터미널로. */
  toggleReport: () => void;
  setAggregateReportActive: (active: boolean) => void;
  /** 리포트 탭 닫기(모아보기 헤더의 X). */
  closeReport: () => void;
  /** Log 패널에서 선택된 커밋 (상세 패널 구동) */
  selectedCommitSha: string | null;
  /** 설정 모달 열림 여부 */
  settingsOpen: boolean;
  /** 설정 모달이 다음에 열릴 때 처음 보여줄 카테고리(1회성 — SettingsDialog가 소비 후 null). */
  settingsCategory: SettingsCategory | null;
  /** Quick Open(파일 퍼지 검색 모달) 열림 여부 — 세션 상태, 영속 없음 */
  quickOpenOpen: boolean;
  /** Go to Symbol(전역 심볼 검색 모달) 열림 여부 */
  symbolSearchOpen: boolean;
  /** 메모 팝오버 열림 여부 (현재 선택 프로젝트) */
  memoOpen: boolean;
  /** diff 뷰어: 변경 없는 영역 접기 (기본 접기, 끄면 전체 펼침) */
  diffCollapseUnchanged: boolean;
  /** 파일 트리 패널 표시 여부 (localStorage 영속) */
  fileTreeOpen: boolean;
  /** PROJECTS: 변경/활동 있는 프로젝트를 위로 정렬 (localStorage 영속) */
  projectSortByChanges: boolean;
  /** PROJECTS: 프로젝트별 색 구분(행 배경 틴트 + 좌측 스트라이프) 표시 (localStorage 영속).
   *  기본 켜짐 — 끄면 목록이 단색이 되어 상태 점·로고만 남는다. */
  projectColorsOn: boolean;
  /** 이미지 편집기 대상(레포 상대 경로) — 열려 있으면 모달 표시 */
  imageEditorPath: string | null;
  /**
   * 이미지 편집기가 읽고 쓸 저장소 id. 임베디드 저장소 파일이면 그 저장소의 합성 id
   * (`<outerId>::<rel>`), 아니면 null(선택 프로젝트로 라우팅).
   *
   * 경로만으로는 어느 레포 기준인지 알 수 없다 — 이게 없으면 중첩 저장소 안 이미지를
   * **바깥 레포 루트 기준 상대경로로 써서 엉뚱한 파일을 만든다**(설계 D1).
   */
  imageEditorRepoId: string | null;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  selectProject: (id: string | null) => void;
  selectDiff: (target: DiffTarget | null, repoId?: string | null) => void;
  /**
   * 활성 뷰어 탭의 대상을 **제자리에서** 바꾼다 — 탭 수가 늘지 않는다(이미지 뷰어 ↑/↓ 내비게이션).
   * selectDiff는 키가 다르면 탭을 추가하므로 이미지 50장을 넘기면 탭도 50개가 된다.
   * 저장소 라우팅(repoId)은 현재 것을 그대로 쓴다 — 같은 폴더 안에서의 이동이기 때문.
   */
  replaceDiff: (target: DiffTarget) => void;
  /**
   * 뷰어 파일 탭 닫기 — 그 패널이 보던 탭이면 이웃 탭으로 전환(없으면 선택 해제).
   * 분할 중에 패널의 마지막 탭을 닫으면 패널도 닫는다. paneId를 안 주면 활성 패널의 탭,
   * 거기 없으면 그 키의 첫 탭(e2e 정리 루프가 키만 넘긴다).
   */
  closeViewerTab: (key: string, paneId?: string) => void;
  /** 뷰어 패널 분할 — 새 패널이 활성이 된다(비어 있는 상태로). 상한(4) 도달 시 무시. */
  splitViewerPane: (paneId: string, dir: SplitDir, newFirst: boolean) => void;
  /** 뷰어 패널 닫기(그 패널의 탭도 함께) — 마지막 하나는 닫지 않는다(빈 화면이 되지 않게). */
  closeViewerPane: (paneId: string) => void;
  /** 활성 뷰어 패널 전환 — selectDiff·탭 바·변경 목록 강조가 이 패널을 따라간다. */
  setViewerActivePane: (paneId: string) => void;
  toggleViewerMaximize: (paneId: string) => void;
  setViewerRatio: (splitId: string, ratio: number) => void;
  /** 프로젝트 제거 시 그 프로젝트의 뷰어 탭·활성 파일 정리(고아 방지). */
  closeProjectViewerTabs: (projectId: string) => void;
  /**
   * 파일/폴더 이름 바꾸기 후 그 프로젝트의 뷰어 경로(탭·활성 파일·선택 diff)를 새 경로로 옮긴다.
   * 안 하면 열려 있던 탭이 사라진 옛 경로를 가리켜 "불러오지 못함"만 뜬다.
   */
  renameViewerPaths: (projectId: string, from: string, to: string) => void;
  toggleLog: () => void;
  setLogHeight: (h: number) => void;
  setAggregateOpen: (open: boolean) => void;
  toggleAggregate: () => void;
  /** 모아보기 그리드 트랙 저장(+영속). 경계 드래그 중 실시간 호출. */
  setAggregateTracks: (
    shape: string,
    tracks: { rows: number[]; cols: number[][] },
  ) => void;
  selectCommit: (sha: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  /** 설정 열기 + 선택적 카테고리 딥링크. setSettingsOpen(true)의 상위 호환. */
  openSettings: (category?: SettingsCategory) => void;
  setQuickOpenOpen: (open: boolean) => void;
  setSymbolSearchOpen: (open: boolean) => void;
  setMemoOpen: (open: boolean) => void;
  toggleDiffCollapse: () => void;
  toggleFileTree: () => void;
  toggleProjectSort: () => void;
  toggleProjectColors: () => void;
  pushToast: (
    kind: Toast["kind"],
    message: string,
    action?: Toast["action"],
    opts?: ToastOptions,
  ) => void;
  dismissToast: (id: number) => void;
  askConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
  askPrompt: (req: PromptRequest) => void;
  closePrompt: () => void;
  /** repoId: 임베디드 저장소 파일이면 그 저장소의 합성 id(생략하면 선택 프로젝트로 라우팅). */
  openImageEditor: (path: string, repoId?: string) => void;
  closeImageEditor: () => void;
  /** 터미널 세션 헤더의 Git 버튼이 여는 변경·로그 모달 대상(태스크 55). null = 닫힘. */
  gitDialog: { projectId: string; tab?: "changes" | "log" } | null;
  /** tab 을 주면 그 탭으로 연다(사이드바 우클릭 → git log). 생략하면 기존대로 변경 탭. */
  openGitDialog: (projectId: string, tab?: "changes" | "log") => void;
  closeGitDialog: () => void;
  /** 터미널 세션 헤더의 파일 트리 버튼이 여는 파일 트리 모달 대상(태스크 62). null = 닫힘. */
  fileTreeDialog: { projectId: string } | null;
  openFileTreeDialog: (projectId: string) => void;
  closeFileTreeDialog: () => void;
  /**
   * 선택 텍스트 번역 카드(태스크 61). null = 닫힘.
   * **selectBlockingOverlay에는 넣지 않는다** — 화면을 덮지 않는 카드라, 점유는 TranslateHost가
   * useOccludesWebview로 등록한다(26 호버 카드와 같은 층).
   */
  translate: TranslateRequest | null;
  openTranslate: (req: TranslateRequest) => void;
  closeTranslate: () => void;
}

let toastSeq = 0;

// 뷰어 탭 + 프로젝트별 활성 파일 영속(재시작 후 복원). 프로젝트 전환 시엔 store가 그대로 유지되고,
// 재시작 시 이 loader가 localStorage에서 복원한다. worktree/index 대상은 재시작 후 stale일 수 있으나
// DiffViewer가 없는/안 바뀐 파일을 무해하게 처리한다(사용자가 닫으면 됨).
const VIEWER_KEY = "gp:viewer-tabs";

/** 영속 레이아웃 검증 — 손상 값은 throw 하지 않고 기본(단일 리프)으로 강등한다. */
function isViewerPane(v: unknown): v is Pane<ViewerLeaf> {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n.kind === "leaf") return typeof n.paneId === "string";
  return (
    n.kind === "split" &&
    typeof n.id === "string" &&
    (n.dir === "row" || n.dir === "col") &&
    typeof n.ratio === "number" &&
    isViewerPane(n.a) &&
    isViewerPane(n.b)
  );
}

/** 패널 상태가 없거나 손상됐을 때의 기본 — 빈 리프 하나. */
function freshViewerPanes(): Pick<
  UiState,
  "viewerLayout" | "viewerActivePaneId" | "viewerByPane"
> {
  const paneId = crypto.randomUUID();
  return {
    viewerLayout: { kind: "leaf", paneId },
    viewerActivePaneId: paneId,
    viewerByPane: {},
  };
}

function loadPersistedViewer(): {
  viewerTabs: ViewerFileTab[];
  activeDiffByProject: UiState["activeDiffByProject"];
} & Pick<UiState, "viewerLayout" | "viewerActivePaneId" | "viewerByPane"> {
  try {
    const raw = localStorage.getItem(VIEWER_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object")
      return { viewerTabs: [], activeDiffByProject: {}, ...freshViewerPanes() };
    // 레이아웃과 활성 패널은 짝이어야 한다 — 활성 id가 트리에 없으면 통째로 기본값으로.
    const layout = isViewerPane(p.viewerLayout) ? p.viewerLayout : null;
    const paneOk =
      layout !== null &&
      typeof p.viewerActivePaneId === "string" &&
      collectPanes(layout).includes(p.viewerActivePaneId);
    const panes = paneOk
      ? {
          viewerLayout: layout,
          viewerActivePaneId: p.viewerActivePaneId as string,
          viewerByPane:
            p.viewerByPane && typeof p.viewerByPane === "object" ? p.viewerByPane : {},
        }
      : freshViewerPanes();
    // 패널 소속이 없는 탭(패널별 탭 이전 영속)·트리에 없는 패널의 탭은 활성 패널로 모은다.
    // 모으다 같은 (패널, 키)가 겹치면 앞의 것만 — React 키 충돌·중복 탭 방지.
    const paneIds = collectPanes(panes.viewerLayout);
    const seen = new Set<string>();
    const viewerTabs = (Array.isArray(p.viewerTabs) ? p.viewerTabs : []).flatMap(
      (t: ViewerFileTab) => {
        const paneId = paneIds.includes(t.paneId) ? t.paneId : panes.viewerActivePaneId;
        if (seen.has(`${paneId}|${t.key}`)) return [];
        seen.add(`${paneId}|${t.key}`);
        return [{ ...t, paneId }];
      },
    );
    return {
      viewerTabs,
      activeDiffByProject:
        p.activeDiffByProject && typeof p.activeDiffByProject === "object"
          ? p.activeDiffByProject
          : {},
      ...panes,
    };
  } catch {
    return { viewerTabs: [], activeDiffByProject: {}, ...freshViewerPanes() };
  }
}
const persistedViewer = loadPersistedViewer();
// 재시작 시 초기 선택 프로젝트의 마지막 활성 파일도 복원(전환 복원과 동일 경험).
const initialProjectId = localStorage.getItem("gp:selected-project");
const initialActive = initialProjectId
  ? persistedViewer.activeDiffByProject[initialProjectId]
  : null;
// 패널별 파일도 그대로 복원한다. 구버전 영속(패널 기록 없음)에서 올라왔으면 마지막 활성
// 파일을 단일 패널에 시드해 지금까지의 복원 동작을 그대로 유지한다.
const initialByPane: UiState["viewerByPane"] =
  persistedViewer.viewerByPane[persistedViewer.viewerActivePaneId] !== undefined
    ? persistedViewer.viewerByPane
    : {
        ...persistedViewer.viewerByPane,
        [persistedViewer.viewerActivePaneId]: initialActive ?? null,
      };
const initialEntry = initialByPane[persistedViewer.viewerActivePaneId] ?? null;

/**
 * 화면 전체를 덮는 차단성 모달이 열려 있는가 — 네이티브 자식 webview 점유 판정용
 * (stores/occlusion.ts가 이것과 useDb.dialog, 로컬 메뉴 카운터를 합쳐 최종 판정한다).
 *
 * **계약**: 전체 화면을 덮는 모달 상태를 위에 추가하면 여기에도 넣어라. 안 그러면 그 모달이
 * 네이티브 webview 뒤에 가려 보이지 않는다(이 목록이 낡아 실제로 발생한 버그다).
 * **토스트는 넣지 않는다** — 비차단·자동소멸이라 넣으면 배경 에러 토스트마다 페이지가
 * 깜빡인다(browser-feature-design §4B의 명시적 결정).
 */
export const selectBlockingOverlay = (s: UiState): boolean =>
  s.settingsOpen ||
  s.memoOpen ||
  s.quickOpenOpen ||
  s.symbolSearchOpen ||
  !!s.imageEditorPath ||
  !!s.gitDialog ||
  !!s.fileTreeDialog ||
  !!s.confirm ||
  !!s.prompt;

/**
 * **지금 보고 있는 파일** = 활성 뷰어 패널이 보는 것(태스크 64 §3.2).
 * 읽는 쪽(변경 목록 강조·파일 탭 바·심볼 검색 힌트 …)은 전부 이걸 쓴다.
 */
export const selectActiveDiff = (s: UiState): ViewerPaneTarget | null =>
  s.viewerByPane[s.viewerActivePaneId] ?? null;

/** 활성 패널이 바뀌었을 때의 selectedDiff 미러 값. */
const mirror = (e: ViewerPaneTarget | null) => ({
  selectedDiff: e?.target ?? null,
  selectedDiffRepoId: e?.repoId ?? null,
});

/**
 * 패널에 대상을 쓴다 — `selectDiff` 계열의 **유일한** 기록 경로.
 * selectedDiff/selectedDiffRepoId는 활성 패널에 쓸 때만 따라 움직이는 미러다(위 필드 주석).
 */
function writePane(
  s: UiState,
  paneId: string,
  target: DiffTarget | null,
  repoId: string | null,
): Partial<UiState> {
  const entry = target ? { target, repoId } : null;
  return {
    ...(paneId === s.viewerActivePaneId && mirror(entry)),
    viewerByPane: { ...s.viewerByPane, [paneId]: entry },
  };
}

const writeActivePane = (s: UiState, target: DiffTarget | null, repoId: string | null) =>
  writePane(s, s.viewerActivePaneId, target, repoId);

/**
 * 패널 하나를 트리에서 뗀다 — 패널 메뉴 "닫기"와 "마지막 탭 닫기"가 같이 쓴다. 마지막 한 칸이면 null.
 * 그 패널의 **현재 프로젝트** 탭은 함께 닫는다(탭 바가 패널 위에 붙어 있으니 같이 사라지는 게 보이는
 * 그대로다). 다른 프로젝트 탭은 지금 보이지도 않으므로 남는 활성 패널로 옮긴다 — 말없이 잃지 않게.
 */
function dropViewerPane(s: UiState, paneId: string): Partial<UiState> | null {
  const layout = removePane(s.viewerLayout, paneId);
  if (!layout) return null;
  const remaining = collectPanes(layout);
  const viewerByPane = { ...s.viewerByPane };
  delete viewerByPane[paneId];
  const active = remaining.includes(s.viewerActivePaneId)
    ? s.viewerActivePaneId
    : remaining[remaining.length - 1];
  const keysInActive = new Set(
    s.viewerTabs.filter((t) => t.paneId === active).map((t) => t.key),
  );
  const viewerTabs = s.viewerTabs.flatMap((t) =>
    t.paneId !== paneId
      ? [t]
      : t.outerId === s.selectedProjectId || keysInActive.has(t.key)
        ? []
        : [{ ...t, paneId: active }],
  );
  // 프로젝트별 "마지막 활성 파일"이 닫힌 패널의 파일을 가리키지 않게 남은 활성 패널 것으로.
  const pid = s.selectedProjectId;
  const now = viewerByPane[active] ?? null;
  const activeDiffByProject = { ...s.activeDiffByProject };
  if (pid && now) activeDiffByProject[pid] = now;
  else if (pid) delete activeDiffByProject[pid];
  return {
    viewerLayout: layout,
    viewerByPane,
    viewerTabs,
    activeDiffByProject,
    viewerActivePaneId: active,
    viewerMaximizedPaneId:
      s.viewerMaximizedPaneId && remaining.includes(s.viewerMaximizedPaneId)
        ? s.viewerMaximizedPaneId
        : null,
    ...mirror(now),
  };
}

/** 모아보기 **별도 창**인가 — 그 창엔 aggregateOpen 이 없어도 화면이 곧 모아보기다(toggleReport).
 *  stores/terminals 의 IS_AGGREGATE_WINDOW 와 같은 판정인데, 거기를 정적으로 import 하면
 *  ui → terminals → lib/terminal → ui 순환이라 여기서 라벨을 직접 본다(SKIP_VIEWER_PERSIST 와 같은 방식). */
const IN_AGGREGATE_WINDOW = (() => {
  try {
    return getCurrentWebviewWindow().label === "aggregate";
  } catch {
    return false;
  }
})();

export const useUi = create<UiState>((set) => ({
  // 마지막 선택 프로젝트를 복원한다 — 재시작 시 그 프로젝트(+복구된 터미널 탭)로 바로 진입
  selectedProjectId: initialProjectId,
  selectedDiff: initialEntry?.target ?? null,
  selectedDiffRepoId: initialEntry?.repoId ?? null,
  viewerLayout: persistedViewer.viewerLayout,
  viewerActivePaneId: persistedViewer.viewerActivePaneId,
  viewerMaximizedPaneId: null,
  viewerByPane: initialByPane,
  viewerTabs: persistedViewer.viewerTabs,
  activeDiffByProject: persistedViewer.activeDiffByProject,
  logOpen: false,
  logHeight: (() => {
    const raw = Number(localStorage.getItem("gp:log-height"));
    return raw >= 120 ? raw : 288; // 기본 288px(기존 h-72)
  })(),
  aggregateOpen: false,
  aggregateWindowOpen: false,
  aggregateTracks: (() => {
    try {
      // 구버전(셀별 px — 셀이 그리드 밖으로 밀려나던 방식) 키는 더 안 쓰므로 정리
      localStorage.removeItem("gp:aggregate-sizes");
      const p = JSON.parse(localStorage.getItem("gp:aggregate-tracks") || "null");
      // 포맷이 구버전(cols 1차원)이어도 그대로 들고 있는다 — 컴포넌트가 행 구조 검증에
      // 실패하면 균등 분할로 폴백하고, 다음 드래그에서 새 포맷으로 덮어쓴다.
      return p && typeof p === "object"
        ? (p as Record<string, { rows: number[]; cols: number[][] }>)
        : {};
    } catch {
      return {};
    }
  })(),
  aggregateGroupTabs: localStorage.getItem("gp:aggregate-group-tabs") === "1",
  // 알 수 없는 값(없음·구버전)은 grid — 기존 동작이 기본이다.
  aggregateLayout:
    localStorage.getItem("gp:aggregate-layout") === "columns" ? "columns" : "grid",
  reportOpen: false,
  aggregateReportActive: false,
  selectedCommitSha: null,
  settingsOpen: false,
  settingsCategory: null,
  quickOpenOpen: false,
  symbolSearchOpen: false,
  memoOpen: false,
  diffCollapseUnchanged: true,
  // 파일 트리는 기본 열림 — 사용자가 명시적으로 닫은 경우("0")만 닫힌 채 복원
  fileTreeOpen: localStorage.getItem("gp:filetree-open") !== "0",
  projectSortByChanges: localStorage.getItem("gp:project-sort-changes") === "1",
  // 기본값이 **켜짐**이라 `=== "1"`이 아니라 `!== "0"`이다 — 저장된 적 없으면(null) 켜져야 한다.
  projectColorsOn: localStorage.getItem("gp:project-colors") !== "0",
  imageEditorPath: null,
  imageEditorRepoId: null,
  toasts: [],
  confirm: null,
  prompt: null,
  // 프로젝트 전환 시 diff·커밋 선택은 초기화하되 Log 패널 펼침 상태는 유지
  selectProject: (id) => {
    if (id) localStorage.setItem("gp:selected-project", id);
    else localStorage.removeItem("gp:selected-project");
    set((s) => {
      // 이 프로젝트에서 마지막에 보던 파일로 복원(없으면 null). 전역 selectedDiff가 프로젝트별로
      // 기억되는 효과. 워크스페이스 뷰(viewer/db/terminal)는 terminals.activeTab이 별도로 복원.
      const restored = id ? s.activeDiffByProject[id] : null;
      // 패널이 들고 있던 파일은 **이전 프로젝트**의 것이다 — 그대로 두면 새 프로젝트 기준으로 경로가
      // 풀려 엉뚱한 파일을 그린다. 패널마다 **이 프로젝트에서 그 패널에 열려 있던 탭**으로 되돌린다:
      // 마지막 활성 파일이 그 패널 탭에 있으면 그것, 아니면 그 패널의 마지막 탭. 탭이 없으면 빈
      // 패널(레이아웃은 유지)이고, 활성 패널만은 탭이 없어도 마지막 활성 파일을 복원한다(예전 동작).
      const restoredKey = id && restored ? viewerTabKey(restored.target, restored.repoId, id) : null;
      const viewerByPane: UiState["viewerByPane"] = {};
      for (const pane of collectPanes(s.viewerLayout)) {
        const tabs = s.viewerTabs.filter((t) => t.paneId === pane && t.outerId === id);
        const pick = tabs.find((t) => t.key === restoredKey) ?? tabs[tabs.length - 1];
        viewerByPane[pane] = pick
          ? { target: pick.target, repoId: pick.repoId }
          : pane === s.viewerActivePaneId
            ? (restored ?? null)
            : null;
      }
      return {
        selectedProjectId: id,
        ...mirror(viewerByPane[s.viewerActivePaneId] ?? null),
        viewerByPane,
        selectedCommitSha: null,
        memoOpen: false,
        // 이미지 편집기는 프로젝트별 상대 경로라 프로젝트가 바뀌면 닫는다(엉뚱한 프로젝트에 쓰기 방지).
        // repoId도 함께 지운다 — 안 지우면 다음 편집이 스테일 repoId를 물고 간다(설계 §7.2).
        imageEditorPath: null,
        imageEditorRepoId: null,
      };
    });
  },
  // repoId: 임베디드 저장소 파일이면 그 저장소의 합성 id, 아니면 생략(outer로 라우팅).
  // 대상을 뷰어 탭으로도 업서트한다 — 같은 키의 탭이 있으면 target만 갱신(file 모드의
  // line 이동이 기존 탭에서 일어나게), 없으면 뒤에 추가. null은 선택만 해제(탭 유지).
  //
  // **라우팅은 여기 한 곳에서 한다**(태스크 64 §3.3) — 파일을 여는 호출부 11곳(변경 목록·트리·
  // 검색·심볼·QuickOpen·정의 이동·탭 바·단축키)은 그대로 두고, 대상은 **활성 패널**로 간다.
  selectDiff: (target, repoId) =>
    set((s) => {
      if (!target) return writeActivePane(s, null, null);
      const outerId = s.selectedProjectId;
      // 모아보기 중 파일을 열면(사이드바 트리·퀵오픈·심볼검색·정의 이동) 모아보기를 닫고
      // 그 프로젝트를 뷰어 탭으로 전환한다 — 안 그러면 연 파일이 모아보기에 가려 안 보인다.
      // 동적 import: 정적으로 걸면 ui→terminals→lib/terminal→ui 순환이라 시작 시 TDZ 위험.
      if (s.aggregateOpen && outerId)
        void import("./terminals").then((m) =>
          m.useTerminals.getState().setActiveTab(outerId, "viewer"),
        );
      const closeAggregate = s.aggregateOpen;
      // 리포트 뷰도 같은 층이라 같이 닫는다 — 안 그러면 연 파일이 리포트에 가려 안 보인다.
      const closeReport = s.reportOpen;
      if (!outerId)
        return {
          ...writeActivePane(s, target, repoId ?? null),
          ...(closeAggregate && { aggregateOpen: false }),
          ...(closeReport && { reportOpen: false, aggregateReportActive: false }),
        };
      const key = viewerTabKey(target, repoId ?? null, outerId);
      const paneId = s.viewerActivePaneId;
      const tab: ViewerFileTab = { key, paneId, outerId, repoId: repoId ?? null, target };
      const idx = s.viewerTabs.findIndex((t) => t.key === key && t.paneId === paneId);
      return {
        ...(closeAggregate && { aggregateOpen: false }),
        ...(closeReport && { reportOpen: false, aggregateReportActive: false }),
        ...writeActivePane(s, target, repoId ?? null),
        // 프로젝트별 "마지막 활성 파일" 갱신 — 전환 후 복귀 시 이 파일로 돌아온다.
        activeDiffByProject: {
          ...s.activeDiffByProject,
          [outerId]: { target, repoId: repoId ?? null },
        },
        viewerTabs:
          idx >= 0
            ? s.viewerTabs.map((t, i) => (i === idx ? tab : t))
            : [...s.viewerTabs, tab],
      };
    }),
  // 활성 탭의 대상만 갈아 끼운다(탭 수 불변). 이미 열려 있던 대상으로 돌아가면 그 탭을 제거해
  // 탭 바에 같은 파일이 둘 생기지 않게 한다. 활성 대상이 없으면 아무것도 하지 않는다.
  replaceDiff: (target) =>
    set((s) => {
      const cur = selectActiveDiff(s);
      const repoId = cur?.repoId ?? null;
      const outerId = s.selectedProjectId;
      if (!outerId || !cur) return {};
      const oldKey = viewerTabKey(cur.target, repoId, outerId);
      const key = viewerTabKey(target, repoId, outerId);
      const paneId = s.viewerActivePaneId;
      const tab: ViewerFileTab = { key, paneId, outerId, repoId, target };
      const i = s.viewerTabs.findIndex((t) => t.key === oldKey && t.paneId === paneId);
      const dup = s.viewerTabs.findIndex((t) => t.key === key && t.paneId === paneId);
      return {
        ...writeActivePane(s, target, repoId),
        activeDiffByProject: {
          ...s.activeDiffByProject,
          [outerId]: { target, repoId },
        },
        viewerTabs:
          i < 0
            ? [...s.viewerTabs, tab]
            : s.viewerTabs
                .map((t, j) => (j === i ? tab : t))
                .filter((_, j) => !(dup >= 0 && dup !== i && j === dup)),
      };
    }),
  closeViewerTab: (key, paneId) =>
    set((s) => {
      const closing =
        s.viewerTabs.find(
          (t) => t.key === key && t.paneId === (paneId ?? s.viewerActivePaneId),
        ) ?? (paneId ? undefined : s.viewerTabs.find((t) => t.key === key));
      if (!closing) return s;
      const pane = closing.paneId;
      const viewerTabs = s.viewerTabs.filter((t) => t !== closing);
      // 같은 패널·같은 프로젝트의 탭들 — 이 패널 탭 바에 보이는 목록이다.
      const sibsBefore = s.viewerTabs.filter(
        (t) => t.paneId === pane && t.outerId === closing.outerId,
      );
      const sibs = sibsBefore.filter((t) => t !== closing);
      // 분할 중에 패널의 마지막 탭을 닫으면 패널도 닫는다(VS Code 편집기 그룹과 같다).
      // 마지막 한 칸이면 dropViewerPane이 null — 아래로 내려가 빈 패널이 된다.
      if (sibs.length === 0 && closing.outerId === s.selectedProjectId) {
        const dropped = dropViewerPane({ ...s, viewerTabs }, pane);
        if (dropped) return dropped;
      }
      const cur = s.viewerByPane[pane];
      const showing =
        !!cur &&
        closing.outerId === s.selectedProjectId &&
        viewerTabKey(cur.target, cur.repoId, closing.outerId) === key;
      if (!showing) return { viewerTabs };
      // 그 패널이 보던 탭을 닫음 — 같은 패널의 이웃(원래 자리, 없으면 마지막) 탭으로 전환
      const next = sibs[Math.min(sibsBefore.indexOf(closing), sibs.length - 1)] ?? null;
      // 프로젝트별 활성 파일은 활성 패널 기준이다 — 복원 값이 닫힌 탭을 가리키지 않게 이웃으로(없으면 제거).
      const activeDiffByProject = { ...s.activeDiffByProject };
      if (pane === s.viewerActivePaneId) {
        if (next) activeDiffByProject[closing.outerId] = { target: next.target, repoId: next.repoId };
        else delete activeDiffByProject[closing.outerId];
      }
      return {
        viewerTabs,
        ...writePane(s, pane, next?.target ?? null, next?.repoId ?? null),
        activeDiffByProject,
      };
    }),
  closeProjectViewerTabs: (projectId) =>
    set((s) => {
      const activeDiffByProject = { ...s.activeDiffByProject };
      delete activeDiffByProject[projectId];
      return {
        viewerTabs: s.viewerTabs.filter((t) => t.outerId !== projectId),
        activeDiffByProject,
      };
    }),
  renameViewerPaths: (projectId, from, to) =>
    set((s) => {
      // 이름 바꾼 항목 자신(정확 일치)과 그 하위(`from/` 접두)만 옮긴다 — 대상이 아니면 null.
      const mapPath = (p: string): string | null =>
        p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null;
      // 임베디드(중첩) 저장소로 라우팅된 대상의 path는 **그 저장소** 기준이라 outer 경로(from/to)로
      // 매핑하면 엉뚱한 경로가 된다 — outer의 `src`를 바꿨는데 중첩 저장소의 `src/…` 탭이 딸려간다.
      // repoId가 없거나 outer 자신일 때만 outer 상대 경로다(viewerTabKey의 `repoId ?? outerId`와 동일 규칙).
      const isOuterRel = (repoId: string | null) =>
        repoId === null || repoId === projectId;
      let tabsChanged = false;
      const seen = new Set<string>();
      const viewerTabs: ViewerFileTab[] = [];
      for (const t of s.viewerTabs) {
        const next =
          t.outerId === projectId && isOuterRel(t.repoId)
            ? mapPath(t.target.path)
            : null;
        if (next === null) {
          // 이관된 탭이 같은 패널에서 이 탭의 키를 이미 차지했으면(같은 대상) 앞의 것만 남긴다.
          if (seen.has(`${t.paneId}|${t.key}`)) {
            tabsChanged = true;
            continue;
          }
          seen.add(`${t.paneId}|${t.key}`);
          viewerTabs.push(t);
          continue;
        }
        tabsChanged = true;
        const target = { ...t.target, path: next };
        // 탭 키에 경로가 박혀 있다 — 다시 계산하지 않으면 탭이 죽은 경로를 가리킨 채 남는다.
        const key = viewerTabKey(target, t.repoId, t.outerId);
        if (seen.has(`${t.paneId}|${key}`)) continue;
        seen.add(`${t.paneId}|${key}`);
        viewerTabs.push({ ...t, key, target });
      }

      // 패널이 보고 있는 경로도 전부 옮긴다 — 안 하면 그 패널만 죽은 경로를 가리킨 채 남는다.
      let panesChanged = false;
      const viewerByPane: UiState["viewerByPane"] = {};
      for (const [pid, e] of Object.entries(s.viewerByPane)) {
        const np =
          e && s.selectedProjectId === projectId && isOuterRel(e.repoId)
            ? mapPath(e.target.path)
            : null;
        if (np === null || !e) {
          viewerByPane[pid] = e;
          continue;
        }
        panesChanged = true;
        viewerByPane[pid] = { ...e, target: { ...e.target, path: np } };
      }

      let activeDiffByProject = s.activeDiffByProject;
      const active = s.activeDiffByProject[projectId];
      let actChanged = false;
      if (active && isOuterRel(active.repoId)) {
        const np = mapPath(active.target.path);
        if (np !== null) {
          activeDiffByProject = {
            ...s.activeDiffByProject,
            [projectId]: { ...active, target: { ...active.target, path: np } },
          };
          actChanged = true;
        }
      }

      // 옮길 것이 없으면 상태를 그대로 — 뷰어 탭 영속·리렌더를 헛돌리지 않는다.
      if (!tabsChanged && !panesChanged && !actChanged) return s;
      return {
        viewerTabs: tabsChanged ? viewerTabs : s.viewerTabs,
        viewerByPane: panesChanged ? viewerByPane : s.viewerByPane,
        ...mirror(
          (panesChanged ? viewerByPane : s.viewerByPane)[s.viewerActivePaneId] ?? null,
        ),
        activeDiffByProject,
      };
    }),
  // ── 뷰어 분할(태스크 64) — 트리 조작은 lib/pane-tree.ts의 순수 함수가 한다 ──
  splitViewerPane: (paneId, dir, newFirst) =>
    set((s) => {
      // Monaco 인스턴스가 패널 수만큼 생긴다 — 상한에서 조용히 무시(메뉴도 비활성으로 보인다).
      if (collectPanes(s.viewerLayout).length >= VIEWER_MAX_PANES) return {};
      const newPaneId = crypto.randomUUID();
      return {
        viewerLayout: splitAt(
          s.viewerLayout,
          paneId,
          dir,
          { kind: "leaf", paneId: newPaneId },
          newFirst,
        ),
        // 새 패널이 활성 — 다음에 여는 파일이 여기 뜬다(빈 상태로 시작).
        viewerActivePaneId: newPaneId,
        viewerMaximizedPaneId: null,
        viewerByPane: { ...s.viewerByPane, [newPaneId]: null },
        ...mirror(null),
      };
    }),

  // 마지막 하나면 무시 — 뷰어가 통째로 사라지지 않게.
  closeViewerPane: (paneId) => set((s) => dropViewerPane(s, paneId) ?? {}),

  setViewerActivePane: (paneId) =>
    set((s) =>
      s.viewerActivePaneId === paneId
        ? {}
        : { viewerActivePaneId: paneId, ...mirror(s.viewerByPane[paneId] ?? null) },
    ),

  toggleViewerMaximize: (paneId) =>
    set((s) => ({
      viewerMaximizedPaneId: s.viewerMaximizedPaneId === paneId ? null : paneId,
    })),

  setViewerRatio: (splitId, ratio) =>
    set((s) => ({ viewerLayout: setRatioAt(s.viewerLayout, splitId, ratio) })),

  toggleLog: () => set((s) => ({ logOpen: !s.logOpen })),
  setLogHeight: (h) => {
    const v = Math.max(120, Math.min(h, window.innerHeight - 200));
    localStorage.setItem("gp:log-height", String(v));
    set({ logHeight: v });
  },
  // 모아보기를 닫으면 "리포트 탭이 앞"도 풀린다 — 다시 열었을 때 터미널부터 보이게.
  // (reportOpen 은 남긴다: 리포트를 보다 모아보기를 닫으면 메인에 리포트가 그대로 보인다.)
  setAggregateOpen: (open) =>
    set({ aggregateOpen: open, ...(!open && { aggregateReportActive: false }) }),
  setAggregateWindowOpen: (open) => set({ aggregateWindowOpen: open }),
  toggleAggregate: () =>
    set((s) => ({
      aggregateOpen: !s.aggregateOpen,
      ...(s.aggregateOpen && { aggregateReportActive: false }),
    })),
  toggleReport: () =>
    set((s) => {
      // 모아보기 안에서는 리포트가 헤더의 탭이다. 예전엔 여기서도 reportOpen 만 뒤집어, App 이
      // 모아보기를 우선 그리는 탓에 눌러도 화면이 안 바뀌었다(2026-09-17 사용자 지적).
      if (s.aggregateOpen || IN_AGGREGATE_WINDOW) {
        if (s.reportOpen && s.aggregateReportActive) return { aggregateReportActive: false };
        return { reportOpen: true, aggregateReportActive: true };
      }
      return { reportOpen: !s.reportOpen, aggregateReportActive: false };
    }),
  setAggregateReportActive: (active) => set({ aggregateReportActive: active }),
  closeReport: () => set({ reportOpen: false, aggregateReportActive: false }),
  setAggregateTracks: (shape, tracks) =>
    set((s) => {
      const next = { ...s.aggregateTracks, [shape]: tracks };
      try {
        localStorage.setItem("gp:aggregate-tracks", JSON.stringify(next));
      } catch {
        /* localStorage 불가 환경 무시 */
      }
      return { aggregateTracks: next };
    }),
  toggleAggregateGroupTabs: () =>
    set((s) => {
      const v = !s.aggregateGroupTabs;
      localStorage.setItem("gp:aggregate-group-tabs", v ? "1" : "0");
      return { aggregateGroupTabs: v };
    }),
  // 별도 창은 스토어가 창별이라 라이브 동기가 없다 — 시작 시 localStorage로만 맞춘다
  // (메인 안 모아보기와 별도 창은 동시에 열리지 않는다: main.tsx가 창이 열리면 메인을 닫는다).
  setAggregateLayout: (mode) => {
    localStorage.setItem("gp:aggregate-layout", mode);
    set({ aggregateLayout: mode });
  },
  selectCommit: (sha) => set({ selectedCommitSha: sha }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (category) =>
    set({ settingsOpen: true, settingsCategory: category ?? null }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  setSymbolSearchOpen: (open) => set({ symbolSearchOpen: open }),
  setMemoOpen: (open) => set({ memoOpen: open }),
  toggleDiffCollapse: () =>
    set((s) => ({ diffCollapseUnchanged: !s.diffCollapseUnchanged })),
  toggleFileTree: () =>
    set((s) => {
      const v = !s.fileTreeOpen;
      localStorage.setItem("gp:filetree-open", v ? "1" : "0");
      return { fileTreeOpen: v };
    }),
  toggleProjectSort: () =>
    set((s) => {
      const v = !s.projectSortByChanges;
      localStorage.setItem("gp:project-sort-changes", v ? "1" : "0");
      return { projectSortByChanges: v };
    }),
  toggleProjectColors: () =>
    set((s) => {
      const v = !s.projectColorsOn;
      localStorage.setItem("gp:project-colors", v ? "1" : "0");
      return { projectColorsOn: v };
    }),
  pushToast: (kind, message, action, opts) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }));
    // durationMs를 넘기지 않으면 기존대로 6초. null이면 타이머를 걸지 않는다 —
    // 사용자가 X로 닫을 때까지 남는 알림(새 버전 안내 등).
    const ms = opts?.durationMs === undefined ? 6000 : opts.durationMs;
    if (ms != null) setTimeout(() => useUi.getState().dismissToast(id), ms);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  askConfirm: (req) => set({ confirm: req }),
  closeConfirm: () => set({ confirm: null }),
  askPrompt: (req) => set({ prompt: req }),
  closePrompt: () => set({ prompt: null }),
  openImageEditor: (path, repoId) =>
    set({ imageEditorPath: path, imageEditorRepoId: repoId ?? null }),
  closeImageEditor: () =>
    set({ imageEditorPath: null, imageEditorRepoId: null }),
  gitDialog: null,
  openGitDialog: (projectId, tab) => set({ gitDialog: { projectId, tab } }),
  closeGitDialog: () => set({ gitDialog: null }),
  fileTreeDialog: null,
  openFileTreeDialog: (projectId) => set({ fileTreeDialog: { projectId } }),
  closeFileTreeDialog: () => set({ fileTreeDialog: null }),
  translate: null,
  openTranslate: (req) => set({ translate: req }),
  closeTranslate: () => set({ translate: null }),
}));

// 뷰어 탭 + 프로젝트별 활성 파일 영속 — 두 슬라이스가 바뀔 때만 기록(참조 비교로 잦은 UI 변화 무시).
//
// **메인 창만 기록한다.** 보조 창(플로팅·모아보기·문서 창)의 store는 그 창이 열린 순간의
// localStorage 스냅샷이고 그 뒤 메인 창이 연 탭은 반영되지 않는다 — 보조 창에서 selectDiff가
// 한 번이라도 불리면(모아보기 창의 Git 모달 안 DiffViewer, doc 창의 "편집" 등) 그 낡은 스냅샷이
// 통째로 기록돼 **메인 창이 그 뒤 연 탭이 재시작 후 전부 사라진다.**
const SKIP_VIEWER_PERSIST = (() => {
  try {
    const label = getCurrentWebviewWindow().label;
    return (
      label.startsWith("float-") || label.startsWith("doc-") || label === "aggregate"
    );
  } catch {
    return false;
  }
})();
if (!SKIP_VIEWER_PERSIST) {
  let prevTabs = persistedViewer.viewerTabs;
  let prevActive = persistedViewer.activeDiffByProject;
  // 분할 레이아웃도 같은 항목에 넣는다 — 재시작 후 패널 배치와 각 패널의 파일이 돌아온다.
  let prevLayout = persistedViewer.viewerLayout;
  let prevPane = persistedViewer.viewerActivePaneId;
  let prevByPane = initialByPane;
  useUi.subscribe((s) => {
    if (
      s.viewerTabs === prevTabs &&
      s.activeDiffByProject === prevActive &&
      s.viewerLayout === prevLayout &&
      s.viewerActivePaneId === prevPane &&
      s.viewerByPane === prevByPane
    )
      return;
    prevTabs = s.viewerTabs;
    prevActive = s.activeDiffByProject;
    prevLayout = s.viewerLayout;
    prevPane = s.viewerActivePaneId;
    prevByPane = s.viewerByPane;
    try {
      localStorage.setItem(
        VIEWER_KEY,
        JSON.stringify({
          viewerTabs: s.viewerTabs,
          activeDiffByProject: s.activeDiffByProject,
          viewerLayout: s.viewerLayout,
          viewerActivePaneId: s.viewerActivePaneId,
          viewerByPane: s.viewerByPane,
        }),
      );
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  });
}
