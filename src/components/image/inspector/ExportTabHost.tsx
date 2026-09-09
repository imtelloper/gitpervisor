// 인스펙터 **내보내기** 탭 — 저장 포맷과 품질(v1 우측 패널에서 이관).
//
// 여기 값이 푸터 `저장 (PNG)` 라벨의 출처다. 두 곳이 같은 `format` 을 봐야 사용자가 고른
// 포맷과 저장 버튼이 말하는 포맷이 어긋나지 않는다 — 그래서 이 탭은 상태를 들지 않는다.
//
// 태스크 52 의 `ExportSection`(노드 내보내기 행·프리셋·`내보내기…`) 자리는 **비워 둔다.**
// 껍데기를 그리면 눌러도 아무 일이 없는 버튼이 생기고, 사용자는 그것을 고장으로 읽는다.
//
// `Section`·`Slider` 를 `AdjustTab` 에서 가져오는 이유는 하나뿐이다 — 같은 모양을 두 번
// 적지 않으려고. 통합 단계가 공용 자리로 옮기면 그쪽으로 따라간다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.3

import { FORMATS, supportsQuality, type ImgFormat } from "../../../lib/image-codec";
import { Section, Slider } from "./AdjustTab";

export interface ExportTabHostProps {
  format: ImgFormat;
  onFormat(f: ImgFormat): void;
  quality: number;
  onQuality(v: number): void;
}

export function ExportTabHost({ format, onFormat, quality, onQuality }: ExportTabHostProps) {
  return (
    <Section title="포맷">
      <div className="grid grid-cols-4 gap-1.5">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            onClick={() => onFormat(f.id)}
            className={`rounded px-2 py-1 text-[12px] ${
              format === f.id
                ? "bg-accent text-on-accent"
                : "bg-raised text-fg-muted hover:text-fg"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {/* png 은 무손실이라 품질 슬라이더가 뜻이 없다 — 보여 주면 움직여도 파일이 안 바뀐다. */}
      {supportsQuality(format) && (
        <div className="mt-2">
          <Slider label="품질" value={quality} onChange={onQuality} min={1} max={100} />
        </div>
      )}
    </Section>
  );
}
