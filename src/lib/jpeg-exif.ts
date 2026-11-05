// JPEG EXIF 옮겨 심기(태스크 76 후속) — 캔버스로 다시 인코딩한 JPEG 에는 메타데이터가 하나도 없다(촬영 시각·
// 카메라·GPS 가 사라진다). 원본의 APP1 Exif 세그먼트를 통째로 떠서 새 파일 SOI 뒤에 다시 넣는다. TIFF 블록을
// 바이트 그대로 옮기므로 그 안의 오프셋(Exif IFD·GPS IFD·메이커노트)은 손대지 않아도 맞다.
//
// 방향(Orientation 0x0112)은 1 로 고쳐 쓴다: 웹뷰가 <img> 를 디코드할 때 EXIF 방향을 이미 적용하고(Chromium 81+
// 기본 `image-orientation: from-image` — naturalWidth·drawImage 도 바로 선 그림), 캔버스는 그 그림을 그린다.
// 원래 값(아이폰 세로 사진은 6)을 남기면 다른 뷰어가 한 번 더 돌린다.
// 썸네일(IFD1)은 연결을 끊는다 — 옛 방향·옛 내용(자르기·보정 전)이라 탐색기처럼 내장 썸네일을 쓰는 곳이 틀린
// 그림을 보인다. 바이트는 세그먼트 안에 남지만 아무도 가리키지 않는다.
//
// 어디든 어긋나면 null·입력 그대로다 — 메타데이터 때문에 저장을 실패시키지 않는다.

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const TAG_ORIENTATION = 0x0112;
const TYPE_SHORT = 3;
/** "Exif\0\0" — APP1 페이로드 머리. 같은 APP1 을 XMP 도 쓰므로 이것으로 가른다. */
const EXIF_HEAD = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
/** base64 앞부분만 푼다 — Exif 는 SOI(·JFIF APP0) 바로 뒤에 오고 64KB 를 못 넘는다. 4의 배수여야 한다(768KB). */
const HEAD_B64_CHARS = 1 << 20;

interface Seg {
  marker: number;
  /** 마커의 0xFF 자리. */
  start: number;
  /** 세그먼트 끝(배타). */
  end: number;
}

/** SOS 앞의 헤더 세그먼트들과 SOS 자리. JPEG 가 아니면 null, 헤더가 중간에 끊기거나 깨졌으면 `sos: null`. */
function scanHeader(b: Uint8Array): { segs: Seg[]; sos: number | null } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) return null;
  const segs: Seg[] = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) break;
    // 마커 앞의 채움 바이트(0xFF 반복)는 규격상 허용된다 — 마지막 0xFF 를 마커 자리로 본다.
    while (i + 1 < b.length && b[i + 1] === 0xff) i++;
    if (i + 1 >= b.length) break;
    const marker = b[i + 1];
    if (marker === SOS) return { segs, sos: i };
    // 길이 없는 마커(TEM·RSTn·SOI·EOI)나 0x00 은 SOS 앞에 올 수 없다.
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd9)) break;
    if (i + 4 > b.length) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;
    segs.push({ marker, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return { segs, sos: null };
}

function isExif(b: Uint8Array, s: Seg): boolean {
  if (s.marker !== APP1 || s.end - (s.start + 4) < EXIF_HEAD.length + 8) return false;
  return EXIF_HEAD.every((v, k) => b[s.start + 4 + k] === v);
}

/** Exif 세그먼트 사본을 제자리에서 고친다 — 방향 1·IFD1 끊기. 방향을 못 고치면 false(옮겨 심으면 그림이 돌아간다). */
function uprightExif(seg: Uint8Array): boolean {
  const tiff = 4 + EXIF_HEAD.length;
  const v = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const order = (seg[tiff] << 8) | seg[tiff + 1];
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  const le = order === 0x4949;
  if (v.getUint16(tiff + 2, le) !== 42) return false;
  const ifd0 = tiff + v.getUint32(tiff + 4, le);
  if (ifd0 < tiff + 8 || ifd0 + 2 > seg.length) return false;
  const n = v.getUint16(ifd0, le);
  const next = ifd0 + 2 + n * 12;
  if (next + 4 > seg.length) return false;
  for (let k = 0; k < n; k++) {
    const e = ifd0 + 2 + k * 12;
    if (v.getUint16(e, le) !== TAG_ORIENTATION) continue;
    if (v.getUint16(e + 2, le) !== TYPE_SHORT || v.getUint32(e + 4, le) !== 1) return false;
    // SHORT 하나는 값 칸(4바이트)의 앞 2바이트에 바이트 순서대로 든다.
    v.setUint16(e + 8, 1, le);
  }
  v.setUint32(next, 0, le);
  return true;
}

/** 원본 JPEG 의 Exif APP1 세그먼트(0xFF 마커부터) — 방향 1·썸네일 끊음으로 고친 사본. 없거나 깨졌으면 null. */
export function jpegExifSegment(jpeg: Uint8Array): Uint8Array | null {
  const r = scanHeader(jpeg);
  const s = r?.segs.find((x) => isExif(jpeg, x));
  if (!s) return null;
  const seg = jpeg.slice(s.start, s.end);
  return uprightExif(seg) ? seg : null;
}

/** `fav_read` 의 base64 원본에서 — 앞부분만 푼다(사진 전체를 디코드하지 않는다). */
export function jpegExifSegmentFromBase64(b64: string): Uint8Array | null {
  const head = atob(b64.slice(0, HEAD_B64_CHARS));
  return jpegExifSegment(Uint8Array.from(head, (c) => c.charCodeAt(0)));
}

/**
 * 새로 인코딩한 JPEG 에 Exif 세그먼트를 넣는다. 인코더가 쓴 Exif APP1 이 있으면 뺀다.
 *
 * 자리: JFIF APP0 이 맨 앞이면 그 뒤, 아니면 SOI 바로 뒤. JFIF 는 APP0 이 SOI 바로 뒤이길, Exif 는 APP1 이 SOI 바로
 * 뒤이길 요구해 둘이 함께면 충돌한다 — APP0 → APP1 순서가 관례다(exiftool 이 이렇게 쓰고, 둘 다 읽힌다).
 */
export function withJpegExif(encoded: Uint8Array, seg: Uint8Array | null): Uint8Array {
  if (!seg) return encoded;
  const r = scanHeader(encoded);
  if (!r || r.sos === null) return encoded;
  const keep = r.segs.filter((s) => !isExif(encoded, s));
  const lead = keep.length && keep[0].marker === APP0 ? 1 : 0;
  const parts = [
    encoded.subarray(0, 2),
    ...keep.slice(0, lead).map((s) => encoded.subarray(s.start, s.end)),
    seg,
    ...keep.slice(lead).map((s) => encoded.subarray(s.start, s.end)),
    encoded.subarray(r.sos),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
