// 오디오 플레이리스트 인덱스 계산 — UI·IPC와 떼어 둔 순수 함수. TS 단위 테스트 러너가 없어 e2e 69가
// `__gpv.playlist`로 직접 단언한다(33 `planSegments` 선례). 목록은 폴더의 오디오 파일, 인덱스는 그 안의 순번이다.

export type RepeatMode = "off" | "all" | "one";

/** 반복 버튼·L 키의 순환 순서 — 끔 → 전체 → 한 곡. */
export const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };

/** 현재 곡이 아닌 무작위(곡이 하나뿐이면 그 곡). `cur < 0`(목록에 없음)이면 아무 곡이나. rnd는 [0, 1). */
function shuffleIndex(len: number, cur: number, rnd: () => number): number {
  if (cur < 0) return Math.min(len - 1, Math.floor(rnd() * len));
  if (len <= 1) return 0;
  const k = Math.min(len - 2, Math.floor(rnd() * (len - 1)));
  return k >= cur ? k + 1 : k;
}

/** 수동 다음(+1)·이전(-1) — 끝에서 감아 돈다. 목록이 비면 null. */
export function stepIndex(
  len: number,
  cur: number,
  dir: 1 | -1,
  shuffle: boolean,
  rnd: () => number = Math.random,
): number | null {
  if (len <= 0) return null;
  if (shuffle) return shuffleIndex(len, cur, rnd);
  if (cur < 0) return dir > 0 ? 0 : len - 1;
  return (cur + dir + len) % len;
}

/**
 * 곡이 끝났을 때(ended) 다음에 틀 곡. null = 정지, `cur`와 같으면 호출자가 처음부터 다시 튼다.
 * 한 곡 반복 → 같은 곡 · 전체 반복 → 다음(끝이면 처음) · 끔 → 다음(마지막이면 정지).
 */
// ponytail: 셔플은 반복 끔이어도 끝없이 이어진다 — 한 바퀴 뒤 멈추려면 재생 기록(셔플 순열)을 들고 있어야 한다.
export function endedIndex(
  len: number,
  cur: number,
  repeat: RepeatMode,
  shuffle: boolean,
  rnd: () => number = Math.random,
): number | null {
  if (len <= 0 || cur < 0) return null;
  if (repeat === "one") return cur;
  if (shuffle && len > 1) return shuffleIndex(len, cur, rnd);
  if (cur + 1 < len) return cur + 1;
  return repeat === "all" ? 0 : null;
}
