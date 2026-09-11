import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Code2, Eye, FileQuestion, FileWarning } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmHost } from "./components/common/ConfirmDialog";
import { EmptyState } from "./components/common/EmptyState";
import { PromptHost } from "./components/common/PromptDialog";
import { Toasts } from "./components/common/Toast";
import { TranslateHost } from "./components/common/TranslateCard";
import { FloatTitleBar } from "./components/FloatTitleBar";
import { attachVideoEvents } from "./lib/events";
import type { DiffTarget } from "./lib/ipc";
import { docTarget } from "./lib/floating";
import { errorMessage } from "./lib/ipc";
import { languageOf } from "./lib/language-map";
import { useDiff, useSettings } from "./queries";
import { useUi } from "./stores/ui";

/**
 * **셋 다 lazy여야 한다.** 이 창은 파일 하나 보자고 뜨는데, 정적 import로 두면 이 모듈들이 앱
 * 메인 청크로 인라인돼 **모든 창이** 그 값을 낸다.
 *
 * 실측(2026-08-28): DocWindow가 DiffViewer를 정적으로 import하던 동안 `index-*.js`가 **4.41MB**
 * 였다 — Monaco(~3MB)가 통째로 딸려 들어와서다. `ViewerTab`이 `lazy()`로 잘라 둔 분할을 이
 * 한 줄이 무력화했고, 그 바람에 메인 창 콜드스타트까지 같이 느려져 있었다.
 * (rollup은 동적 import 대상이라도 같은 청크 안에서 정적으로도 참조되면 인라인한다.)
 */
const MarkdownView = lazy(() => import("./components/diff/MarkdownView"));
const DiffViewer = lazy(() => import("./components/diff/DiffViewer"));
// 이미지 편집기도 같은 이유로 lazy다(App.tsx와 **같은 모듈 지정자** — 두 창이 한 청크를 공유한다).
const ImageEditor = lazy(() => import("./components/image/ImageEditor"));
/** 즐겨찾기 폴더 창(태스크 66). **lazy 여야 한다** — 위 세 개와 같은 이유로, 정적 import 면
 *  이 모듈이 앱 메인 청크에 인라인돼 파일 하나 보려고 뜬 창까지 그 값을 낸다. */
const FolderWindow = lazy(() => import("./components/folder/FolderWindow"));

/**
 * `doc-<id>` 창의 갈림길 — 대상에 `folder` 가 있으면 **폴더 목록 창**, 없으면 파일 뷰어 창이다.
 *
 * 여기서 가르는 이유: 폴더 창은 아래 `FileDocWindow` 가 거는 훅(레포 워처 무효화·동영상 이벤트·
 * 이미지 편집기 호스트)을 하나도 쓰지 않는다. 한 컴포넌트 안에서 조건부로 처리하면 훅이 조건부가
 * 되거나, 쓰지도 않는 리스너를 폴더 창이 계속 달고 있게 된다.
 */
export function DocWindow({ docId }: { docId: string }) {
  const target = useMemo(() => docTarget(docId), [docId]);
  if (target?.folder) {
    return (
      <Suspense fallback={<Loading />}>
        <FolderWindow root={target.folder} />
      </Suspense>
    );
  }
  return <FileDocWindow docId={docId} />;
}

/**
 * 파일 하나만 띄우는 별도 OS 창 — 파일트리 우클릭 → "새 창으로 열기".
 *
 * 마크다운은 **DiffViewer를 거치지 않는다.** 읽기가 목적인데 그 경로는 Monaco 에디터·LSP·포맷터
 * 배선을 전부 끌고 오고, 정작 .md는 그중 아무것도 쓰지 않는다(내부에서 MarkdownView로 분기할
 * 뿐이다). 여기서 바로 렌더하면 md 창이 받는 코드가 마크다운 렌더러 하나로 줄어든다.
 *
 * 그 외 파일은 `DiffViewer`에 맡긴다 — 구문 강조·이미지·동영상·Office 안내를 이미 다 하고 있어,
 * 여기서 다시 만들면 같은 파일이 메인 창과 이 창에서 다르게 보이는 것부터 문제가 된다.
 *
 * 이 창의 스토어(useUi 등)는 메인과 **독립**이다(별도 웹뷰). 뷰어 탭·선택 상태를 공유하지 않는
 * 것이 의도다 — 이 창은 "그 파일 하나"만 본다. 대신 그 독립성 때문에 이미지 편집기가 쓰는
 * 호스트(토스트·확인·프롬프트)도 **여기에** 있어야 한다: 메인 창의 호스트는 저쪽 스토어만 본다.
 */
function FileDocWindow({ docId }: { docId: string }) {
  const target = useMemo(() => docTarget(docId), [docId]);
  /**
   * 이 창 **안에서** 다른 파일로 갈아탄 경로. 창은 "그 파일 하나"를 보는 것이 원칙이지만,
   * 뷰어가 제공하는 이동(동영상 라이브러리 레일·"편집" 버튼·정의 이동)은 **이 창 안에서**
   * 일어나야 한다 — 안 그러면 DiffViewer가 전역 selectDiff로 떨어지는데, 이 창의 스토어는
   * 아무도 안 보므로 클릭이 통째로 무반응이 된다(창마다 스토어가 별개다).
   * 네이티브 창 제목은 생성 시점 값 그대로지만, 창 안 타이틀바는 아래 name이 따라간다.
   */
  const [navPath, setNavPath] = useState<string | null>(null);
  const openInWindow = useCallback((t: DiffTarget) => {
    // 이 창은 단일 파일 보기 전용이다 — 커밋/워크트리 diff 대상은 받지 않는다.
    if (t.mode === "file") setNavPath(t.path);
  }, []);
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const imageEditorPath = useUi((s) => s.imageEditorPath);
  const projectId = target?.projectId ?? null;

  // "편집" 진입으로 열린 창이면 뜨자마자 편집기를 연다 — 뷰어에서 [편집]을 한 번 더 누르게
  // 하지 않는다. `target` 은 docId 로만 메모되므로(위 useMemo) 이 효과는 창당 1회다.
  // 편집기를 닫으면 이 창의 뷰어로 돌아간다(창을 닫지 않는다): 저장에 성공하면 편집기가
  // 스스로 close() 하는데, 그 결과를 보여 줄 뷰어가 바로 이 창이고 워처로 자동 갱신된다.
  useEffect(() => {
    if (target?.edit) {
      useUi.getState().openImageEditor(target.path, target.projectId);
    }
  }, [target]);

  // 이 창에도 저장된 테마 적용 — 로드 전엔 main.tsx의 localStorage 선적용 값이 유지된다
  // (FloatingTerminal과 같은 처리).
  useEffect(() => {
    if (settings?.theme) document.documentElement.dataset.theme = settings.theme;
  }, [settings?.theme]);

  /**
   * 워처 신호를 이 창도 듣는다 — `attachRepoEvents`는 main.tsx의 메인 분기에서만 걸린다.
   * 메인 창(또는 다른 창)에서 같은 이미지를 저장하면 여기도 새 그림을 보여야 하는데,
   * `file-image`·`diff`는 staleTime이 Infinity라 스스로 다시 읽지 않는다.
   * 이 창은 파일 하나만 보므로 자기 프로젝트 신호만 받아 그 둘만 무효화한다.
   */
  useEffect(() => {
    if (!projectId) return;
    // listen()이 resolve되기 전에 정리가 먼저 돌 수 있다 — 늦게 온 unlisten을 그 자리에서
    // 호출해 리스너가 영구히 남지 않게 한다(ExportPanel과 같은 처리).
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ projectId: string }>("repo://changed", (e) => {
      if (e.payload.projectId !== projectId) return;
      void qc.invalidateQueries({ queryKey: ["file-image", projectId] });
      void qc.invalidateQueries({ queryKey: ["diff", projectId] });
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [projectId, qc]);

  /**
   * 이 창에서 연 동영상의 내보내기 종결도 이 창이 처리한다(태스크 35 §2.2) — 토스트 호스트가
   * 창마다 따로라 메인의 리스너는 저쪽 스토어에만 띄운다. `attachVideoEvents`는 창당 1회다
   * (listen을 해제하지 않으므로 StrictMode 이중 마운트에 리스너가 겹치지 않게 ref로 막는다).
   */
  const videoAttached = useRef(false);
  useEffect(() => {
    if (videoAttached.current) return;
    videoAttached.current = true;
    attachVideoEvents(qc);
  }, [qc]);

  const shownPath = navPath ?? target?.path ?? null;
  const name = shownPath ? (shownPath.split("/").pop() ?? shownPath) : "파일";
  const isMd = !!shownPath && languageOf(shownPath) === "markdown";

  return (
    <div className="flex h-screen flex-col bg-base">
      <FloatTitleBar title={name} badge="파일" />
      <div className="min-h-0 flex-1">
        {!target ? (
          // 여는 쪽이 적어 둔 대상이 없다 = localStorage가 지워졌거나 보관 상한에 밀려났다.
          // 조용히 빈 창을 남기지 않는다 — 무엇이 없어서 못 여는지 말한다.
          <EmptyState
            icon={FileQuestion}
            title="열 파일을 찾지 못했습니다"
            desc="창 정보가 만료되었습니다. 파일트리에서 다시 열어 주세요."
          />
        ) : isMd ? (
          <MarkdownDoc projectId={target.projectId} path={shownPath ?? target.path} />
        ) : (
          <Suspense fallback={<Loading />}>
            <DiffViewer
              projectId={target.projectId}
              target={{ mode: "file", path: shownPath ?? target.path }}
              onOpenFile={openInWindow}
            />
          </Suspense>
        )}
      </div>
      {/* 이미지 뷰어의 [편집]은 **이 창의** useUi에 imageEditorPath만 세운다 — 편집기와 그것이
          쓰는 호스트 3종이 여기 없으면 아무 것도 뜨지 않는다(스토어가 창마다 별개라 메인 창의
          호스트가 대신 그려 주지 않는다). AggregateWindow·SysMonitorWindow와 같은 처리. */}
      <Toasts />
      <ConfirmHost />
      <PromptHost />
      {/* 뷰어 Monaco의 '선택 영역 번역' 카드(태스크 61) — 여기 없으면 이 창에서만 무반응이다. */}
      <TranslateHost />
      {imageEditorPath && (
        <Suspense fallback={null}>
          <ImageEditor />
        </Suspense>
      )}
    </div>
  );
}

/** 마크다운 전용 경로 — 렌더 ↔ 원본 토글만 얹는다(편집은 메인 창 뷰어의 일이다). */
function MarkdownDoc({ projectId, path }: { projectId: string; path: string }) {
  // 메인 창 뷰어와 **같은 쿼리 키**를 쓴다(queries.keys.diff) — main.tsx가 창을 띄우기 전에
  // 같은 키로 프리페치해 두므로, 여기 마운트 시점엔 대개 이미 캐시에 있다.
  const { data, isLoading, error } = useDiff(projectId, { mode: "file", path });
  const [raw, setRaw] = useState(false);

  if (error)
    return (
      <EmptyState
        icon={FileWarning}
        title="파일을 불러오지 못했습니다"
        desc={errorMessage(error)}
      />
    );
  if (isLoading || !data) return <Loading />;
  if (data.tooLarge)
    return (
      <EmptyState
        icon={FileWarning}
        title="파일이 너무 큽니다"
        desc="1.5MB를 초과하는 파일은 표시하지 않습니다"
      />
    );

  const content = data.newContent ?? "";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="truncate font-mono text-xs text-fg-muted">{path}</span>
        <div className="flex-1" />
        <button
          onClick={() => setRaw((v) => !v)}
          title={raw ? "미리보기 (렌더된 마크다운)" : "원본 보기 (마크다운 소스)"}
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          {raw ? <Eye size={14} /> : <Code2 size={14} />}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {raw ? (
          // 원본은 <pre> 하나면 된다 — 여기서 Monaco를 부르면 이 경로를 만든 이유가 사라진다.
          <pre className="h-full overflow-auto bg-base p-4 font-mono text-[13px] leading-6 text-fg whitespace-pre-wrap">
            {content}
          </pre>
        ) : (
          <Suspense fallback={<Loading />}>
            <MarkdownView content={content} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-fg-dim">
      불러오는 중…
    </div>
  );
}

export default DocWindow;
