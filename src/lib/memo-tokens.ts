// 메모 본문 안의 두 가지 토큰 — 이미지와 체크박스. 본문은 **평문 그대로** 저장되고(편집기는 이 토큰만 위젯으로
// 바꿔 보인다), 여기는 그 글자를 찾고 고쳐 쓰는 순수 함수만 둔다(DOCS/memo-todo-category-image-design.md §2.3·§6.3).

/** 이미지 토큰: `![대체텍스트](memo-img/<uuid>.avif#w=320)`. `#w=` 는 표시 폭(px)이고 없으면 원본 폭이다. */
export interface MemoImageToken {
  from: number;
  to: number;
  id: string;
  alt: string;
  width: number | null;
}

/** 줄 머리 체크박스의 `[ ]` / `[x]` 세 글자 자리. */
export interface MemoTaskMarker {
  from: number;
  to: number;
  checked: boolean;
}

export const MEMO_IMAGE_MIN_WIDTH = 48;

// id 는 Rust(note_images.rs)가 받는 꼴과 같아야 한다 — 소문자 하이픈 UUID. 다른 꼴은 토큰으로 치지 않는다.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IMAGE_URL = `memo-img/(${UUID})\\.avif(?:#w=(\\d{1,5}))?`;
const IMAGE_TOKEN = new RegExp(`!\\[([^\\]\\n]*)\\]\\(${IMAGE_URL}\\)`, "g");
const IMAGE_URL_ONLY = new RegExp(`^${IMAGE_URL}$`);
// 목록 표시(-, *, +) 뒤의 `[ ]`·`[x]` 만 — 본문 중간의 대괄호나 `[26-11-24]` 같은 제목은 건드리지 않는다.
const TASK_MARKER = /^([ \t]*[-*+] )\[([ xX])\](?=[ \t]|$)/gm;

const parseWidth = (raw: string | undefined) => (raw ? Number(raw) || null : null);

export function findMemoImageTokens(text: string): MemoImageToken[] {
  const out: MemoImageToken[] = [];
  for (const m of text.matchAll(IMAGE_TOKEN)) {
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      alt: m[1],
      id: m[2],
      width: parseWidth(m[3]),
    });
  }
  return out;
}

export function memoImageToken(id: string, width: number | null = null, alt = ""): string {
  return `![${alt}](memo-img/${id}.avif${width ? `#w=${width}` : ""})`;
}

/** 토큰 하나의 표시 폭만 바꾼 글자. 토큰이 아니면 받은 그대로 돌려준다. */
export function withMemoImageWidth(tokenText: string, width: number): string {
  const [token] = findMemoImageTokens(tokenText);
  if (!token || token.from !== 0 || token.to !== tokenText.length) return tokenText;
  return memoImageToken(token.id, Math.max(MEMO_IMAGE_MIN_WIDTH, Math.round(width)), token.alt);
}

/** 마크다운 렌더가 넘겨주는 `src`(= 토큰의 URL 부분)를 푼다. 메모 이미지가 아니면 null. */
export function parseMemoImageUrl(url: string): { id: string; width: number | null } | null {
  const m = IMAGE_URL_ONLY.exec(url);
  return m ? { id: m[1], width: parseWidth(m[2]) } : null;
}

export function findMemoTaskMarkers(text: string): MemoTaskMarker[] {
  const out: MemoTaskMarker[] = [];
  for (const m of text.matchAll(TASK_MARKER)) {
    const from = m.index + m[1].length;
    out.push({ from, to: from + 3, checked: m[2] !== " " });
  }
  return out;
}

// dev 전용 노출(E2E) — TS 단위 러너가 없어 e2e 가 합성 문자열로 부른다. release 미포함.
if (import.meta.env.DEV) {
  (window as unknown as { __gpvMemoTokens?: unknown }).__gpvMemoTokens = {
    findMemoImageTokens,
    memoImageToken,
    withMemoImageWidth,
    parseMemoImageUrl,
    findMemoTaskMarkers,
  };
}
