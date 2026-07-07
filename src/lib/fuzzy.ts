// 퍼지 매칭 — Quick Open(09)/심볼 검색(13) 공용 스코어러. 소문자 subsequence 매치 +
// 가중치(연속 보너스·경계 직후 보너스·시작 위치 감점). 의존성 0. 오타 허용(bitap)은 요구 아님.

export interface FuzzyHit {
  score: number;
  positions: number[]; // text 내 매치 문자 인덱스(하이라이트용)
}

const SEP = /[/\\_\-.]/; // 경로/식별자 경계 — 직후 문자 매치에 보너스

/** query가 text의 subsequence면 점수+매치 위치, 아니면 null. 빈 query는 score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  if (query === "") return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2; // 직전 매치 인덱스(연속 판정용)
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    positions.push(found);
    // 기본 매치 점수
    score += 1;
    // 연속 매치 보너스
    if (found === prevMatch + 1) score += 5;
    // 경계 직후(구분자 뒤 또는 문자열 시작) 보너스 — basename/세그먼트 시작 매치 우대
    if (found === 0 || SEP.test(text[found - 1])) score += 8;
    // camelCase 경계(소문자→대문자) 보너스
    else if (
      text[found] >= "A" &&
      text[found] <= "Z" &&
      text[found - 1] >= "a" &&
      text[found - 1] <= "z"
    )
      score += 6;
    prevMatch = found;
    ti = found + 1;
  }
  // 첫 매치가 늦을수록 감점(앞쪽 매치 선호)
  score -= positions[0] * 0.1;
  // basename(마지막 '/' 뒤) 안에서 매치가 시작되면 가중 — 파일명 매치 우선
  const slash = text.lastIndexOf("/");
  if (positions[0] > slash) score += 10;
  // 짧은 경로 타이브레이크(미세)
  score -= text.length * 0.01;
  return { score, positions };
}
