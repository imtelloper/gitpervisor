// 노드 → PDF 표준 주석 사전 + AP 스트림(설계 §6.2). pdf-lib 저수준 API(`context.obj`·`flateStream`)만 쓴다.
// 페이지에는 `PDFPage` 헬퍼를 쓰지 않는다 — `/Annots` 를 직접 고친다(L2, 아래 setAnnots).
//
// pdf-lib 은 런타임 import 를 하지 않는다(`import type` 만). 호출자(save.ts·import.ts)가 편집 진입·저장 때
// lazy import 한 모듈(`lib`)을 넘긴다 — 정적 import 한 줄이면 600KB 가 PDF 뷰어 청크에 붙는다(설계 §10).

import type {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFObject,
  PDFPage,
  PDFRawStream,
  PDFRef,
} from "@cantoo/pdf-lib";

import { objectAnchor } from "../annotate/geometry";
import { arrowHeadTriangle, headAnchors } from "../annotate/paint";
import type { Fill, GeomNode, Node, TextNode } from "../annotate/types";
import { toPathObject } from "../annotate/vector/convert";
import { toPathCmds, type PathCmd } from "../annotate/vector/path";
import type { Affine, PdfFont, PdfPageInfo, PdfTextLine } from "./model";
import { apply, boundsOf, invert, mul } from "./space";

export type PdfLib = typeof import("@cantoo/pdf-lib");
type Fontkit = typeof import("@cantoo/fontkit").default;
/** pdf-lib 이 export 하지 않는 `LiteralObject` — context.obj/flateStream 이 받는 사전 리터럴. */
type Lit = NonNullable<Parameters<PDFDocument["context"]["flateStream"]>[1]>;

/** PDF 주석으로 쓰는 노드 종류. path 는 다른 앱의 여러 획 Ink 를 가져올 때 생긴다(import.ts). */
export type PdfNode = Extract<
  GeomNode,
  { kind: "rect" | "ellipse" | "line" | "arrow" | "pen" | "highlight" | "text" | "path" }
>;

export function isPdfNode(n: Node): n is PdfNode {
  switch (n.kind) {
    case "rect":
    case "ellipse":
    case "line":
    case "arrow":
    case "pen":
    case "highlight":
    case "text":
    case "path":
      return true;
    default:
      return false;
  }
}

/** FNV-1a 32bit hex — `/GPV_APHash`. floating.ts `fnv16` 과 같은 알고리즘을 바이트에 돌린다. */
export function fnv1aHex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const GPV_NODE = "GPV_Node";
export const GPV_AP_HASH = "GPV_APHash";
const FONT_KEY = "GpvF";

// ── 폰트 ─────────────────────────────────────────────────────────────────────

function isCollection(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66; // "ttcf"
}

/**
 * TTC 면 한글 글리프가 있는 face 의 postscriptName(KR·Regular 우선), 단일 폰트면 undefined.
 * 저장(embedTextFont)과 폰트 사전 검사(fonts.ts)가 같은 face 를 고르도록 한 함수로 둔다.
 */
export function facePostscriptName(fontkit: Fontkit, bytes: Uint8Array): string | undefined {
  if (!isCollection(bytes)) return undefined;
  const opened = fontkit.create(bytes);
  if (!("fonts" in opened)) return undefined;
  let best: { name: string; score: number } | null = null;
  for (const f of opened.fonts) {
    const name = f.postscriptName;
    if (!name || !f.hasGlyphForCodePoint(0xac00)) continue;
    const score = (/KR|Korean/i.test(name) ? 2 : 0) + (/Regular/i.test(name) ? 1 : 0);
    if (!best || score > best.score) best = { name, score };
  }
  if (!best) throw new Error(`facePostscriptName: no face with Hangul glyphs in collection`);
  return best.name;
}

/** 텍스트용 폰트를 문서에 임베드(서브셋). 폰트가 없으면 Helvetica — 라틴 밖 글자는 encodeText 가 던진다. */
export async function embedTextFont(lib: PdfLib, doc: PDFDocument, font: PdfFont | null): Promise<PDFFont> {
  if (!font) return doc.embedFont(lib.StandardFonts.Helvetica);
  const fontkit = (await import("@cantoo/fontkit")).default;
  doc.registerFontkit(fontkit);
  return doc.embedFont(font.bytes, {
    subset: true,
    postscriptName: facePostscriptName(fontkit, font.bytes),
  });
}

// ── /Annots (L2) ─────────────────────────────────────────────────────────────

/** 페이지 /Annots 의 항목들. 없으면 빈 배열. */
export function annotEntries(lib: PdfLib, page: PDFPage): PDFObject[] {
  const raw = page.node.get(lib.PDFName.of("Annots"));
  if (!raw) return [];
  const arr = page.doc.context.lookup(raw);
  if (!(arr instanceof lib.PDFArray)) {
    throw new Error(`page ${page.ref.toString()}: /Annots is not an array`);
  }
  return arr.asArray();
}

/**
 * /Annots 를 entries 로 바꾼다. 간접 배열이면 **그 배열 객체만**, 직접 배열이면 **페이지 사전만** 증분에 들어간다.
 * `page.node.addAnnot` 은 콘텐츠 스트림을 q/Q 로 감싸 서명 문서의 "페이지 내용"을 바꾼다(L2, 부록 A.2-1).
 */
export function setAnnots(lib: PdfLib, page: PDFPage, entries: PDFObject[]): void {
  const ctx = page.doc.context;
  const snap = ctx.snapshot;
  if (!snap) throw new Error("setAnnots: document was not loaded for incremental update");
  const arr: PDFArray = ctx.obj(entries);
  const raw = page.node.get(lib.PDFName.of("Annots"));
  if (raw instanceof lib.PDFRef) {
    ctx.assign(raw, arr);
    snap.markRefForSave(raw);
  } else {
    page.node.set(lib.PDFName.of("Annots"), arr);
    snap.markRefForSave(page.ref);
  }
}

// ── 색·숫자 ──────────────────────────────────────────────────────────────────

/** 내용 스트림용 숫자 — 소수 4자리, 지수 표기·-0 없음. */
function n(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`write: non-finite number ${v}`);
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? "0" : String(r);
}

/** `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA` → [r,g,b] 0–1. 알파는 Fill.opacity 가 따로 든다. */
export function rgbOf(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  const v = Number.parseInt(full.slice(0, 6), 16);
  if (!/^[0-9a-fA-F]{6,8}$/.test(full) || !Number.isFinite(v)) return [0, 0, 0];
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** 페인트 스택의 첫 visible 단색. 그라디언트·이미지는 PDF 주석으로 옮기지 않는다(M2 범위 밖). */
export function firstSolid(stack: readonly Fill[]): { color: string; opacity: number } | null {
  for (const f of stack) {
    if (f.visible && f.type === "solid") return { color: f.color, opacity: f.opacity };
  }
  return null;
}

// ── AP 내용 ──────────────────────────────────────────────────────────────────

function rotationOf(node: GeomNode): Affine | null {
  if (!node.rot || node.rot % 360 === 0) return null;
  const a = objectAnchor(node);
  const r = (node.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, a.x - c * a.x + s * a.y, a.y - s * a.x - c * a.y];
}

/** PathCmd → PDF 경로 연산자. 점은 **pts 에도** 쌓는다(제어점 헐 ⊇ 곡선이라 /Rect 계산에 충분하다). */
function pathOps(cmds: readonly PathCmd[], pts: number[]): string[] {
  const out: string[] = [];
  let cx = 0;
  let cy = 0;
  for (const c of cmds) {
    switch (c.c) {
      case "M":
      case "L":
        out.push(`${n(c.p[0])} ${n(c.p[1])} ${c.c === "M" ? "m" : "l"}`);
        pts.push(c.p[0], c.p[1]);
        [cx, cy] = c.p;
        break;
      case "C":
        out.push(`${c.p.map(n).join(" ")} c`);
        pts.push(...c.p);
        cx = c.p[4];
        cy = c.p[5];
        break;
      case "Q": {
        // PDF 에는 2차 곡선이 없다 — 같은 곡선의 3차 표현으로 올린다.
        const [qx, qy, x, y] = c.p;
        const c1x = cx + (2 / 3) * (qx - cx);
        const c1y = cy + (2 / 3) * (qy - cy);
        const c2x = x + (2 / 3) * (qx - x);
        const c2y = y + (2 / 3) * (qy - y);
        out.push(`${[c1x, c1y, c2x, c2y, x, y].map(n).join(" ")} c`);
        pts.push(c1x, c1y, c2x, c2y, x, y);
        cx = x;
        cy = y;
        break;
      }
      case "Z":
        out.push("h");
        break;
    }
  }
  return out;
}

const CAP = { butt: 0, round: 1, square: 2 } as const;
const JOIN = { miter: 0, round: 1, bevel: 2 } as const;

interface Appearance {
  content: string;
  /** page space(회전 전 로컬) 점열 — /Rect 계산용. */
  pts: number[];
  /** 선이 기하 밖으로 나가는 양(page 단위). */
  pad: number;
  resources: Lit;
}

function gsDict(node: GeomNode, strokeA: number, fillA: number): Lit | null {
  const multiply = node.kind === "highlight" || node.blend === "multiply";
  if (strokeA >= 1 && fillA >= 1 && !multiply) return null;
  return { Type: "ExtGState", CA: strokeA, ca: fillA, ...(multiply ? { BM: "Multiply" } : {}) };
}

/**
 * 펜·형광펜은 화면 렌더(geometry.ts penPath)와 같은 midpoint 2차 베지어로 쓴다. toPathObject 의 fitPolyline 은
 * 꺾임각을 모서리로 남겨, 성긴 획이 화면에선 곡선인데 저장본에선 꺾은선이 됐다(통합 검증 실측).
 */
function penCmds(pts: readonly number[]): PathCmd[] {
  const k = Math.floor(pts.length / 2);
  const out: PathCmd[] = [{ c: "M", p: [pts[0], pts[1]] }];
  for (let i = 1; i < k - 1; i++)
    out.push({ c: "Q", p: [pts[i * 2], pts[i * 2 + 1], (pts[i * 2] + pts[i * 2 + 2]) / 2, (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2] });
  out.push({ c: "L", p: [pts[(k - 1) * 2], pts[(k - 1) * 2 + 1]] });
  return out;
}

function shapeAppearance(node: Exclude<PdfNode, TextNode>): Appearance {
  const freehand = node.kind === "pen" || node.kind === "highlight";
  const path = freehand ? null : toPathObject(node);
  const pts: number[] = [];
  const ops: string[] = [];
  const stroke = node.strokeWidth > 0 ? firstSolid(node.strokes) : null;
  const closed =
    node.kind === "rect" ||
    node.kind === "ellipse" ||
    (node.kind === "path" && node.subpaths.some((s) => s.closed && s.verts.length > 1));
  const fill = closed ? firstSolid(node.fills) : null;
  const heads = stroke ? headAnchors(node) : null;
  const strokeA = node.opacity * (stroke?.opacity ?? 1);
  // 열린 경로는 채우기가 없고, 채워지는 것은 화살촉(선 색)뿐이다 — 그래서 ca 도 선 알파를 쓴다.
  const fillA = node.opacity * (closed ? (fill?.opacity ?? 1) : (stroke?.opacity ?? 1));
  const gs = gsDict(node, strokeA, fillA);
  if (gs) ops.push("/GS0 gs");
  if (stroke) {
    const [r, g, b] = rgbOf(stroke.color);
    ops.push(`${n(r)} ${n(g)} ${n(b)} RG`, `${n(node.strokeWidth)} w`, `${CAP[node.cap]} J`, `${JOIN[node.join]} j`);
    if (node.join === "miter") ops.push(`${n(Math.max(1, node.miterLimit))} M`);
    if (node.dash && node.dash.length) ops.push(`[${node.dash.map(n).join(" ")}] 0 d`);
  }
  if (fill) {
    const [r, g, b] = rgbOf(fill.color);
    ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
  }
  if (path) {
    ops.push(...pathOps(toPathCmds(path), pts));
    const evenodd = node.kind === "path" && node.fillRule === "evenodd";
    ops.push(stroke && fill ? (evenodd ? "B*" : "B") : fill ? (evenodd ? "f*" : "f") : stroke ? "S" : "n");
  } else if (freehand && node.pts.length >= 4) {
    ops.push(...pathOps(penCmds(node.pts), pts), stroke ? "S" : "n");
  } else if (freehand) {
    // 점 하나짜리 획 — 화면은 round cap 점을 찍는다. 같은 점으로 가는 0 길이 선이 PDF 에서도 cap 점을 낸다.
    if (node.pts.length >= 2 && stroke) {
      ops.push(`${n(node.pts[0])} ${n(node.pts[1])} m`, `${n(node.pts[0])} ${n(node.pts[1])} l`, "S");
      pts.push(node.pts[0], node.pts[1]);
    }
  }
  if (heads && stroke) {
    const [r, g, b] = rgbOf(stroke.color);
    ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
    for (const h of [heads.start, heads.end]) {
      const tri = h ? arrowHeadTriangle(h, node.strokeWidth) : null;
      if (!tri) continue;
      ops.push(`${n(tri[0])} ${n(tri[1])} m`, `${n(tri[2])} ${n(tri[3])} l`, `${n(tri[4])} ${n(tri[5])} l`, "h f");
      pts.push(...tri);
    }
  }
  const miter = node.join === "miter" ? Math.max(1, node.miterLimit) : 1;
  return {
    content: ops.join("\n"),
    pts,
    pad: stroke ? (node.strokeWidth / 2) * Math.max(miter, Math.SQRT2) : 0,
    resources: gs ? { ExtGState: { GS0: gs } } : {},
  };
}

function textAppearance(node: TextNode, lines: readonly PdfTextLine[], font: PDFFont): Appearance {
  const fill = firstSolid(node.fills) ?? { color: "#000000", opacity: 1 };
  const [r, g, b] = rgbOf(fill.color);
  const fs = node.fontSize;
  const gs = gsDict(node, node.opacity * fill.opacity, node.opacity * fill.opacity);
  const ops: string[] = [];
  if (gs) ops.push("/GS0 gs");
  ops.push(`${n(r)} ${n(g)} ${n(b)} rg`, "BT", `/${FONT_KEY} ${n(fs)} Tf`);
  const spacing = (fs * node.letterSpacing) / 100;
  if (spacing) ops.push(`${n(spacing)} Tc`);
  const pts = [node.x, node.y, node.x + node.w, node.y + node.h];
  for (const l of lines) {
    if (!l.text) continue;
    // y-down 공간에서 글리프를 바로 세운다(§5) — 경로는 뒤집혀도 같지만 글리프는 뒤집힌다.
    ops.push(`1 0 0 -1 ${n(l.x)} ${n(l.baseline)} Tm`, `${font.encodeText(l.text).toString()} Tj`);
    const wd = font.widthOfTextAtSize(l.text, fs) + spacing * [...l.text].length;
    pts.push(l.x, l.baseline - fs * 1.1, l.x + wd, l.baseline + fs * 0.35);
  }
  ops.push("ET");
  return {
    content: ops.join("\n"),
    pts,
    pad: 0,
    resources: { Font: { [FONT_KEY]: font.ref }, ...(gs ? { ExtGState: { GS0: gs } } : {}) },
  };
}

// ── 주석 사전 ────────────────────────────────────────────────────────────────

export interface WriteCtx {
  lib: PdfLib;
  doc: PDFDocument;
  textLines: (node: TextNode) => PdfTextLine[];
  /** 텍스트 노드가 있을 때만 한 번 임베드한다(서브셋은 이 저장에서 encodeText 한 글리프만 담긴다). */
  textFont: () => Promise<PDFFont>;
}

/** 우리가 값을 정하는 키 — 다른 앱 주석을 고칠 때 이 밖의 키(/T 작성자·/Popup·모르는 키)는 보존한다(§6.3). */
const MANAGED = [
  "Type", "Subtype", "Rect", "NM", "F", "M", "P", "C", "IC", "CA", "ca", "BS", "Border", "BE", "RD",
  "L", "LE", "LL", "LLE", "LLO", "Cap", "IT", "InkList", "AP", "AS", "DA", "DS", "RC", "Q",
  GPV_NODE, GPV_AP_HASH,
];

function subtypeOf(node: PdfNode): string {
  switch (node.kind) {
    case "rect":
      return "Square";
    case "ellipse":
      return "Circle";
    case "line":
    case "arrow":
      return "Line";
    case "pen":
    case "highlight":
    case "path":
      return "Ink";
    case "text":
      return "FreeText";
  }
}

/**
 * 노드 하나의 주석 사전을 만든다(AP 스트림은 여기서 register). `base` 는 같은 ref 에 있던 기존 사전 —
 * 있으면 우리가 관리하지 않는 키를 옮겨 담는다. 반환한 사전의 register/assign 은 호출자 몫이다.
 */
export async function buildAnnotDict(
  c: WriteCtx,
  node: PdfNode,
  info: PdfPageInfo,
  pageRef: PDFRef,
  base: PDFDict | null,
): Promise<PDFDict> {
  const { lib, doc } = c;
  const ctx = doc.context;
  const N = (s: string) => lib.PDFName.of(s);
  const toUser = invert(info.toPage);
  const rot = rotationOf(node);
  const local = rot ? mul(rot, toUser) : toUser;
  const scale = Math.sqrt(Math.abs(toUser[0] * toUser[3] - toUser[1] * toUser[2]));

  const ap =
    node.kind === "text"
      ? textAppearance(node, c.textLines(node), await c.textFont())
      : shapeAppearance(node);
  const b = boundsOf(local, ap.pts) ?? (() => {
    const [x, y] = apply(local, 0, 0);
    return [x, y, x, y] as [number, number, number, number];
  })();
  const pad = ap.pad * scale + 1;
  const rect: [number, number, number, number] = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];

  const content = [
    "q",
    `${toUser.map(n).join(" ")} cm`,
    ...(rot ? [`${rot.map(n).join(" ")} cm`] : []),
    ap.content,
    "Q",
  ].join("\n");
  const stream: PDFRawStream = ctx.flateStream(content, {
    Type: "XObject",
    Subtype: "Form",
    BBox: rect,
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: ap.resources,
  });
  const apRef = ctx.register(stream);

  const stroke = node.strokeWidth > 0 ? firstSolid(node.strokes) : null;
  const fill = node.kind === "rect" || node.kind === "ellipse" ? firstSolid(node.fills) : null;
  const dict = ctx.obj({});
  if (base) {
    for (const [k, v] of base.entries()) {
      if (!MANAGED.includes(k.decodeText())) dict.set(k, v);
    }
  }
  const set = (k: string, v: PDFObject) => dict.set(N(k), v);
  set("Type", N("Annot"));
  set("Subtype", N(subtypeOf(node)));
  set("Rect", ctx.obj(rect));
  set("NM", lib.PDFHexString.fromText(node.id));
  set("F", ctx.obj(node.visible ? 4 : 4 | 2));
  set("M", lib.PDFString.fromDate(new Date()));
  set("P", pageRef);
  set("CA", ctx.obj(node.opacity));
  if (node.kind !== "text" && stroke) set("C", ctx.obj(rgbOf(stroke.color)));
  set(
    "BS",
    ctx.obj({
      Type: "Border",
      W: node.kind === "text" || !stroke ? 0 : node.strokeWidth,
      S: node.dash && node.dash.length ? "D" : "S",
      ...(node.dash && node.dash.length ? { D: node.dash } : {}),
    }),
  );

  const userPts = (flat: readonly number[]) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push(...apply(local, flat[i], flat[i + 1]));
    return out;
  };
  switch (node.kind) {
    case "rect":
    case "ellipse": {
      if (fill) set("IC", ctx.obj(rgbOf(fill.color)));
      // /RD = /Rect 와 실제 도형(선 바깥 가장자리) 사이 — 다른 앱이 표준 키로 다시 그릴 때 같은 자리에 그린다.
      const sw = (stroke ? node.strokeWidth / 2 : 0) * scale;
      const g = boundsOf(local, [node.x, node.y, node.x + node.w, node.y + node.h, node.x + node.w, node.y, node.x, node.y + node.h]);
      if (g) {
        const rd = [g[0] - sw - rect[0], rect[3] - (g[3] + sw), rect[2] - (g[2] + sw), g[1] - sw - rect[1]];
        set("RD", ctx.obj(rd.map((v) => Math.max(0, v))));
      }
      break;
    }
    case "line":
    case "arrow": {
      set("L", ctx.obj(userPts([node.x1, node.y1, node.x2, node.y2])));
      const le = (h: "none" | "arrow") => (h === "arrow" ? "ClosedArrow" : "None");
      set("LE", ctx.obj([le(node.heads.start), le(node.heads.end)]));
      if (stroke && (node.heads.start === "arrow" || node.heads.end === "arrow")) {
        set("IC", ctx.obj(rgbOf(stroke.color)));
      }
      break;
    }
    case "pen":
    case "highlight":
      set("InkList", ctx.obj([userPts(node.pts)]));
      break;
    case "path":
      set("InkList", ctx.obj(node.subpaths.map((s) => userPts(s.verts.flatMap((v) => [v.x, v.y])))));
      break;
    case "text": {
      const color = firstSolid(node.fills)?.color ?? "#000000";
      const [r, g, bl] = rgbOf(color);
      set("Contents", lib.PDFHexString.fromText(node.text));
      set("DA", lib.PDFString.of(`/${FONT_KEY} ${n(node.fontSize)} Tf ${n(r)} ${n(g)} ${n(bl)} rg`));
      set("Q", ctx.obj(node.align === "center" ? 1 : node.align === "right" ? 2 : 0));
      break;
    }
  }
  set("AP", ctx.obj({ N: apRef }));
  set(GPV_NODE, lib.PDFHexString.fromText(JSON.stringify(node)));
  set(GPV_AP_HASH, lib.PDFString.of(fnv1aHex(stream.contents)));
  return dict;
}
