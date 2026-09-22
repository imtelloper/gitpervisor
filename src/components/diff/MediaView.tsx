import { ExternalLink, FileWarning } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { errorMessage, ipc } from "../../lib/ipc";
import { isVideo } from "../../lib/language-map";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import VideoPlayer from "../video/VideoPlayer";

/**
 * 동영상·오디오 재생 — 로컬 파일을 **프리뷰 루프백 서버**로 흘려 재생한다.
 *
 * 동영상은 VideoPlayer(커스텀 컨트롤·구간 반복·편집/내보내기 — video-editor-design.md)로
 * 위임하고, 오디오는 네이티브 <audio controls>로 충분해 여기 남는다(YAGNI).
 *
 * 훅 순서 때문에 분기는 **훅 없는 래퍼**에서 한다 — 같은 마운트에서 path가 동영상↔오디오로
 * 바뀌면 조건부 훅이 돼 React가 깨진다.
 */
export default function MediaView({
  projectId,
  path,
  onOpenPath,
}: {
  projectId: string;
  path: string;
  /** 동영상 라이브러리 레일에서 형제 영상을 고를 때 쓸 통로(VideoPlayer의 onOpenPath). */
  onOpenPath?: (path: string) => void;
}) {
  return isVideo(path) ? (
    <VideoPlayer projectId={projectId} path={path} onOpenPath={onOpenPath} />
  ) : (
    <AudioView projectId={projectId} path={path} />
  );
}

/**
 * ## 왜 base64가 아니라 루프백 HTTP인가
 * 이미지처럼 `read_file_base64`로 받으면 전체를 메모리에 올려야 하고(25MB 상한),
 * 무엇보다 **탐색(seek)이 불가능**하다. 미디어는 브라우저가 Range 요청으로 필요한 구간만
 * 가져와야 하는데, preview.rs가 이미 단일 Range 206 + Accept-Ranges를 지원한다.
 *
 * ## 재생 실패는 정상 시나리오다
 * 확장자는 컨테이너일 뿐 코덱을 보장하지 않고, 재생 가능 여부는 각 OS 웹뷰 엔진이 정한다.
 * 그래서 실패를 감추지 않고 코덱 문제임을 알리고 외부 앱으로 넘긴다.
 */
function AudioView({ projectId, path }: { projectId: string; path: string }) {
  const msg = useMessages();
  const pushToast = useUi((s) => s.pushToast);
  const [url, setUrl] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [playError, setPlayError] = useState(false);
  const mediaRef = useRef<HTMLAudioElement>(null);

  /** 루프백 URL 발급. 서버가 살아 있으면 같은 URL이 돌아와 멱등이다. */
  const mint = useCallback(async () => {
    try {
      const u = await ipc.previewLocalUrl(projectId, path);
      setUrl(u);
      setMintError(null);
      return u;
    } catch (e) {
      setMintError(errorMessage(e));
      return null;
    }
  }, [projectId, path]);

  useEffect(() => {
    setUrl(null);
    setMintError(null);
    setPlayError(false);
    void mint();
  }, [mint]);

  // 프리뷰 서버 keep-alive — 긴 오디오도 선버퍼 후 10분 넘게 조용해지면 유휴 종료로
  // 다음 탐색이 연결 거부가 된다. mint는 멱등 + 유휴 시계 리셋(VideoPlayer와 동일).
  useEffect(() => {
    const id = window.setInterval(
      () => void ipc.previewLocalUrl(projectId, path).catch(() => {}),
      4 * 60_000,
    );
    return () => window.clearInterval(id);
  }, [projectId, path]);

  /**
   * 재생 오류 처리. 프리뷰 서버는 요청이 10분간 없으면 스스로 종료하는데(IDLE_SECS),
   * 일시정지해 두면 요청이 끊겨 그 뒤 재생·탐색이 연결 거부로 실패한다. 그래서 먼저 **한 번
   * 재발급**해 되살려 보고(재생 위치 유지), 그래도 실패하면 코덱 문제로 판단해 안내한다.
   */
  const retriedRef = useRef(false);
  const onError = () => {
    const el = mediaRef.current;
    if (retriedRef.current || !el) {
      setPlayError(true);
      return;
    }
    retriedRef.current = true;
    const at = el.currentTime;
    const wasPlaying = !el.paused; // 치명 오류로 멈춰도 paused는 false — 재개 의도 판단
    void mint().then((u) => {
      if (!u) {
        setPlayError(true);
        return;
      }
      // 서버가 살아 있으면 재발급 URL이 동일해 src 변경 재로드가 없다 — load()로 강제
      // 재시도해야 하고, 그마저 실패(코덱)하면 두 번째 error가 안내 화면으로 간다.
      // load()는 정지 상태로 되돌리므로 재생 중이었으면 play()로 재개한다.
      requestAnimationFrame(() => {
        const m = mediaRef.current;
        if (!m) return;
        m.load();
        if (at > 0) m.currentTime = at;
        if (wasPlaying) void m.play().catch(() => {});
      });
    });
  };

  // OS 기본 앱으로 넘긴다 — 웹뷰가 못 여는 코덱의 유일한 탈출구.
  const openExternally = () => {
    void ipc
      .runExecutable(projectId, path)
      .catch((e) => pushToast("error", errorMessage(e)));
  };

  if (mintError)
    return (
      <EmptyState
        icon={FileWarning}
        title={msg.git.mediaView.prepareFailed}
        desc={mintError}
      />
    );

  if (playError)
    return (
      <EmptyState
        icon={FileWarning}
        title={msg.git.mediaView.unplayableTitle}
        desc={msg.git.mediaView.unplayableDesc}
        action={
          <button
            onClick={openExternally}
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
          >
            <ExternalLink size={13} /> {msg.git.diff.openExternally}
          </button>
        }
      />
    );

  if (!url) return <EmptyState title={msg.git.mediaView.preparing} />;

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="flex h-8 shrink-0 items-center justify-end border-b border-edge px-3 text-xs text-fg-dim">
        <button
          onClick={openExternally}
          title={msg.git.mediaView.openDefaultAppTitle}
          className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={12} /> {msg.git.diff.openExternally}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-3">
        <audio
          ref={mediaRef}
          src={url}
          controls
          // 자동재생 안 함 — 파일을 열자마자 소리가 나면 놀라고, 음소거 자동재생 정책에도 얽힌다.
          preload="metadata"
          onError={onError}
          // 로드 성공 시 오류 복구 1회권 재장전 — 긴 세션의 다음 서버 교체도 복구되게.
          onCanPlay={() => {
            retriedRef.current = false;
          }}
          className="w-full max-w-xl"
        />
      </div>
    </div>
  );
}
