// 색 변환 한 벌 — 캔버스 렌더(뱃지 글자색)와 인스펙터(색 피커·스와치)가 **같은 함수**를 본다.
//
// `readableOn` 은 원래 render.ts 안에 비공개로 있었다. 인스펙터가 같은 판정을 필요로 하면서
// 여기로 옮겼다 — 두 벌이 되면 같은 채우기에서 캔버스는 흰 글자, 인스펙터 스와치는 검은 글자를
// 그리고, 어느 쪽이 맞는지 아무도 모르게 된다.
//
// 단위: rgb 는 정수 0–255, hex 는 언제나 대문자 `#RRGGBB`, 각도는 deg(0–360), s/l/v 는
// 퍼센트(0–100). 알파는 색 문자열에 섞지 않는다 — 37 `Paint` 가 `opacity` 로 따로 든다.
//
// **HSL/HSV 왕복은 반올림에서 무너진다.** 이 파일의 변환은 실수를 그대로 돌려주므로
// hex → rgb → hsl → rgb → hex 는 정확히 원본이지만, UI 가 `333° 86% 58%` 처럼 정수로 보여 주고
// 그 표시값을 다시 읽는 순간 `#F0398B` 가 `#F0388B` 로 흘러간다. 슬라이더는 한 번 움직일 때마다
// 그 왕복을 하므로 사용자가 손대지도 않은 채도·명도가 조금씩 미끄러진다. 그래서 **색 피커는
// HSV 를 자기 state 로 들고 hex 는 출력으로만 쓴다.** 반대로 하면 슬라이더가 색을 갉아먹는다.

export type Rgb = [r: number, g: number, b: number];
export type Hsl = [h: number, s: number, l: number];
export type Hsv = [h: number, s: number, v: number];

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 사용자 입력 경계 — `#abc`·`abc`·` #AABBCC `→ `#AABBCC`, 못 읽으면 null.
 *
 * 틀리면: 잘못된 hex 가 그대로 문서에 들어가고 canvas 는 예외도 경고도 없이 **검정**을 그린다.
 * 알파 표기(`#rrggbbaa`)는 일부러 거른다 — 받아 주면 알파가 색 문자열과 `opacity` 두 곳에
 * 생겨 어느 쪽이 이기는지가 렌더 경로마다 갈린다.
 */
export function normalizeHex(input: string): string | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  return `#${full.toUpperCase()}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const n = Number.parseInt(norm.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const [h, max, min] = decompose(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  // l 이 0 이나 1 이면 분모가 0 이지만 그때는 max === min 이라 d === 0 가 먼저 걸린다.
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s * 100, l * 100];
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
  const ln = clamp01(l / 100);
  const c = (1 - Math.abs(2 * ln - 1)) * clamp01(s / 100);
  return fromChroma(h, c, ln - c / 2);
}

export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const [h, max, min] = decompose(r, g, b);
  return [h, max === 0 ? 0 : ((max - min) / max) * 100, max * 100];
}

export function hsvToRgb([h, s, v]: Hsv): Rgb {
  const vn = clamp01(v / 100);
  const c = vn * clamp01(s / 100);
  return fromChroma(h, c, vn - c);
}

/** 배경색 위에서 읽히는 글자색(밝기 기준 흰/검 이분). */
export function readableOn(bg: string): string {
  // 문서의 색 정규화는 `#` + hex 3~8 자를 통과시킨다(schema.ts:99) — 알파가 붙어 있으면
  // 잘라 내고 읽는다. 여기서 null 로 떨어뜨리면 반투명 뱃지 숫자가 통째로 흰색이 된다.
  const rgb = hexToRgb(bg.trim().slice(0, 7));
  if (!rgb) return "#FFFFFF";
  // ITU-R BT.601 근사 — 정밀한 대비비까지는 필요 없다.
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 150 ? "#1C1C1E" : "#FFFFFF";
}

// ── 내부 ────────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hex2(v: number): string {
  const n = Math.round(v);
  return (n < 0 ? 0 : n > 255 ? 255 : n).toString(16).padStart(2, "0").toUpperCase();
}

/** 색상환 각도 + 정규화 max/min — HSL 과 HSV 가 공유하는 앞부분이다. 무채색은 h = 0. */
function decompose(r: number, g: number, b: number): [h: number, max: number, min: number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return [0, max, min];
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, max, min];
}

/** HSL·HSV 의 공통 뒷부분 — 채도(c)와 바닥(m)만 다르다. 결과는 정수로 맞춘다. */
function fromChroma(h: number, c: number, m: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const seg: Rgb =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((seg[0] + m) * 255), Math.round((seg[1] + m) * 255), Math.round((seg[2] + m) * 255)];
}
