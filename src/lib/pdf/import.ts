// 파일 안 주석 → 편집 노드(설계 §6.3 규칙 1~3) + 표시용 작업 사본 inc₀(K6).
//
// 규칙은 주석마다 첫 번째로 참인 것 하나만 적용한다:
//   1. /GPV_Node 가 있고 AP /N 원시 바이트의 FNV 가 /GPV_APHash 와 같다 → 우리가 쓴 그대로(JSON 무손실 복원)
//   2. 무손실로 옮길 수 있는 표준 주석(Square·Circle·Line·Ink·평문 FreeText) → 표준 키에서 노드 생성
//   3. 그 외 → 건드리지 않는다(pdf.js 가 그린다)
// 규칙 2 가 우리 JSON 보다 앞서는 경우(해시 불일치)는 다른 앱이 고친 뒤다 — 그 앱의 표준 키가 정본이다.

import type { PDFArray, PDFDict, PDFObject, PDFPage, PDFRawStream, PDFRef } from "@cantoo/pdf-lib";

import { currentLocale } from "../../i18n/locale-state";
import { messagesFor } from "../../i18n/messages";
import { normalizeDoc } from "../annotate/schema";
import { DEFAULT_FONT_FAMILY, solidFill, type EditorDoc, type Node } from "../annotate/types";
import { isMarkupSubtype, markupFromJson, quadBoxes, quadsOfRects } from "./markup";
import { emptyLedger, type PdfFont, type PdfLedger, type PdfMarkup, type PdfPageInfo } from "./model";
import { incrementOf, loadForIncrement, removeAnnots } from "./save";
import { apply, boundsOf } from "./space";
import { annotEntries, fnv1aHex, GPV_AP_HASH, GPV_ASSET, GPV_NODE, isPdfNode, type PdfLib } from "./write";

export interface ImportResult {
  pages: EditorDoc[];            // pages.length === infos.length. 편집 가능 주석이 노드로 들어 있다
  ledger: PdfLedger;
  /** 편집 가능 주석을 /Annots 에서 뺀 표시용 바이트(원본 ⧺ inc₀). 가져온 주석이 없으면 null(원본 그대로 표시) */
  workingCopy: Uint8Array | null;
  /** 텍스트 노드 중 폰트가 없어 기본 폰트로 바꾼 수 등 — 사용자 안내용 */
  notes: string[];
  /** 텍스트 마크업(M3) — 노드처럼 장부에 올리고 작업 사본에서 뺀다. */
  markups: PdfMarkup[];
}

type Rec = Record<string, unknown>;

function hex2(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

/** /C·/IC 색 배열(0·1·3·4 성분) → `#RRGGBB`. 0 성분은 투명 = null. */
function colorOf(lib: PdfLib, arr: PDFArray | undefined): string | null {
  if (!arr) return null;
  const v = arr.asArray().map((o) => (o instanceof lib.PDFNumber ? o.asNumber() : 0));
  if (v.length === 1) return `#${hex2(v[0]).repeat(3)}`;
  if (v.length === 3) return `#${hex2(v[0])}${hex2(v[1])}${hex2(v[2])}`;
  if (v.length === 4) {
    const k = v[3];
    return `#${hex2((1 - v[0]) * (1 - k))}${hex2((1 - v[1]) * (1 - k))}${hex2((1 - v[2]) * (1 - k))}`;
  }
  return null;
}

function nums(lib: PdfLib, arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  return arr.asArray().map((o) => (o instanceof lib.PDFNumber ? o.asNumber() : Number.NaN)).filter(Number.isFinite);
}

function textOf(lib: PdfLib, o: PDFObject | undefined): string | null {
  return o instanceof lib.PDFHexString || o instanceof lib.PDFString ? o.decodeText() : null;
}

/** 규칙 1 — 해시가 맞을 때만 우리 JSON 을 믿는다. */
function rule1(lib: PdfLib, d: PDFDict): Rec | null {
  const json = textOf(lib, d.get(lib.PDFName.of(GPV_NODE)));
  const hash = textOf(lib, d.get(lib.PDFName.of(GPV_AP_HASH)));
  if (json === null || hash === null) return null;
  const ap = d.lookupMaybe(lib.PDFName.of("AP"), lib.PDFDict);
  const nStream = ap?.lookup(lib.PDFName.of("N"));
  if (!(nStream instanceof lib.PDFRawStream) || fnv1aHex(nStream.contents) !== hash) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null; // 깨진 JSON 은 "우리 것이 아님"과 같다 — 규칙 2/3 이 판정한다.
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Rec; // 외부 데이터 경계 — 모양은 normalizeDoc 이 정규화한다
}

interface Border {
  w: number;
  dash: number[] | null;
}

function borderOf(lib: PdfLib, d: PDFDict): Border {
  const N = (s: string) => lib.PDFName.of(s);
  const bs = d.lookupMaybe(N("BS"), lib.PDFDict);
  if (bs) {
    const w = bs.lookupMaybe(N("W"), lib.PDFNumber)?.asNumber() ?? 1;
    const dashed = bs.get(N("S")) === N("D");
    const dash = dashed ? nums(lib, bs.lookupMaybe(N("D"), lib.PDFArray)) : [];
    return { w, dash: dashed ? (dash.length ? dash : [3]) : null };
  }
  const border = nums(lib, d.lookupMaybe(N("Border"), lib.PDFArray));
  return { w: border.length >= 3 ? border[2] : 1, dash: null };
}

/** user space 점열 → page space 점열. */
function toPagePts(info: PdfPageInfo, user: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < user.length; i += 2) out.push(...apply(info.toPage, user[i], user[i + 1]));
  return out;
}

/** 규칙 2 — 표준 키에서 노드. 무손실 판정에 걸리면 null(규칙 3). */
function rule2(lib: PdfLib, d: PDFDict, info: PdfPageInfo, font: PdfFont | null): Rec | null {
  const N = (s: string) => lib.PDFName.of(s);
  const sub = d.get(N("Subtype"));
  const rect = nums(lib, d.lookupMaybe(N("Rect"), lib.PDFArray));
  if (rect.length !== 4) return null;
  const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const stroke = colorOf(lib, d.lookupMaybe(N("C"), lib.PDFArray));
  const opacity = d.lookupMaybe(N("CA"), lib.PDFNumber)?.asNumber() ?? 1;
  const border = borderOf(lib, d);
  const common = {
    opacity,
    strokeWidth: stroke ? border.w : 0,
    strokes: stroke && border.w > 0 ? [solidFill(stroke)] : [],
    dash: border.dash,
  };
  const pageBox = (ux0: number, uy0: number, ux1: number, uy1: number) => {
    const b = boundsOf(info.toPage, [ux0, uy0, ux1, uy0, ux1, uy1, ux0, uy1]);
    if (!b) return null;
    return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
  };

  if (sub === N("Square") || sub === N("Circle")) {
    const be = d.lookupMaybe(N("BE"), lib.PDFDict);
    if (be && be.get(N("S")) === N("C")) return null; // 구름 테두리
    const rd = nums(lib, d.lookupMaybe(N("RD"), lib.PDFArray));
    const [l, t, r, b] = rd.length === 4 ? rd : [0, 0, 0, 0];
    // 선은 /Rect−/RD 안쪽에 그려진다 — 기하(선 중심)는 거기서 두께 절반 더 안쪽이다.
    const half = common.strokeWidth / 2;
    const box = pageBox(rx0 + l + half, ry0 + b + half, rx1 - r - half, ry1 - t - half);
    if (!box) return null;
    const fill = colorOf(lib, d.lookupMaybe(N("IC"), lib.PDFArray));
    return {
      ...common,
      kind: sub === N("Square") ? "rect" : "ellipse",
      ...box,
      fills: fill ? [solidFill(fill)] : [],
    };
  }
  if (sub === N("Line")) {
    if (nums(lib, d.lookupMaybe(N("LL"), lib.PDFArray)).length || d.lookupMaybe(N("LL"), lib.PDFNumber)?.asNumber()) return null;
    if (d.get(N("Cap")) === lib.PDFBool.True) return null;
    const l = nums(lib, d.lookupMaybe(N("L"), lib.PDFArray));
    if (l.length !== 4) return null;
    const le = d.lookupMaybe(N("LE"), lib.PDFArray)?.asArray() ?? [];
    const head = (o: PDFObject | undefined): "none" | "arrow" | null =>
      o === undefined || o === N("None") ? "none" : o === N("OpenArrow") || o === N("ClosedArrow") ? "arrow" : null;
    const hs = head(le[0]);
    const he = head(le[1]);
    if (hs === null || he === null) return null;
    const [x1, y1, x2, y2] = toPagePts(info, l);
    return {
      ...common,
      kind: hs === "arrow" || he === "arrow" ? "arrow" : "line",
      x1,
      y1,
      x2,
      y2,
      heads: { start: hs, end: he },
      fills: [],
    };
  }
  if (sub === N("Ink")) {
    const lists = (d.lookupMaybe(N("InkList"), lib.PDFArray)?.asArray() ?? [])
      .map((o) => toPagePts(info, nums(lib, d.context.lookupMaybe(o, lib.PDFArray))))
      .filter((p) => p.length >= 2);
    if (!lists.length) return null;
    if (lists.length === 1) return { ...common, kind: "pen", pts: lists[0], fills: [], cap: "round" };
    const vert = (x: number, y: number) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" });
    return {
      ...common,
      kind: "path",
      fills: [],
      cap: "round",
      subpaths: lists.map((p) => ({
        verts: Array.from({ length: p.length / 2 }, (_, i) => vert(p[i * 2], p[i * 2 + 1])),
        closed: false,
      })),
    };
  }
  if (sub === N("FreeText")) {
    if (d.has(N("RC")) || d.get(N("IT")) === N("FreeTextCallout")) return null;
    const text = textOf(lib, d.get(N("Contents")));
    if (text === null) return null;
    const da = textOf(lib, d.get(N("DA"))) ?? "";
    const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 12);
    const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    const gray = /([\d.]+)\s+g(?:\s|$)/.exec(da);
    const color = rgb
      ? `#${hex2(Number(rgb[1]))}${hex2(Number(rgb[2]))}${hex2(Number(rgb[3]))}`
      : gray
        ? `#${hex2(Number(gray[1])).repeat(3)}`
        : "#000000";
    const q = d.lookupMaybe(N("Q"), lib.PDFNumber)?.asNumber() ?? 0;
    const box = pageBox(rx0, ry0, rx1, ry1);
    if (!box) return null;
    return {
      opacity,
      kind: "text",
      ...box,
      text,
      fontSize: size > 0 ? size : 12,
      fontFamily: font?.family ?? DEFAULT_FONT_FAMILY,
      align: q === 1 ? "center" : q === 2 ? "right" : "left",
      resize: "fixed",
      fills: [solidFill(color)],
      strokes: [],
      strokeWidth: 0,
    };
  }
  return null;
}

/** 규칙 2 — 다른 앱의 Highlight/Underline/StrikeOut. /QuadPoints 가 없거나 8의 배수가 아니면 null(규칙 3). */
function markupRule2(lib: PdfLib, d: PDFDict, info: PdfPageInfo, subtype: PdfMarkup["subtype"]): PdfMarkup | null {
  const N = (s: string) => lib.PDFName.of(s);
  const q = nums(lib, d.lookupMaybe(N("QuadPoints"), lib.PDFArray));
  if (!q.length || q.length % 8 !== 0) return null;
  return {
    id: textOf(lib, d.get(N("NM"))) ?? "",
    pageKey: info.key,
    subtype,
    // quad 점 순서는 앱마다 다르다(Acrobat 은 좌상·우상·좌하·우하, 스펙 문구는 반시계) — 그대로 받으면 화면 polygon·다시 쓴
    // AP 가 나비넥타이가 되고 밑줄이 대각선이 된다. pdf.js(getQuadPoints)처럼 quad 마다 외접 상자로 다시 세운다.
    // ponytail: 기울어진 글자 quad 는 외접 상자로 넓어진다(pdf.js 와 같다) — 필요해지면 가장 긴 변을 글자 방향으로 세운다.
    quads: quadsOfRects(quadBoxes(toPagePts(info, q))),
    color: colorOf(lib, d.lookupMaybe(N("C"), lib.PDFArray)) ?? "#FFFF00",
    opacity: d.lookupMaybe(N("CA"), lib.PDFNumber)?.asNumber() ?? 1,
  };
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 규칙 1 이미지 노드(T2 Stamp)의 에셋을 /GPV_Asset 스트림에서 되살린다(write.ts imageOps). 스트림은
 * DCTDecode 면 JPEG 원본 바이트, 이미지 XObject 면 그 픽셀(+SMask)로 PNG 를 다시 만든다. 앞이 PNG 서명이면 원본 PNG 를
 * 따로 담던 옛 판이다. 이미지 채우기가 있는데 에셋을 못 찾으면 false — 저장할 수 없는 노드라 편집 대상에서 뺀다.
 */
async function restoreAsset(lib: PdfLib, d: PDFDict, raw: Rec, assets: EditorDoc["assets"]): Promise<boolean> {
  const fills = Array.isArray(raw.fills) ? raw.fills : [];
  const ids = fills.flatMap((f: unknown) => {
    const r = typeof f === "object" && f !== null ? (f as Rec) : null; // 외부 데이터 경계
    return r && r.type === "image" && typeof r.assetId === "string" ? [r.assetId] : [];
  });
  if (!ids.length) return true;
  const N = (s: string) => lib.PDFName.of(s);
  const ref = d.get(N(GPV_ASSET));
  const st = ref ? d.context.lookup(ref) : undefined;
  if (!(st instanceof lib.PDFRawStream)) return false;
  const w = st.dict.lookupMaybe(N("Width"), lib.PDFNumber)?.asNumber() ?? 0;
  const h = st.dict.lookupMaybe(N("Height"), lib.PDFNumber)?.asNumber() ?? 0;
  let mime: string;
  let data: string;
  if (st.dict.get(N("Filter")) === N("DCTDecode")) {
    mime = "image/jpeg";
    data = bytesToBase64(st.contents);
  } else if (PNG_SIG.every((b, k) => st.contents[k] === b)) {
    mime = "image/png";
    data = bytesToBase64(st.contents);
  } else {
    const png = await pngOfXObject(lib, st, w, h);
    if (!png) return false;
    mime = "image/png";
    data = bytesToBase64(png);
  }
  for (const id of ids) assets[id] = { mime, w, h, data };
  return true;
}

/** pdf-lib embedPng 가 쓴 꼴(8비트 DeviceRGB + DeviceGray SMask)만 — 그 밖이면 null(우리가 쓴 것이 아니다). */
async function pngOfXObject(lib: PdfLib, st: PDFRawStream, w: number, h: number): Promise<Uint8Array | null> {
  const N = (s: string) => lib.PDFName.of(s);
  const bpc = st.dict.lookupMaybe(N("BitsPerComponent"), lib.PDFNumber)?.asNumber();
  if (bpc !== 8 || st.dict.get(N("ColorSpace")) !== N("DeviceRGB") || !w || !h) return null;
  const rgb = lib.decodePDFRawStream(st).decode();
  const maskRef = st.dict.get(N("SMask"));
  const mask = maskRef ? st.dict.context.lookup(maskRef) : undefined;
  const alpha = mask instanceof lib.PDFRawStream ? lib.decodePDFRawStream(mask).decode() : null;
  if (rgb.length < w * h * 3 || (alpha && alpha.length < w * h)) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = rgb[p * 3];
    rgba[p * 4 + 1] = rgb[p * 3 + 1];
    rgba[p * 4 + 2] = rgb[p * 3 + 2];
    rgba[p * 4 + 3] = alpha ? alpha[p] : 255;
  }
  const { encode } = await import("@cantoo/pdf-lib/upng");
  return new Uint8Array(encode([rgba.buffer], w, h, 0));
}

/**
 * 주석 `/NM` → ref·페이지 key(`"12 0 R"`) — '그래도 저장'이 새 판에서 이 세션이 아는 주석의 자리를 다시 찾을 때.
 * 기하를 보지 않아 페이지 정보가 필요 없다(페이지 연산 뒤 infos 는 디스크 판과 쪽수가 다르다). 같은 /NM 은 첫 것.
 */
export async function annotRefsByName(bytes: Uint8Array): Promise<Map<string, { ref: string; pageKey: string }>> {
  const lib = await import("@cantoo/pdf-lib");
  const doc = await loadForIncrement(lib, bytes);
  const out = new Map<string, { ref: string; pageKey: string }>();
  for (const page of doc.getPages()) {
    for (const e of annotEntries(lib, page)) {
      if (!(e instanceof lib.PDFRef)) continue;
      const nm = textOf(lib, doc.context.lookupMaybe(e, lib.PDFDict)?.get(lib.PDFName.of("NM")));
      if (nm && !out.has(nm)) out.set(nm, { ref: e.toString(), pageKey: page.ref.toString() });
    }
  }
  return out;
}

/**
 * 파일 바이트와 페이지 정보(pdf.js viewport) → 편집 노드·장부·작업 사본.
 * 암호화 문서는 호출 전에 화면이 막는다(§7.4) — 여기서는 다시 판정하지 않는다.
 */
export async function importAnnotations(
  bytes: Uint8Array,
  infos: PdfPageInfo[],
  font: PdfFont | null,
): Promise<ImportResult> {
  const lib = await import("@cantoo/pdf-lib");
  const doc = await loadForIncrement(lib, bytes);
  const pdfPages: PDFPage[] = doc.getPages();
  if (pdfPages.length !== infos.length) {
    throw new Error(`importAnnotations: page count mismatch (file ${pdfPages.length}, infos ${infos.length})`);
  }
  const ledger = emptyLedger();
  const seen = new Set<string>();
  const pages: EditorDoc[] = [];
  const taken: PDFRef[][] = [];
  let fontless = 0;
  const markups: PdfMarkup[] = [];

  for (let i = 0; i < pdfPages.length; i++) {
    const raws: Rec[] = [];
    const refOf = new Map<string, PDFRef>();
    const assets: EditorDoc["assets"] = {};
    const markRefs: PDFRef[] = [];
    for (const e of annotEntries(lib, pdfPages[i])) {
      // 직접 사전 주석은 ref 가 없어 장부에 못 올린다 — 고칠 방법이 없으니 규칙 3.
      if (!(e instanceof lib.PDFRef)) continue;
      const d = doc.context.lookupMaybe(e, lib.PDFDict);
      if (!d) continue;
      const sub = d.get(lib.PDFName.of("Subtype"));
      const subName = sub instanceof lib.PDFName ? sub.decodeText() : "";
      if (isMarkupSubtype(subName)) {
        const mk = markupFromJson(rule1(lib, d), infos[i].key) ?? markupRule2(lib, d, infos[i], subName);
        if (!mk) continue;
        const mid = mk.id && !seen.has(mk.id) ? mk.id : crypto.randomUUID();
        seen.add(mid);
        const m = { ...mk, id: mid };
        markups.push(m);
        markRefs.push(e);
        ledger.refs.set(mid, e.toString());
        ledger.saved.set(mid, m);
        ledger.pageOf.set(mid, infos[i].key);
        continue;
      }
      const r1 = rule1(lib, d);
      if (r1 && !(await restoreAsset(lib, d, r1, assets))) continue;
      const raw = r1 ?? rule2(lib, d, infos[i], font);
      if (!raw) continue;
      const nm = textOf(lib, d.get(lib.PDFName.of("NM")));
      let id = typeof raw.id === "string" && raw.id ? raw.id : (nm ?? "");
      if (!id || seen.has(id)) id = crypto.randomUUID();
      seen.add(id);
      raws.push({ ...raw, id, parentId: null });
      refOf.set(id, e);
    }
    const ed = normalizeDoc({ objects: raws, assets });
    const objects: Node[] = [];
    const kept: PDFRef[] = [];
    for (const node of ed.objects) {
      const ref = refOf.get(node.id);
      // 규칙 1 JSON 이 PDF 로 못 쓰는 종류면 편집 대상에서 뺀다(파일엔 그대로 남고 pdf.js 가 그린다).
      if (!ref || !isPdfNode(node)) continue;
      let out: Node = node;
      if (node.kind === "text") {
        if (font) out = { ...node, fontFamily: font.family };
        else {
          fontless++;
          out = { ...node, fontFamily: DEFAULT_FONT_FAMILY };
        }
      }
      objects.push(out);
      kept.push(ref);
      ledger.refs.set(out.id, ref.toString());
      ledger.saved.set(out.id, out);
      ledger.pageOf.set(out.id, infos[i].key);
    }
    pages.push({ ...ed, objects });
    taken.push([...kept, ...markRefs]);
  }

  let workingCopy: Uint8Array | null = null;
  if (taken.some((t) => t.length)) {
    // 표시 전용: 편집 노드로 옮긴 주석을 /Annots 에서 뺀다(Popup·답글은 pdf.js 가 그대로 그린다). 파일에는 절대 쓰지 않는다.
    taken.forEach((refs, i) => {
      if (refs.length) removeAnnots(lib, pdfPages[i], refs, false);
    });
    const inc0 = await incrementOf(doc, bytes);
    workingCopy = new Uint8Array(bytes.length + inc0.length);
    workingCopy.set(bytes);
    workingCopy.set(inc0, bytes.length);
  }

  const notes = fontless ? [messagesFor(currentLocale()).pdf.core.textFontReplaced(fontless)] : [];
  return { pages, ledger, workingCopy, notes, markups };
}
