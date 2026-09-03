import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Code2, Eye, FileQuestion, FileWarning } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { ConfirmHost } from "./components/common/ConfirmDialog";
import { EmptyState } from "./components/common/EmptyState";
import { PromptHost } from "./components/common/PromptDialog";
import { Toasts } from "./components/common/Toast";
import { FloatTitleBar } from "./components/FloatTitleBar";
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
export function DocWindow({ docId }: { docId: string }) {
  const target = useMemo(() => docTarget(docId), [docId]);
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const imageEditorPath = useUi((s) => s.imageEditorPath);
  const projectId = target?.projectId ?? null;

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

  const name = target ? (target.path.split("/").pop() ?? target.path) : "파일";
  const isMd = !!target && languageOf(target.path) === "markdown";

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
          <MarkdownDoc projectId={target.projectId} path={target.path} />
        ) : (
          <Suspense fallback={<Loading />}>
            <DiffViewer
              projectId={target.projectId}
              target={{ mode: "file", path: target.path }}
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
