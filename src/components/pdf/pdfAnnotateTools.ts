// PDF 주석 모드의 도구 목록·기본 페인트 — PdfView 레일과 e2e 62(레일 순서 단언)가 이 순서를 계약으로 본다.

import { DEFAULT_PAINT, type DefaultPaint } from "../../lib/annotate/types";
import type { RailItem } from "../image/ToolRail";

/** PDF 도구 집합(설계 §8.1). vpen(베지어)·크롭·모자이크는 없다. */
export const PDF_TOOLS: readonly RailItem["id"][] = [
  "select",
  "hand",
  "text",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "pen",
  "highlight",
  "image", // 도구가 아니라 한 번의 동작 — ToolRail 이 onPlaceImage 를 부른다(M3 T2)
];

/** 기본 페인트 — 값이 문서 단위라 pt 다(설계 Q5 본문 14pt). */
export const PDF_PAINT: DefaultPaint = {
  ...DEFAULT_PAINT,
  strokeWidth: 2,
  fontSize: 14,
  typo: { ...DEFAULT_PAINT.typo, fontSize: 14 },
};
