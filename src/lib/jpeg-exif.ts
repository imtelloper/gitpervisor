// JPEG EXIF 옮겨 심기(태스크 76 후속) — 캔버스로 다시 인코딩한 JPEG 에는 메타데이터가 하나도 없다(촬영 시각·
// 카메라·GPS 가 사라진다). 원본의 EXIF TIFF 블록을 떠서 새 파일 SOI 뒤에 APP1 로 다시 넣는다. TIFF 블록을
// 바이트 그대로 옮기므로 그 안의 오프셋(Exif IFD·GPS IFD·메이커노트)은 손대지 않아도 맞다.
// 주고받는 단위는 TIFF 블록(`II*\0`/`MM\0*` 부터)이다 — JPEG APP1·WebP EXIF 청크·HEIC Exif 항목(`fav_read` 의
// `exifTiff`)이 다 같은 블록을 싸고 있어서, 어디서 떴든 어느 쪽에든 심을 수 있다.
//
// 심을 때 사본의 값 넷을 새 그림에 맞춘다(`patchExifTiff`):
// - 방향(Orientation 0x0112) = 1: 웹뷰가 <img> 를 디코드할 때 EXIF 방향을 이미 적용하고(Chromium 81+ 기본
//   `image-orientation: from-image` — naturalWidth·drawImage 도 바로 선 그림), 캔버스는 그 그림을 그린다.
//   원래 값(아이폰 세로 사진은 6)을 남기면 다른 뷰어가 한 번 더 돌린다. HEIC 변환본도 ffmpeg 가 이미 세웠다.
// - 썸네일(IFD1)은 연결을 끊는다 — 옛 방향·옛 내용(자르기·보정 전)이라 탐색기처럼 내장 썸네일을 쓰는 곳이 틀린
//   그림을 보인다. 바이트는 블록 안에 남지만 아무도 가리키지 않는다.
// - PixelX/YDimension = 새 크기: 자르기·크기 바꾸기·90° 회전 뒤에도 옛 값이면 그 값을 믿는 프로그램이 틀린 크기를 본다.
// - ColorSpace = 1(sRGB): 캔버스 출력은 sRGB 이고 원본 ICC 프로필(아이폰 Display P3)은 옮기지 않는다.
//
// 어디든 어긋나면 null·입력 그대로다 — 메타데이터 때문에 저장을 실패시키지 않는다.

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_COLOR_SPACE = 0xa001;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_IFD = 13;
/** "Exif\0\0" — APP1 페이로드 머리. 같은 APP1 을 XMP 도 쓰므로 이것으로 가른다. */
export const EXIF_HEAD = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
/** APP1 길이 칸은 16비트이고 자기 2바이트와 `Exif\0\0` 을 포함한다(Rust `exif::MAX_EXIF_TIFF_BYTES` 와 같은 값). */
const MAX_TIFF_BYTES = 0xffff - 2 - EXIF_HEAD.length;
/** base64 앞부분만 푼다 — Exif 는 SOI(·JFIF APP0) 바로 뒤에 오고 64KB 를 못 넘는다. 4의 배수여야 한다(768KB). */
const HEAD_B64_CHARS = 1 << 20;

/**
 * TIFF 블록 사본을 제자리에서 새 그림에 맞춘다(머리 주석의 넷). 값 칸 크기는 그대로 둔다 — SHORT 에 안 들어가는
 * 치수는 같은 4바이트 칸을 LONG 으로 바꿔 쓴다(규격이 둘 다 허용). 방향을 못 고치면 false(옮겨 심으면 그림이 돌아간다).
 * Exif IFD 가 밖을 가리키거나 태그 형식이 낯설면 그 태그만 건너뛴다 — 아무도 못 읽는 자리다.
 */
export function patchExifTiff(t: Uint8Array, width: number, height: number): boolean {
  if (t.length < 8) return false;
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const order = (t[0] << 8) | t[1];
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  const le = order === 0x4949;
  if (v.getUint16(2, le) !== 42) return false;
  /** IFD 항목 수 — 항목이 다 블록 안이어야 한다. */
  const entries = (at: number): number | null => {
    if (at < 8 || at + 2 > t.length) return null;
    const n = v.getUint16(at, le);
    return at + 2 + n * 12 <= t.length ? n : null;
  };
  const ifd0 = v.getUint32(4, le);
  const n0 = entries(ifd0);
  const next = ifd0 + 2 + (n0 ?? 0) * 12;
  if (n0 === null || next + 4 > t.length) return false;
  let exifIfd: number | null = null;
  for (let k = 0; k < n0; k++) {
    const e = ifd0 + 2 + k * 12;
    const tag = v.getUint16(e, le);
    const type = v.getUint16(e + 2, le);
    const count = v.getUint32(e + 4, le);
    if (tag === TAG_ORIENTATION) {
      if (type !== TYPE_SHORT || count !== 1) return false;
      // SHORT 하나는 값 칸(4바이트)의 앞 2바이트에 바이트 순서대로 든다.
      v.setUint16(e + 8, 1, le);
    } else if (tag === TAG_EXIF_IFD && (type === TYPE_LONG || type === TYPE_IFD) && count === 1) {
      exifIfd = v.getUint32(e + 8, le);
    }
  }
  v.setUint32(next, 0, le);
  if (exifIfd === null) return true;
  const n1 = entries(exifIfd) ?? 0;
  for (let k = 0; k < n1; k++) {
    const e = exifIfd + 2 + k * 12;
    const tag = v.getUint16(e, le);
    const type = v.getUint16(e + 2, le);
    if (v.getUint32(e + 4, le) !== 1) continue;
    if (tag === TAG_COLOR_SPACE && type === TYPE_SHORT) {
      v.setUint16(e + 8, 1, le);
    } else if ((tag === TAG_PIXEL_X || tag === TAG_PIXEL_Y) && (type === TYPE_SHORT || type === TYPE_LONG)) {
      const dim = tag === TAG_PIXEL_X ? width : height;
      if (type === TYPE_SHORT && dim <= 0xffff) {
        v.setUint16(e + 8, dim, le);
      } else {
        v.setUint16(e + 2, TYPE_LONG, le);
        v.setUint32(e + 8, dim, le);
      }
    }
  }
  return true;
}

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

/** 원본 JPEG 의 Exif APP1 안 TIFF 블록 사본. 없으면 null. */
export function jpegExifTiff(jpeg: Uint8Array): Uint8Array | null {
  const r = scanHeader(jpeg);
  const s = r?.segs.find((x) => isExif(jpeg, x));
  return s ? jpeg.slice(s.start + 4 + EXIF_HEAD.length, s.end) : null;
}

/** `fav_read`·`read_file_base64` 의 base64 원본에서 — 앞부분만 푼다(사진 전체를 디코드하지 않는다). */
export function jpegExifTiffFromBase64(b64: string): Uint8Array | null {
  const head = atob(b64.slice(0, HEAD_B64_CHARS));
  return jpegExifTiff(Uint8Array.from(head, (c) => c.charCodeAt(0)));
}

/**
 * 새로 인코딩한 JPEG(`width`×`height`)에 EXIF TIFF 블록을 APP1 로 넣는다. 인코더가 쓴 Exif APP1 이 있으면 뺀다.
 *
 * 자리: JFIF APP0 이 맨 앞이면 그 뒤, 아니면 SOI 바로 뒤. JFIF 는 APP0 이 SOI 바로 뒤이길, Exif 는 APP1 이 SOI 바로
 * 뒤이길 요구해 둘이 함께면 충돌한다 — APP0 → APP1 순서가 관례다(exiftool 이 이렇게 쓰고, 둘 다 읽힌다).
 */
export function withJpegExif(encoded: Uint8Array, tiff: Uint8Array | null, width: number, height: number): Uint8Array {
  if (!tiff || tiff.length > MAX_TIFF_BYTES) return encoded;
  const r = scanHeader(encoded);
  if (!r || r.sos === null) return encoded;
  const len = 2 + EXIF_HEAD.length + tiff.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xff, APP1, len >> 8, len & 0xff]);
  seg.set(EXIF_HEAD, 4);
  seg.set(tiff, 4 + EXIF_HEAD.length);
  if (!patchExifTiff(seg.subarray(4 + EXIF_HEAD.length), width, height)) return encoded;
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
