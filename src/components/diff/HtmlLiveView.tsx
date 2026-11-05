import { FileWarning } from "lucide-react";
import { useEffect, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { errorMessage, ipc } from "../../lib/ipc";
import { EmptyState } from "../common/EmptyState";

/**
 * HTML 바로보기 — 파일 트리의 "브라우저로 열기"와 같은 루프백 프리뷰(commands/preview.rs)를 이 자리 iframe 에 띄운다.
 * 서버 루트가 파일의 상위 폴더라 상대·루트절대 CSS·JS·이미지가 브라우저에서처럼 로드된다. `srcdoc` 으로 그리면
 * 편집 중인 글자를 바로 보여 줄 수 있지만, 문서 출처가 앱이 돼 프리뷰 서버가 서브리소스를 403 으로 막는다.
 *
 * 그래서 보이는 것은 **저장된 파일**이다 — `version`(뷰어가 읽은 내용)이 바뀌면(저장·외부 수정) 다시 읽는다. 매번 URL 을
 * 새로 받는다: 프리뷰 서버는 한동안 안 쓰면 내려가고, 받기(mint)가 그때 되살린다.
 */
export function HtmlLiveView({
  projectId,
  path,
  version,
  dirty,
}: {
  projectId: string;
  path: string;
  version: string | null | undefined;
  /** 저장 안 한 편집이 있다 — 아직 바로보기에 안 보인다고 알린다. */
  dirty: boolean;
}) {
  const msg = useMessages();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(null);
    ipc
      .previewLocalUrl(projectId, path)
      .then((u) => {
        if (!alive) return;
        setUrl(u);
        setGen((g) => g + 1); // 같은 URL 이어도 iframe 을 새로 그려 다시 읽게
      })
      .catch((e) => alive && setErr(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [projectId, path, version]);

  if (err) return <EmptyState icon={FileWarning} title={msg.git.diff.htmlLiveFailed} desc={err} />;
  return (
    <div className="flex h-full flex-col">
      {dirty && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px] text-fg-muted">
          <FileWarning size={12} className="shrink-0 text-warn" />
          {msg.git.diff.htmlLiveUnsaved}
        </div>
      )}
      {url && (
        <iframe
          key={gen}
          title={path}
          src={url}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          // 내장 브라우저(BrowserPane)의 프리뷰 iframe 과 같은 샌드박스 — allow-same-origin 이 없으면 페이지가 자기
          // data.json 을 fetch 하는 흔한 경우가 CORS 로 깨진다. 팝업·모달·폼은 막는다(alert() 가 앱을 멈추지 않게).
          sandbox="allow-same-origin allow-scripts"
        />
      )}
    </div>
  );
}
