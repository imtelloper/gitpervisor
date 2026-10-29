// PDF 텍스트 상자용 한글 임베드 폰트(설계 §6.4 5~7항). 화면(FontFace)과 저장(embedFont)이 **같은 바이트**를 쓴다.
//
// 임베드 가능 여부는 메타데이터가 아니라 실제 시도로 판정한다(S0-4): 굴림·바탕(EBDT 비트맵)은 fsType 이
// "editable" 인데도 `Cannot decode glyph 0` 으로 실패했다. 그래서 빈 문서에 서브셋 임베드 + "가A" + save() 까지
// 돌려 통과한 첫 후보를 쓴다. 후보 목록·가변 폰트 제외는 Rust(fonts.rs)가 한다.

import { ipc } from "../ipc";
import type { PdfFont } from "./model";
import { facePostscriptName, fnv1aHex } from "./write";

let cached: Promise<PdfFont | null> | null = null;

async function embedProbe(bytes: Uint8Array): Promise<void> {
  const [lib, fontkit] = await Promise.all([import("@cantoo/pdf-lib"), import("@cantoo/fontkit")]);
  const doc = await lib.PDFDocument.create();
  doc.registerFontkit(fontkit.default);
  const font = await doc.embedFont(bytes, {
    subset: true,
    postscriptName: facePostscriptName(fontkit.default, bytes),
  });
  // 새 문서라 PDFPage 헬퍼를 써도 된다 — L2 가 막는 것은 기존 페이지의 콘텐츠 정규화다.
  doc.addPage().drawText("가A", { font, size: 12 });
  await doc.save();
}

/**
 * 화면용 FontFace. TTC 는 FontFace 가 face 를 고를 수 없다(첫 face 를 열거나 실패한다) — 저장이 고른 face 와
 * 글리프 폭이 갈리지 않게 OS 에 설치된 같은 폰트 이름으로 그린다. 단일 폰트도 등록이 실패하면 같은 대체를 쓴다.
 */
async function registerFace(bytes: Uint8Array, fallbackFamily: string, collection: boolean): Promise<string> {
  if (collection) return fallbackFamily;
  const family = `gpv-pdf-${fnv1aHex(bytes)}`;
  try {
    const face = new FontFace(family, bytes);
    document.fonts.add(face);
    await face.load();
    return family;
  } catch (e) {
    console.warn(`[pdf] FontFace ${family} failed, using installed "${fallbackFamily}":`, e);
    return fallbackFamily;
  }
}

async function pick(): Promise<PdfFont | null> {
  const candidates = await ipc.pdfFontCandidates();
  for (const c of candidates) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await ipc.fontReadRaw(c.path));
      await embedProbe(bytes);
    } catch (e) {
      // 이 후보는 못 쓴다(읽기 실패·임베드 실패) — 다음 후보로. 전부 실패하면 null 이 곧 "폰트 없음" 안내다.
      console.warn(`[pdf] font candidate rejected: ${c.path}:`, e);
      continue;
    }
    return { family: await registerFace(bytes, c.family, c.collection), bytes };
  }
  return null;
}

/** 후보 순서대로 font_read_raw → 임베드 사전 검사("가A" subset save) 통과한 첫 폰트를 FontFace 로 등록. 없으면 null. 결과 캐시 */
export function ensurePdfFont(): Promise<PdfFont | null> {
  cached ??= pick().catch((e: unknown) => {
    cached = null; // 후보 목록 IPC 실패는 다음 진입에서 다시 시도한다
    throw e;
  });
  return cached;
}
