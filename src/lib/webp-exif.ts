// WebP EXIF 옮겨 심기(태스크 76 후속) — `jpeg-exif.ts` 의 WebP 판. 캔버스가 내는 WebP 는 단순 형식(`VP8 `/`VP8L`
// 청크 하나)이라 메타데이터를 실을 자리가 없다. EXIF 를 실으려면 확장 형식으로 바꿔야 한다: 맨 앞에 `VP8X`(EXIF 비트,
// 알파가 있으면 알파 비트, 캔버스 크기)를 두고 그림 청크는 그대로, 그 뒤에 `EXIF` 청크(TIFF 블록)를 붙인다.
// 알파가 있는 손실 출력은 인코더가 이미 `VP8X`+`ALPH`+`VP8 ` 로 내므로 그때는 플래그만 켠다.
// TIFF 블록 안의 방향·썸네일·크기·색 공간은 JPEG 와 같은 규칙으로 고친다(`patchExifTiff`).
//
// 어디든 어긋나면 null·입력 그대로다 — 메타데이터 때문에 저장을 실패시키지 않는다.

import { EXIF_HEAD, patchExifTiff } from "./jpeg-exif";

/** VP8X 플래그 바이트(RIFF 컨테이너 규격) — 알파·EXIF·애니메이션. */
const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;
const FLAG_ANIM = 0x02;

interface Chunk {
  id: string;
  /** 페이로드 시작. */
  data: number;
  size: number;
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** RIFF `WEBP` 의 청크들. 컨테이너가 아니거나 청크가 RIFF 크기 밖으로 나가면 null. */
function webpChunks(b: Uint8Array): Chunk[] | null {
  if (b.length < 12 || fourcc(b, 0) !== "RIFF" || fourcc(b, 8) !== "WEBP") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riffEnd = 8 + v.getUint32(4, true);
  if (riffEnd > b.length) return null;
  const out: Chunk[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const size = v.getUint32(at + 4, true);
    if (at + 8 + size > riffEnd) return null;
    out.push({ id: fourcc(b, at), data: at + 8, size });
    // 홀수 크기 페이로드 뒤엔 채움 바이트 하나(마지막 청크는 빠뜨린 인코더도 있다 — 다시 쓸 때 채운다).
    at += 8 + size + (size & 1);
  }
  return out.length ? out : null;
}

/** 원본 WebP 의 `EXIF` 청크 안 TIFF 블록 사본. 없으면 null. `Exif\0\0` 을 앞에 붙여 쓰는 인코더도 받는다. */
export function webpExifTiff(webp: Uint8Array): Uint8Array | null {
  const c = webpChunks(webp)?.find((x) => x.id === "EXIF");
  if (!c) return null;
  const prefixed = c.size >= EXIF_HEAD.length && EXIF_HEAD.every((v, k) => webp[c.data + k] === v);
  const tiff = webp.slice(c.data + (prefixed ? EXIF_HEAD.length : 0), c.data + c.size);
  return tiff.length >= 8 ? tiff : null;
}

/** `fav_read`·`read_file_base64` 의 base64 원본에서. EXIF 청크는 그림 뒤에 오므로 WebP 일 때만 통째로 푼다. */
export function webpExifTiffFromBase64(b64: string): Uint8Array | null {
  const head = atob(b64.slice(0, 16));
  if (!head.startsWith("RIFF") || head.slice(8, 12) !== "WEBP") return null;
  return webpExifTiff(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** 단순 형식 그림 청크의 크기·알파. VP8L 은 머리의 알파 힌트 비트, VP8(손실)은 알파가 없다(있으면 ALPH 로 따로 온다). */
function bitstreamInfo(b: Uint8Array, c: Chunk): { w: number; h: number; alpha: boolean } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (c.id === "VP8L" && c.size >= 5 && b[c.data] === 0x2f) {
    const bits = v.getUint32(c.data + 1, true);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
  }
  // 키 프레임 머리: 프레임 태그 3바이트 · 시작 코드 9D 01 2A · 가로·세로(아래 14비트).
  if (c.id === "VP8 " && c.size >= 10 && b[c.data + 3] === 0x9d && b[c.data + 4] === 0x01 && b[c.data + 5] === 0x2a) {
    const w = v.getUint16(c.data + 6, true) & 0x3fff;
    const h = v.getUint16(c.data + 8, true) & 0x3fff;
    return w && h ? { w, h, alpha: false } : null;
  }
  return null;
}

function chunkBytes(id: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length & 1));
  for (let k = 0; k < 4; k++) out[k] = id.charCodeAt(k);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

/**
 * 새로 인코딩한 WebP(`width`×`height`)에 EXIF TIFF 블록을 `EXIF` 청크로 넣는다(머리 주석). 인코더가 쓴 EXIF 청크가
 * 있으면 뺀다. 애니메이션·모르는 그림 청크는 손대지 않는다(캔버스는 내지 않는다).
 */
export function withWebpExif(encoded: Uint8Array, tiff: Uint8Array | null, width: number, height: number): Uint8Array {
  if (!tiff) return encoded;
  const cs = webpChunks(encoded);
  if (!cs) return encoded;
  const exif = tiff.slice();
  if (!patchExifTiff(exif, width, height)) return encoded;
  let vp8x: Uint8Array;
  let rest: Chunk[];
  if (cs[0].id === "VP8X") {
    if (cs[0].size < 10 || encoded[cs[0].data] & FLAG_ANIM) return encoded;
    vp8x = encoded.slice(cs[0].data, cs[0].data + 10);
    vp8x[0] |= FLAG_EXIF;
    rest = cs.slice(1);
  } else {
    const info = bitstreamInfo(encoded, cs[0]);
    if (!info || cs.length !== 1) return encoded;
    // 캔버스 크기는 그림 청크에서 읽은 값 − 1 을 24비트 LE 로.
    vp8x = new Uint8Array(10);
    vp8x[0] = FLAG_EXIF | (info.alpha ? FLAG_ALPHA : 0);
    for (let k = 0; k < 3; k++) {
      vp8x[4 + k] = ((info.w - 1) >> (8 * k)) & 0xff;
      vp8x[7 + k] = ((info.h - 1) >> (8 * k)) & 0xff;
    }
    rest = cs;
  }
  rest = rest.filter((c) => c.id !== "EXIF");
  // 청크 순서 규격: 그림 → EXIF → XMP.
  const xmp = rest.findIndex((c) => c.id === "XMP ");
  const at = xmp < 0 ? rest.length : xmp;
  const own = (c: Chunk) => chunkBytes(c.id, encoded.subarray(c.data, c.data + c.size));
  const parts = [
    chunkBytes("VP8X", vp8x),
    ...rest.slice(0, at).map(own),
    chunkBytes("EXIF", exif),
    ...rest.slice(at).map(own),
  ];
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(encoded.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  let o = 12;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
