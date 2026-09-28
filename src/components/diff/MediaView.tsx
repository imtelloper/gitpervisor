import { isVideo } from "../../lib/language-map";
import AudioPlayer from "../audio/AudioPlayer";
import VideoPlayer from "../video/VideoPlayer";

/**
 * 동영상·오디오 재생 — 로컬 파일을 **프리뷰 루프백 서버**로 흘려 재생한다.
 *
 * 동영상은 VideoPlayer(커스텀 컨트롤·구간 반복·편집/내보내기 — video-editor-design.md),
 * 오디오는 AudioPlayer(같은 폴더 플레이리스트)로 위임한다.
 *
 * 훅 순서 때문에 분기는 **훅 없는 래퍼**에서 한다 — 같은 마운트에서 path가 동영상↔오디오로
 * 바뀌면 조건부 훅이 돼 React가 깨진다.
 *
 * ## 왜 base64가 아니라 루프백 HTTP인가
 * 이미지처럼 `read_file_base64`로 받으면 전체를 메모리에 올려야 하고(25MB 상한),
 * 무엇보다 **탐색(seek)이 불가능**하다. 미디어는 브라우저가 Range 요청으로 필요한 구간만
 * 가져와야 하는데, preview.rs가 이미 단일 Range 206 + Accept-Ranges를 지원한다.
 *
 * ## 재생 실패는 정상 시나리오다
 * 확장자는 컨테이너일 뿐 코덱을 보장하지 않고, 재생 가능 여부는 각 OS 웹뷰 엔진이 정한다.
 * 그래서 실패를 감추지 않고 코덱 문제임을 알리고 외부 앱으로 넘긴다.
 */
export default function MediaView({
  projectId,
  path,
  onOpenPath,
  onReplacePath,
}: {
  projectId: string;
  path: string;
  /** 동영상 라이브러리 레일에서 형제 영상을 고를 때 쓸 통로(같은 뷰어 자리에서 연다 — 탭 업서트). */
  onOpenPath?: (path: string) => void;
  /** 오디오 곡 전환 통로 — 탭을 늘리지 않고 갈아 끼운다(DiffViewer onReplaceFile). 없으면 onOpenPath. */
  onReplacePath?: (path: string) => void;
}) {
  return isVideo(path) ? (
    <VideoPlayer projectId={projectId} path={path} onOpenPath={onOpenPath} />
  ) : (
    <AudioPlayer projectId={projectId} path={path} onOpenPath={onReplacePath ?? onOpenPath} />
  );
}
