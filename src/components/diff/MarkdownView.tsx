import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 트리에서 연 .md 파일을 GitHub 스타일로 렌더한다(GFM 표·체크박스 지원). */
export default function MarkdownView({ content }: { content: string }) {
  return (
    <div className="h-full overflow-auto bg-base">
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
