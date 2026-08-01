import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { copyText } from "../../lib/clipboard";
import { useUi } from "../../stores/ui";

/** 트리에서 연 .md 파일을 GitHub 스타일로 렌더한다(GFM 표·체크박스 지원). */
export default function MarkdownView({ content }: { content: string }) {
  return (
    <div className="relative h-full overflow-auto bg-base">
      {/* 렌더된 문서는 드래그로 통째 선택하기 번거로워 원문을 한 번에 집어가는 버튼을 둔다.
          스크롤되는 본문과 달리 컨테이너 기준 absolute라 긴 문서에서도 우측 상단에 남는다. */}
      <CopyAllButton content={content} />
      <div className="md-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 웹뷰가 문서 밖으로 이동하면 앱이 깨지므로 링크 기본 동작을 막는다.
            a(props) {
              const { href, children } = props;
              return (
                <a href={href} onClick={(e) => e.preventDefault()}>
                  {children}
                </a>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** 마크다운 **원문**(렌더 결과가 아니라)을 통째로 클립보드에 넣는다.
 *  복사는 lib/clipboard의 copyText — WKWebView의 한글 깨짐을 우회하는 네이티브 경로다
 *  (TROUBLESHOOTING §7). 성공은 버튼 자체가 잠깐 "복사됨"으로 바뀌어 알리고(토스트는
 *  과하다), 실패만 토스트로 표면화한다. */
function CopyAllButton({ content }: { content: string }) {
  const pushToast = useUi((s) => s.pushToast);
  const [done, setDone] = useState(false);

  // 다른 파일로 전환되면 이전 파일의 "복사됨" 표시가 남지 않게 되돌린다.
  useEffect(() => setDone(false), [content]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);

  return (
    <button
      onClick={() =>
        void copyText(content).then((ok) =>
          ok ? setDone(true) : pushToast("error", "복사에 실패했습니다"),
        )
      }
      title="전체 내용 복사 — 렌더된 화면이 아니라 마크다운 원문을 복사합니다"
      // 본문(.md-body)은 최대 880px 중앙 정렬이라 넓은 화면에선 우측 여백에 놓이지만,
      // 창이 좁으면 첫 제목과 겹칠 수 있다 — 평소엔 살짝 흐리게 둬 읽기를 방해하지 않는다.
      className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded border border-edge bg-panel/95 px-2 py-1 text-[11px] text-fg-muted opacity-70 shadow-sm transition-opacity hover:bg-raised hover:text-fg hover:opacity-100"
    >
      {done ? (
        <>
          <Check size={12} className="text-add" /> 복사됨
        </>
      ) : (
        <>
          <Copy size={12} /> 전체 복사
        </>
      )}
    </button>
  );
}
