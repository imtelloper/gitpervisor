import { ExternalLink, FileWarning } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, ipc } from "../../lib/ipc";
import { isVideo } from "../../lib/language-map";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

/**
 * 동영상·오디오 재생 — 로컬 파일을 **프리뷰 루프백 서버**로 흘려 `<video>/<audio>`에 물린다.
 *
 * ## 왜 base64가 아니라 루프백 HTTP인가
 * 이미지처럼 `read_file_base64`로 받으면 전체를 메모리에 올려야 하고(25MB 상한),
 * 무엇보다 **탐색(seek)이 불가능**하다. 미디어는 브라우저가 Range 요청으로 필요한 구간만
 * 가져와야 하는데, preview.rs가 이미 단일 Range 206 + Accept-Ranges를 지원한다(HTML 프리뷰
 * 때 "WKWebView는 미디어를 Range 없이 재생하지 못한다"는 이유로 넣어 둔 것이 그대로 쓰인다).
 *
 * ## 재생 실패는 정상 시나리오다
 * 확장자는 컨테이너일 뿐 코덱을 보장하지 않고, 재생 가능 여부는 각 OS 웹뷰 엔진이 정한다
 * (macOS WKWebView는 WebM/VP9가 안 될 수 있고, Linux WebKitGTK는 GStreamer 구성에 좌우된다).
 * 그래서 실패를 감추지 않고 코덱 문제임을 알리고 외부 앱으로 넘긴다.
 */
export default function MediaView({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const pushToast = useUi((s) => s.pushToast);
  const [url, setUrl] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [playError, setPlayError] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const video = isVideo(path);

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
    void mint().then((u) => {
      if (!u) {
        setPlayError(true);
        return;
      }
      // src가 새 포트로 바뀌면 로드가 다시 일어난다 — 끊긴 지점으로 되돌려 준다.
      requestAnimationFrame(() => {
        const m = mediaRef.current;
        if (m && at > 0) m.currentTime = at;
      });
    });
  };

  // OS 기본 앱으로 넘긴다 — 웹뷰가 못 여는 코덱의 유일한 탈출구.
  // (run_executable은 확장자를 가리지 않고 OS 기본 핸들러에 위임한다 — commands/open.rs)
  const openExternally = () => {
    void ipc
      .runExecutable(projectId, path)
      .catch((e) => pushToast("error", errorMessage(e)));
  };

  if (mintError)
    return (
      <EmptyState
        icon={FileWarning}
        title="미디어를 준비하지 못했습니다"
        desc={mintError}
      />
    );

  if (playError)
    return (
      <EmptyState
        icon={FileWarning}
        title="이 형식은 재생할 수 없습니다"
        desc="현재 플랫폼의 웹뷰가 이 코덱을 지원하지 않습니다. 파일 자체는 정상일 수 있습니다."
        action={
          <button
            onClick={openExternally}
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
          >
            <ExternalLink size={13} /> 외부 앱으로 열기
          </button>
        }
      />
    );

  if (!url) return <EmptyState title="미디어 준비 중…" />;

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="flex h-8 shrink-0 items-center justify-end border-b border-edge px-3 text-xs text-fg-dim">
        <button
          onClick={openExternally}
          title="시스템 기본 앱으로 열기"
          className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={12} /> 외부 앱으로 열기
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-3">
        {video ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={url}
            controls
            // 자동재생 안 함 — 파일을 열자마자 소리가 나면 놀라고, 음소거 자동재생 정책에도 얽힌다.
            preload="metadata"
            onError={onError}
            className="max-h-full max-w-full"
          />
        ) : (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={url}
            controls
            preload="metadata"
            onError={onError}
            className="w-full max-w-xl"
          />
        )}
      </div>
    </div>
  );
}
