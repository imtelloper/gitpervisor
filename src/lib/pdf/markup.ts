// 텍스트 마크업(M3 T1)·서명 노드(T3) — 선택 사각형 → page space quad, quad → 표준 주석 사전 + AP.
// 설계: DOCS/pdf-viewer-editor-design.md §6.1(PdfMarkup), 계약: DOCS/task/75-pdf-m3-m4.md T1·T3.
//
// pdf-lib 은 `import type` 만 — 호출자(save.ts)가 lazy import 한 모듈을 넘긴다(write.ts 와 같은 이유).

import type { PDFDict, PDFDocument, PDFRef } from "@cantoo/pdf-lib";

import { normalizeDoc } from "../annotate/schema";
import { newObjId, type Node } from "../annotate/types";
import type { PdfMarkup, PdfPageInfo } from "./model";
import { boundsOf, invert, apply } from "./space";
import { fnv1aHex, GPV_AP_HASH, GPV_NODE, MANAGED_KEYS, pdfNum as n, rgbOf, type PdfLib } from "./write";

export type MarkupSubtype = PdfMarkup["subtype"];
export const MARKUP_SUBTYPES: readonly MarkupSubtype[] = ["Highlight", "Underline", "StrikeOut"];
export const MARKUP_DEFAULT_COLOR: Record<MarkupSubtype, string> = {
  Highlight: "#FFD54F",
  Underline: "#1E88E5",
  StrikeOut: "#E53935",
};

export function isMarkupSubtype(s: string): s is MarkupSubtype {
  return (MARKUP_SUBTYPES as readonly string[]).includes(s);
}

/** page space 축정렬 사각형. */
export interface PageRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 선택 사각형(글자·스팬 조각)을 줄마다 하나로 합친다. 세로 중심이 서로의 높이 안에 들면 같은 줄이다 —
 * 같은 줄의 굵은 글씨·첨자 스팬은 높이가 조금씩 달라 위아래 겹침만으로는 줄이 갈라진다.
 */
export function mergeLineRects(rects: readonly PageRect[]): PageRect[] {
  const rs = rects.filter((r) => r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5).sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const lines: PageRect[] = [];
  for (const r of rs) {
    const cy = (r.y0 + r.y1) / 2;
    const line = lines.find((l) => {
      const lc = (l.y0 + l.y1) / 2;
      const half = Math.min(l.y1 - l.y0, r.y1 - r.y0) / 2;
      return Math.abs(lc - cy) <= half;
    });
    if (line) {
      line.x0 = Math.min(line.x0, r.x0);
      line.y0 = Math.min(line.y0, r.y0);
      line.x1 = Math.max(line.x1, r.x1);
      line.y1 = Math.max(line.y1, r.y1);
    } else lines.push({ ...r });
  }
  return lines;
}

/** 사각형 → QuadPoints 순서(좌상·우상·좌하·우하) 8개씩, page space. */
export function quadsOfRects(rects: readonly PageRect[]): number[] {
  return rects.flatMap((r) => [r.x0, r.y0, r.x1, r.y0, r.x0, r.y1, r.x1, r.y1]);
}

/** quad 하나의 외접 상자(회전 페이지·다른 앱 quad 는 축정렬이 아닐 수 있다). */
export function quadBoxes(quads: readonly number[]): PageRect[] {
  const out: PageRect[] = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
    const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
    out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  return out;
}

/** 그 페이지에서 (x,y)에 맞는 마크업 — 위에 그려진(뒤에 있는) 것부터. tol 은 page 단위. */
export function hitMarkup(
  markups: readonly PdfMarkup[],
  pageKey: string,
  x: number,
  y: number,
  tol: number,
): PdfMarkup | null {
  for (let i = markups.length - 1; i >= 0; i--) {
    const m = markups[i];
    if (m.pageKey !== pageKey) continue;
    if (quadBoxes(m.quads).some((b) => x >= b.x0 - tol && x <= b.x1 + tol && y >= b.y0 - tol && y <= b.y1 + tol)) return m;
  }
  return null;
}

/** 규칙 1 JSON → 마크업. 모양이 어긋나면 null(규칙 2가 표준 키로 다시 판정한다). pageKey 는 지금 페이지 것으로. */
export function markupFromJson(raw: unknown, pageKey: string): PdfMarkup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>; // 외부 데이터 경계 — 아래에서 필드마다 검사한다
  const quads = Array.isArray(r.quads) ? r.quads.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
  if (
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.subtype !== "string" ||
    !isMarkupSubtype(r.subtype) ||
    !quads.length ||
    quads.length % 8 !== 0 ||
    typeof r.color !== "string"
  )
    return null;
  const opacity = typeof r.opacity === "number" && Number.isFinite(r.opacity) ? Math.min(1, Math.max(0, r.opacity)) : 1;
  return { id: r.id, pageKey, subtype: r.subtype, quads, color: r.color, opacity };
}

// ── AP ───────────────────────────────────────────────────────────────────────

/** 밑줄·취소선이 quad 높이의 어디(위→아래 0→1)에 얼마나 굵게 — pdf.js 텍스트 레이어 줄 상자는 기준선이 ≈0.7 에 온다(dev 앱 실측). */
export const MARKUP_LINE_AT: Record<Exclude<MarkupSubtype, "Highlight">, number> = { Underline: 0.8, StrikeOut: 0.55 };
export const MARKUP_LINE_WIDTH = 0.07;

function markupContent(m: PdfMarkup): string {
  const [r, g, b] = rgbOf(m.color);
  const ops: string[] = ["/GS0 gs"];
  const q = m.quads;
  if (m.subtype === "Highlight") {
    ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
    for (let i = 0; i + 7 < q.length; i += 8) {
      // 좌상 → 우상 → 우하 → 좌하 (QuadPoints 순서는 좌하·우하가 뒤바뀐 Z 자다)
      ops.push(`${n(q[i])} ${n(q[i + 1])} m ${n(q[i + 2])} ${n(q[i + 3])} l ${n(q[i + 6])} ${n(q[i + 7])} l ${n(q[i + 4])} ${n(q[i + 5])} l h`);
    }
    ops.push("f");
  } else {
    const t = MARKUP_LINE_AT[m.subtype];
    ops.push(`${n(r)} ${n(g)} ${n(b)} RG`, "0 J");
    for (let i = 0; i + 7 < q.length; i += 8) {
      // 왼변(좌상→좌하)·오른변(우상→우하)에서 같은 비율 지점을 잇는다 — 회전된 quad 에서도 글줄을 따라간다.
      const lx = q[i] + (q[i + 4] - q[i]) * t;
      const ly = q[i + 1] + (q[i + 5] - q[i + 1]) * t;
      const rx = q[i + 2] + (q[i + 6] - q[i + 2]) * t;
      const ry = q[i + 3] + (q[i + 7] - q[i + 3]) * t;
      const h = Math.hypot(q[i + 4] - q[i], q[i + 5] - q[i + 1]);
      ops.push(`${n(Math.max(0.5, h * MARKUP_LINE_WIDTH))} w ${n(lx)} ${n(ly)} m ${n(rx)} ${n(ry)} l S`);
    }
  }
  return ops.join("\n");
}

/**
 * 마크업 하나의 주석 사전(AP 스트림은 여기서 register). `base` 는 같은 ref 에 있던 기존 사전 — 우리가 관리하지 않는 키
 * (/T 작성자·/Popup 등)를 옮겨 담는다(write.ts buildAnnotDict 와 같은 규칙). register/assign 은 호출자 몫이다.
 */
export function buildMarkupDict(
  lib: PdfLib,
  doc: PDFDocument,
  m: PdfMarkup,
  info: PdfPageInfo,
  pageRef: PDFRef,
  base: PDFDict | null,
): PDFDict {
  const ctx = doc.context;
  const N = (s: string) => lib.PDFName.of(s);
  const toUser = invert(info.toPage);
  const b = boundsOf(toUser, m.quads);
  if (!b) throw new Error(`buildMarkupDict: markup ${m.id} has no quads`);
  const rect = [b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1];
  const gs = {
    Type: "ExtGState",
    CA: m.opacity,
    ca: m.opacity,
    ...(m.subtype === "Highlight" ? { BM: "Multiply" } : {}),
  };
  const stream = ctx.flateStream(["q", `${toUser.map(n).join(" ")} cm`, markupContent(m), "Q"].join("\n"), {
    Type: "XObject",
    Subtype: "Form",
    BBox: rect,
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { ExtGState: { GS0: gs } },
  });
  const apRef = ctx.register(stream);
  const userQuads: number[] = [];
  for (let i = 0; i + 1 < m.quads.length; i += 2) userQuads.push(...apply(toUser, m.quads[i], m.quads[i + 1]));

  const dict = ctx.obj({});
  if (base) {
    for (const [k, v] of base.entries()) {
      const name = k.decodeText();
      if (!MANAGED_KEYS.includes(name) && name !== "QuadPoints") dict.set(k, v);
    }
  }
  dict.set(N("Type"), N("Annot"));
  dict.set(N("Subtype"), N(m.subtype));
  dict.set(N("Rect"), ctx.obj(rect));
  dict.set(N("NM"), lib.PDFHexString.fromText(m.id));
  dict.set(N("F"), ctx.obj(4));
  dict.set(N("M"), lib.PDFString.fromDate(new Date()));
  dict.set(N("P"), pageRef);
  dict.set(N("C"), ctx.obj(rgbOf(m.color)));
  dict.set(N("CA"), ctx.obj(m.opacity));
  dict.set(N("QuadPoints"), ctx.obj(userQuads));
  dict.set(N("AP"), ctx.obj({ N: apRef }));
  // pageKey 는 넣지 않는다 — 다시 열 때 그 주석이 달린 페이지가 정본이다(순서 변경·추출 뒤에도).
  const { pageKey: _pageKey, ...json } = m;
  dict.set(N(GPV_NODE), lib.PDFHexString.fromText(JSON.stringify(json)));
  dict.set(N(GPV_AP_HASH), lib.PDFString.of(fnv1aHex(stream.contents)));
  return dict;
}

// ── 서명(T3) ─────────────────────────────────────────────────────────────────

/** 서명 패드가 저장하는 획 — 패드 px 좌표 평탄 점열. */
export interface SignatureStrokes {
  w: number;
  h: number;
  strokes: number[][];
}

/**
 * 서명 → path 노드 하나(서브패스 = 획). 그룹이 아니라 path 인 이유: write.ts 는 그룹을 PDF 주석으로 못 쓰고(M2 계약),
 * 개별 펜 노드면 이동·크기조절이 획마다 따로 논다. path 는 Ink 하나(InkList 여러 개)로 저장되고 규칙 1·2 둘 다로 돌아온다.
 * (cx,cy) = 놓을 중심(page space), width = 서명 폭(pt).
 */
export function signatureToPathNode(
  sig: SignatureStrokes,
  cx: number,
  cy: number,
  width: number,
  color: string,
  strokeWidth: number,
): Node {
  const k = width / Math.max(1, sig.w);
  const x0 = cx - (sig.w * k) / 2;
  const y0 = cy - (sig.h * k) / 2;
  const vert = (x: number, y: number) => ({ x: x0 + x * k, y: y0 + y * k, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" });
  const subpaths = sig.strokes
    .filter((s) => s.length >= 2)
    .map((s) => ({ verts: Array.from({ length: Math.floor(s.length / 2) }, (_, i) => vert(s[i * 2], s[i * 2 + 1])), closed: false }));
  const node = normalizeDoc({
    objects: [
      {
        id: newObjId(),
        parentId: null,
        kind: "path",
        subpaths,
        fills: [],
        strokes: [{ type: "solid", color, opacity: 1, visible: true, blend: "normal" }],
        strokeWidth,
        cap: "round",
        join: "round",
      },
    ],
  }).objects[0];
  if (!node) throw new Error("signatureToPathNode: signature has no strokes");
  return node;
}
