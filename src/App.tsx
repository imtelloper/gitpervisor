import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderGit2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { AggregateTerminals } from "./components/AggregateTerminals";
import { ChangesPanel } from "./components/changes/ChangesPanel";
import { ConfirmHost } from "./components/common/ConfirmDialog";
import { PromptHost } from "./components/common/PromptDialog";
import { ConnectionDialog } from "./components/db/ConnectionDialog";
import { EmptyState } from "./components/common/EmptyState";
import { Toasts } from "./components/common/Toast";
import { GitGate } from "./components/GitGate";
import { GlobalShortcuts, KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { QuickOpenHost } from "./components/quickopen/QuickOpenHost";
import { SearchPanel } from "./components/search/SearchPanel";
import { SymbolSearch } from "./components/symbolsearch/SymbolSearch";
import { useSearch } from "./stores/search";
import { LogPanel } from "./components/log/LogPanel";
import { MemoDialog } from "./components/memo/MemoDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ProjectList } from "./components/sidebar/ProjectList";
import { ProjectPathMissing } from "./components/ProjectPathMissing";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { HealthBanner } from "./components/common/HealthBanner";
import { bumpLaunchCount, StarPrompt } from "./components/common/StarPrompt";
import { Toolbar } from "./components/toolbar/Toolbar";
import { FileTreePanel } from "./components/tree/FileTreePanel";
import { WorkspaceTabs } from "./components/workspace/WorkspaceTabs";
import { useAgentNotifications } from "./lib/agent-notify";
import { refreshTerminalThemes } from "./lib/terminal";
import {
  useProjectRootsPrefetch,
  useProjects,
  useSettings,
  useStatus,
} from "./queries";
import { useUi } from "./stores/ui";
import { useUpdater } from "./stores/updater";

// 이미지 편집기는 무겁고(canvas + avif wasm 동적 로드) 자주 안 열리므로 처음 열 때만 로드한다.
const ImageEditor = lazy(() => import("./components/image/ImageEditor"));

// 업데이트 재확인 주기 — 릴리스는 주 1회도 안 나오고 요청은 latest.json 1회 fetch라
// 더 촘촘히 볼 이유가 없다. 절전에서 깨어나 늦게 발화해도 무해하다.
const UPDATE_RECHECK_MS = 12 * 60 * 60_000;

export default function App() {
  // 실행 횟수는 **렌더 중** 올린다 — useEffect에 두면 자식(StarPrompt)이 이미 마운트하며
  // 증가 전 값을 읽어, 3번째 실행에서 카드가 한 박자 늦게(=다음 실행에) 뜬다.
  // 모듈 플래그로 멱등하므로 StrictMode 이중 마운트에도 1회다.
  useState(bumpLaunchCount);

  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const fileTreeOpen = useUi((s) => s.fileTreeOpen);
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const imageEditorPath = useUi((s) => s.imageEditorPath);
  const searchOpen = useSearch((s) => s.open);

  const { data: settings } = useSettings();
  // 자동 fetch는 Rust 스케줄러(fetch_scheduler.rs)가 담당 — 포커스 복귀 트리거는
  // events.ts의 focusManager 연결부에서 함께 배선된다(태스크 04).
  useProjectRootsPrefetch(); // 전 프로젝트 루트 병렬 프리페치 → 트리 즉시 표시
  useAgentNotifications(); // AI 작업 완료 OS 알림 (메인 창 1회 — 설정 모드별)

  // 선택 테마를 <html data-theme>로 적용 — CSS 변수 오버라이드가 전체 팔레트를 바꾼다
  useEffect(() => {
    const theme = settings?.theme ?? "darcula";
    document.documentElement.dataset.theme = theme;
    // 다음 실행의 첫 페인트용 캐시 — main.tsx가 렌더 전에 선적용해 시작 플래시를 없앤다
    try {
      localStorage.setItem("gp:theme", theme);
    } catch {
      /* localStorage 불가 환경 무시 */
    }
    // 이미 열린 xterm은 생성 시 테마가 박제되므로 즉시 재적용 (CSSOM 반영은 동기라 안전)
    refreshTerminalThemes();
  }, [settings?.theme]);

  // 시작 시 자동 업데이트 확인(옵트인, 기본 켬) — 콜드스타트 IPC 폭주와 안 겹치게 잠깐 지연.
  // 새 버전이 있으면 updater 스토어가 토스트로 알리고 설정 › 업데이트에 표시한다. 실패는 조용히.
  // 시작 1회로 끝내지 않고 주기적으로도 확인한다 — 이 앱은 종일 켜 둔 채로 쓰는 물건이라
  // 시작 시 1회만 보면 다음 재시작까지 새 릴리스를 모른다. 주기 확인을 **같은 효과 안**에 두는
  // 이유는 아래 dev·autoCheck 가드를 공유하기 위함이다(가드를 복제하면 한쪽만 고쳐진다).
  useEffect(() => {
    // dev 인스턴스는 확인하지 않는다 — 설치본과 나란히 띄우는 구성에서(package.json dev:app)
    // 여기서 "설치"를 누르면 지금 쓰고 있는 설치본을 통째로 갈아엎는다(installMode: passive).
    if (import.meta.env.DEV) return;
    if (!useUpdater.getState().autoCheck) return;
    const run = () => void useUpdater.getState().check({ silent: true });
    const t = setTimeout(run, 4000);
    const iv = setInterval(run, UPDATE_RECHECK_MS);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, []);

  // 메인 창 닫기 확인 — 백엔드가 살아있는 PTY 세션이 있을 때만 닫기를 막고 이 이벤트를 보낸다.
  // 확인하면 destroy()로 곧장 닫는다(CloseRequested를 다시 타지 않는다). 취소하면 백엔드 표식을
  // 되돌려 다음 X에서 다시 묻는다 — 안 되돌리면 그다음 오클릭이 확인 없이 통과한다.
  useEffect(() => {
    const un = listen<number>("app://close-requested", (e) => {
      const n = e.payload;
      useUi.getState().askConfirm({
        title: "터미널이 실행 중입니다",
        message: `실행 중인 터미널 세션이 ${n}개 있습니다. 지금 닫으면 그 안에서 돌고 있는 명령(빌드·개발 서버·에이전트)이 모두 종료됩니다.`,
        confirmLabel: "닫기",
        danger: true,
        onConfirm: () => void getCurrentWindow().destroy(),
        onCancel: () => void invoke("reset_close_guard").catch(() => {}),
      });
    });
    return () => void un.then((f) => f());
  }, []);

  // 화면 캡쳐 전역 단축키 등록 실패 — **조용히 넘기면 안 되는 종류의 고장이다.** 단축키가
  // 설정에 있는데 안 눌리면 사용자는 원인을 알 방법이 없다(대개 다른 앱이 조합을 선점한 것).
  useEffect(() => {
    const un = listen<string>("capture://hotkey-error", (e) =>
      useUi.getState().pushToast("error", e.payload),
    );
    return () => void un.then((f) => f());
  }, []);

  const selected = projects?.find((p) => p.id === selectedProjectId) ?? null;

  // 선택 프로젝트의 경로 소실(폴더 이동/삭제) 감지 — 문구는 백엔드 status_of와 동일(단일 진실).
  const { data: selStatus } = useStatus(selectedProjectId);
  const pathMissing = selStatus?.error === "프로젝트 경로를 찾을 수 없습니다";

  // 첫 로드 시 첫 프로젝트 자동 선택, 선택된 프로젝트가 제거되면 선택 정리
  useEffect(() => {
    if (!projects) return;
    if (selectedProjectId && !projects.some((p) => p.id === selectedProjectId)) {
      selectProject(projects[0]?.id ?? null);
    } else if (!selectedProjectId && projects.length > 0) {
      selectProject(projects[0].id);
    }
  }, [projects, selectedProjectId, selectProject]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      {/* 우측 하단 카드 스택 — 레이아웃 불점유(fixed). 빈 컨테이너가 클릭을 먹지 않게
          pointer-events는 카드에만 준다. 위: 메모리 압박 경보 / 지난 실행 비정상 종료 안내,
          아래: GitHub star 부탁(3번째 실행 1회). */}
      <div className="pointer-events-none fixed bottom-8 right-4 z-40 flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2 [&>*]:pointer-events-auto">
        <HealthBanner />
        <StarPrompt />
      </div>
      <div className="min-h-0 flex-1">
        <GitGate>
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1">
              <ProjectList />
              {selected && fileTreeOpen && (
                <FileTreePanel projectId={selected.id} />
              )}

              <main className="flex min-w-0 flex-1 flex-col">
                {aggregateOpen ? (
                  <AggregateTerminals />
                ) : selected && pathMissing ? (
                  <ProjectPathMissing project={selected} />
                ) : selected ? (
                  <>
                    <Toolbar project={selected} />
                    <div className="flex min-h-0 flex-1">
                      <ChangesPanel projectId={selected.id} />
                      <WorkspaceTabs projectId={selected.id} />
                    </div>
                    {searchOpen && <SearchPanel projectId={selected.id} />}
                    <LogPanel projectId={selected.id} />
                    <KeyboardShortcuts projectId={selected.id} />
                  </>
                ) : (
                  <EmptyState
                    icon={FolderGit2}
                    title="프로젝트를 추가하세요"
                    desc="좌측 하단 ‘프로젝트 추가’ 버튼으로 git 레포 폴더를 등록하면 상태가 표시됩니다"
                  />
                )}
              </main>
            </div>

            <StatusBar project={selected} />
            {/* 모아보기 토글 등 — 조건 분기 바깥에 상시 마운트(모아보기 중에도 닫기 동작) */}
            <GlobalShortcuts />
          </div>
          <Toasts />
          <ConfirmHost />
          <PromptHost />
          <QuickOpenHost />
          <SymbolSearch />
          <SettingsDialog />
          <MemoDialog />
          <ConnectionDialog />
          {/* 제품 경로는 별도 doc 창으로 옮겼지만(ImageView·파일트리 → openDocWindow) 이 마운트는
              **지우면 안 된다**: e2e 30-image-annotate 가 메인 창에서 useUi.openImageEditor 를
              직접 불러 편집기를 열고 ~50개 단언을 그 위에서 돌린다. 죽은 코드가 아니다. */}
          {imageEditorPath && (
            <Suspense fallback={null}>
              <ImageEditor />
            </Suspense>
          )}
        </GitGate>
      </div>
    </div>
  );
}
