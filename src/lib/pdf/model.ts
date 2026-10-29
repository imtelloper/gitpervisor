// PDF 주석 편집(M2)의 공용 모델 — 화면(PdfView·오버레이)과 저장·가져오기(save/import)가 함께 쓰는 계약.
// 설계: DOCS/pdf-viewer-editor-design.md §5·§6, 구현 계약: DOCS/task/74-pdf-annotate-m2.md
//
// 좌표는 전부 **page space**(pt, 좌상단 원점 y-down, /Rotate 적용 = pdf.js `page.getViewport({scale:1})`).

import type { EditorDoc, Node } from "../annotate/types";

/** 아핀 [a,b,c,d,e,f] — x' = a·x + c·y + e, y' = b·x + d·y + f (pdf.js·PDF 행렬 순서). */
export type Affine = [number, number, number, number, number, number];

export interface PdfPageInfo {
  /** 0부터. M2 는 페이지 순서를 바꾸지 않으므로 index 가 곧 페이지 식별자다(M4 에서 pageKey 로). */
  index: number;
  /** page space 크기(pt, /Rotate 적용 후). */
  w: number;
  h: number;
  /** PDF user space → page space. pdf.js `page.getViewport({ scale: 1 }).transform` 그대로 — 변환의 출처는 이것 하나다. */
  toPage: Affine;
}

/** 저장·가져오기 장부 — 히스토리 **밖**에 둔다(설계 §6.1). 참조 비교로 new/changed/deleted 를 가른다. */
export interface PdfLedger {
  /** 노드 id → 파일 안 주석 객체 참조 `"45 0 R"`. */
  refs: Map<string, string>;
  /** 마지막 가져오기/저장 시점의 노드 **참조**. `현재 !== saved.get(id)` 면 changed. */
  saved: Map<string, Node>;
  /** 노드 id → 그 시점 페이지 index. */
  pageOf: Map<string, number>;
}

export const emptyLedger = (): PdfLedger => ({ refs: new Map(), saved: new Map(), pageOf: new Map() });

/** 텍스트 노드 한 줄 — 화면(text-layout.ts)이 계산한 줄을 저장이 **그대로** 쓴다(§6.4 2항). page space. */
export interface PdfTextLine {
  text: string;
  /** 줄 시작 x(정렬 반영 후). */
  x: number;
  /** 베이스라인 y. */
  baseline: number;
}

/** 저장·화면이 같은 바이트를 쓰는 임베드 폰트(§6.4 1항). `family` 는 등록한 FontFace 이름. */
export interface PdfFont {
  family: string;
  bytes: Uint8Array;
}

/** 편집 상태 — 페이지마다 annotate 엔진 문서 하나(index = 페이지 index). */
export type PdfPagesDoc = EditorDoc[];
