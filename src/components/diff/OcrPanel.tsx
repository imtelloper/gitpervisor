import { Copy, X } from "lucide-react";

import { useMessages } from "../../i18n/ui-language";
import { copyWithToast } from "../../lib/clipboard";
import type { OcrResult } from "../../lib/ipc";

// 어느 OS 엔진이 읽었는지 — 품질 차이가 큰데(태스크 68 §2.2) 결과만 보면 알 수 없다.
const OCR_ENGINE_LABEL: Record<OcrResult["engine"], string> = {
  windows_ocr: "Windows OCR",
  apple_vision: "Apple Vision",
  tesseract_cli: "tesseract",
};

/** 글자 추출 결과 패널 — 이미지 오른쪽 칼럼. 뷰어 분할(태스크 64)엔 최소 폭이 없어
 *  `max-w-[40%]`로 이미지가 실오라기가 되는 것만 막는다(아래로 쌓는 반응형은 없다).
 *  이미지 뷰어(ImageView)와 폴더 창 사진 뷰어(PhotoViewer)가 함께 쓴다 — e2e 54 가 `data-ocr-*` 로 짚는다. */
export function OcrPanel({
  result,
  onHoverLine,
  onClose,
}: {
  result: OcrResult;
  onHoverLine: (i: number | null) => void;
  onClose: () => void;
}) {
  const msg = useMessages();
  return (
    <div
      data-ocr-panel
      className="flex w-80 max-w-[40%] shrink-0 flex-col border-l border-edge bg-panel text-xs"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-fg-dim">
        <span data-ocr-meta className="min-w-0 flex-1 truncate">
          {OCR_ENGINE_LABEL[result.engine]} · {result.languages.join(", ")} ·{" "}
          {msg.git.imageView.ocrLineCount(result.lines.length)}
        </span>
        {/* ImageView 의 TBtn 과 같은 모양 — 그걸 가져오면 ImageView ↔ 이 파일이 서로를 import 한다. */}
        <button
          data-ocr-close
          onClick={onClose}
          title={msg.git.imageView.close}
          className="rounded p-1 hover:bg-raised hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>

      {/* 줄 사이를 가로질러 드래그 선택할 수 있어야 한다 — 그래서 select-text 이고 버튼이 아니다. */}
      <div
        className="min-h-0 flex-1 select-text overflow-y-auto px-2 py-1.5"
        onMouseLeave={() => onHoverLine(null)}
      >
        {result.lines.length === 0 ? (
          <div data-ocr-empty className="px-1 py-3 text-center text-fg-muted">
            {msg.git.imageView.ocrEmpty}
          </div>
        ) : (
          result.lines.map((line, i) => (
            <div
              key={i}
              data-ocr-line={i}
              onMouseEnter={() => onHoverLine(i)}
              className="whitespace-pre-wrap break-all rounded px-1 py-0.5 leading-5 text-fg hover:bg-raised"
            >
              {line.text}
            </div>
          ))
        )}
      </div>

      {/* 품질에 영향을 준 사실은 숨기지 않는다 — 안 보이면 사용자는 "OCR이 고장"으로 읽는다(§5 R1). */}
      {result.warnings.length > 0 && (
        <div className="shrink-0 border-t border-edge px-3 py-1.5 text-warn">
          {result.warnings.map((w, i) => (
            <div key={i} data-ocr-warning className="leading-5">
              {w}
            </div>
          ))}
        </div>
      )}

      <div className="shrink-0 border-t border-edge px-3 py-2">
        <button
          data-ocr-copy
          onClick={() => copyWithToast(result.text)}
          disabled={result.text === ""}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-edge px-2 py-1.5 text-fg-muted hover:bg-raised hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
        >
          <Copy size={13} /> {msg.git.imageView.copyAll}
        </button>
      </div>
    </div>
  );
}
